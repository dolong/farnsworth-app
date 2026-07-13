// Farnsworth Relay Client — outbound WS to farnsworth-relay (CommonJS)
// ============================================================================
// Opens a persistent WebSocket connection from the Farnsworth main process
// to a farnsworth-relay instance. Routes:
//   - outgoing chat (from renderer chat composer → relay → companions)
//   - incoming chat (from companion → relay → renderer chat composer)
//   - canvas state (future)
// Auth: HS256 JWT signed with RELAY_JWT_SECRET. Sub includes a stable
// machine id so the relay can replace the old connection on restart.
//
// Env / config:
//   RELAY_URL          (default: ws://localhost:7778/api/v1/ws)
//   RELAY_JWT_SECRET   (default: dev-secret)  -- shared with relay
//   RELAY_TENANT_ID    (default: 'default')
//   RELAY_DISABLED     (default: unset)       -- set to '1' to skip
// ============================================================================

const { WebSocket } = require('ws');
const os = require('node:os');
const crypto = require('node:crypto');

// ----- Minimal HS256 JWT (no jsonwebtoken dep) -----
function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function signJwt(payload, secret) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const claims = { iat: now, exp: now + 3600, ...payload };
  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify(claims));
  const sig = b64url(crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest());
  return `${h}.${p}.${sig}`;
}

const RELAY_URL = process.env.RELAY_URL || 'ws://localhost:7778/api/v1/ws';
const RELAY_JWT_SECRET = process.env.RELAY_JWT_SECRET || 'dev-secret';
const RELAY_TENANT_ID = process.env.RELAY_TENANT_ID || 'default';
const MACHINE_ID_HASH = crypto
  .createHash('sha256')
  .update(os.hostname() + (os.userInfo()?.username || ''))
  .digest('hex')
  .slice(0, 8);
const SUB = `farnsworth:${os.hostname()}-${MACHINE_ID_HASH}`;

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

class RelayClient {
  constructor(opts = {}) {
    this.url = opts.url || RELAY_URL;
    this.secret = opts.secret || RELAY_JWT_SECRET;
    this.tenantId = opts.tenantId || RELAY_TENANT_ID;
    this.sub = opts.sub || SUB;
    this.ws = null;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.stopped = false;
    this.handlers = new Map(); // type → [fn]
    this.statusListeners = new Set();
    this._status = 'idle'; // idle | connecting | connected | disconnected
  }

  token() {
    return signJwt(
      { sub: this.sub, role: 'farnsworth', tenantId: this.tenantId },
      this.secret
    );
  }

  start() {
    if (process.env.RELAY_DISABLED === '1') {
      console.log('[relay-client] RELAY_DISABLED=1, skipping');
      return;
    }
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close(1000, 'client stop');
      this.ws = null;
    }
    this._setStatus('disconnected');
  }

  connect() {
    if (this.stopped) return;
    this._setStatus('connecting');
    const url = `${this.url}?token=${this.token()}`;
    console.log(`[relay-client] connecting to ${this.url} (tenant=${this.tenantId})`);

    let ws;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      console.error('[relay-client] failed to create WebSocket:', e.message);
      this._scheduleReconnect();
      return;
    }

    this.ws = ws;

    ws.on('open', () => {
      console.log(`[relay-client] connected as sub=${this.sub}`);
      this.reconnectAttempt = 0;
      this._setStatus('connected');
    });

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        console.warn('[relay-client] received invalid JSON');
        return;
      }
      this._dispatch(msg);
    });

    ws.on('close', (code, reason) => {
      console.log(`[relay-client] disconnected (code=${code} reason=${reason || ''})`);
      this.ws = null;
      this._setStatus('disconnected');
      this._scheduleReconnect();
    });

    ws.on('error', (err) => {
      console.warn(`[relay-client] ws error: ${err.message}`);
      // 'close' fires after, which handles reconnect
    });
  }

  _scheduleReconnect() {
    if (this.stopped) return;
    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempt),
      RECONNECT_MAX_MS
    );
    this.reconnectAttempt++;
    console.log(`[relay-client] reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})`);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  _setStatus(status) {
    if (this._status === status) return;
    this._status = status;
    for (const fn of this.statusListeners) {
      try { fn(status); } catch (e) { console.warn('[relay-client] status listener error:', e.message); }
    }
  }

  _dispatch(msg) {
    const handlers = this.handlers.get(msg.type) || [];
    const wildcard = this.handlers.get('*') || [];
    for (const fn of [...handlers, ...wildcard]) {
      try { fn(msg); } catch (e) { console.warn('[relay-client] handler error:', e.message); }
    }
  }

  // Public API --------------------------------------------------------------

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(fn);
    return () => {
      const arr = this.handlers.get(type) || [];
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    };
  }

  onStatus(fn) {
    this.statusListeners.add(fn);
    fn(this._status);
    return () => this.statusListeners.delete(fn);
  }

  get status() { return this._status; }

  send(msg) {
    if (!this.ws || this.ws.readyState !== 1) {
      console.warn('[relay-client] send dropped: not connected');
      return false;
    }
    this.ws.send(JSON.stringify(msg));
    return true;
  }
}

// Singleton for main.js
let singleton = null;
function getRelayClient() {
  if (!singleton) singleton = new RelayClient();
  return singleton;
}

module.exports = { RelayClient, getRelayClient };