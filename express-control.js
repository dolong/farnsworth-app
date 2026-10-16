'use strict';
// express-control.js — the in-process control MCP server each desktop app runs
// for the Express hub. IDENTICAL copy in Farnsworth, Citadel and Philo; each app
// passes its own tool table. Source of truth: dolong/express hub/lib/.
//
// Transport: MCP JSON-RPC 2.0 over HTTP POST /mcp on 127.0.0.1 (random port),
// bearer token. Server-pushed events (chat stream, task progress) go out on
// GET /events as Server-Sent Events. Discovery: writes
// ~/.express/apps/<app>.json {app, port, token, pid, version, startedAt}
// (mode 0600) and removes it on stop. CommonJS + node builtins only so it
// loads in Electron main without a build step.

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const PROTOCOL_VERSION = '2025-06-18';
const DIR = process.env.EXPRESS_HOME || path.join(os.homedir(), '.express');
const MAX_BODY = 8 * 1024 * 1024;

function createControlServer({ app, version = '0.0.0', tools = {}, log = console } = {}) {
  if (!app) throw new Error('express-control: app is required');
  const token = crypto.randomBytes(24).toString('hex');
  const file = path.join(DIR, 'apps', `${app}.json`);
  const sseClients = new Set();
  let server = null;
  let port = null;

  function toolList() {
    return Object.entries(tools).map(([name, t]) => ({
      name,
      description: t.description || '',
      inputSchema: t.inputSchema || { type: 'object', properties: {} },
      ...(t.annotations ? { annotations: t.annotations } : {}),
    }));
  }

  async function callTool(name, args) {
    const t = tools[name];
    if (!t) return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
    try {
      const result = await t.handler(args || {}, { emit });
      // Always plain JSON: Electron objects must never leak across (see
      // electron-ipc-structured-clone). Round-trip strips functions/classes.
      const plain = result === undefined ? null : JSON.parse(JSON.stringify(result));
      return { content: [{ type: 'text', text: JSON.stringify(plain) }], structuredContent: wrap(plain) };
    } catch (e) {
      const err = { error: e?.code || 'tool_failed', message: String(e?.message || e) };
      if (e?.details) err.details = e.details;
      return { isError: true, content: [{ type: 'text', text: JSON.stringify(err) }], structuredContent: err };
    }
  }

  // structuredContent must be an object.
  function wrap(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : { result: v }; }

  async function handleRpc(msg) {
    const { id, method, params } = msg || {};
    const reply = (result) => ({ jsonrpc: '2.0', id, result });
    const fail = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
    switch (method) {
      case 'initialize':
        return reply({
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: `${app}-control`, version },
        });
      case 'notifications/initialized':
        return null;
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: toolList() });
      case 'tools/call':
        return reply(await callTool(params?.name, params?.arguments));
      default:
        return id === undefined ? null : fail(-32601, `Method not found: ${method}`);
    }
  }

  function authorized(req) {
    const h = req.headers.authorization || '';
    const given = Buffer.from(h.replace(/^Bearer\s+/i, ''));
    const want = Buffer.from(token);
    return given.length === want.length && crypto.timingSafeEqual(given, want);
  }

  function onRequest(req, res) {
    // Local only, and never from a browser page (no CORS, reject Origin).
    if (req.headers.origin) { res.writeHead(403).end(); return; }
    if (!authorized(req)) { res.writeHead(401).end(); return; }
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(`event: hello\ndata: ${JSON.stringify({ app, version })}\n\n`);
      sseClients.add(res);
      const ka = setInterval(() => res.write(': ka\n\n'), 15000);
      req.on('close', () => { clearInterval(ka); sseClients.delete(res); });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/mcp') {
      let size = 0; const chunks = [];
      req.on('data', (c) => { size += c.length; if (size > MAX_BODY) req.destroy(); else chunks.push(c); });
      req.on('end', async () => {
        let msg;
        try { msg = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })); return; }
        const batch = Array.isArray(msg);
        const out = (await Promise.all((batch ? msg : [msg]).map(handleRpc))).filter(Boolean);
        if (!out.length) { res.writeHead(202).end(); return; }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(batch ? out : out[0]));
      });
      return;
    }
    res.writeHead(404).end();
  }

  function emit(topic, data) {
    const frame = `event: message\ndata: ${JSON.stringify({ topic, data, ts: Date.now() })}\n\n`;
    for (const res of sseClients) { try { res.write(frame); } catch {} }
  }

  function writeDiscovery() {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ app, port, token, pid: process.pid, version, startedAt: Date.now() }), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  function removeDiscovery() {
    try {
      const cur = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (cur.pid === process.pid) fs.unlinkSync(file);
    } catch {}
  }

  return {
    get port() { return port; },
    emit,
    addTools(more) { Object.assign(tools, more); },
    start() {
      return new Promise((resolve, reject) => {
        server = http.createServer(onRequest);
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
          port = server.address().port;
          writeDiscovery();
          log.log?.(`[express-control] ${app} listening on 127.0.0.1:${port}`);
          resolve(port);
        });
      });
    },
    stop() {
      removeDiscovery();
      for (const res of sseClients) { try { res.end(); } catch {} }
      sseClients.clear();
      return new Promise((r) => (server ? server.close(() => r()) : r()));
    },
    _handleRpc: handleRpc,
  };
}

// Error helper for tool handlers: throw toolError('out_of_stock', 'msg', {...}).
function toolError(code, message, details) {
  const e = new Error(message); e.code = code; if (details) e.details = details; return e;
}

module.exports = { createControlServer, toolError, PROTOCOL_VERSION };
