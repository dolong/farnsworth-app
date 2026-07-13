#!/usr/bin/env node
// Verify Memory Tier 2 end-to-end via CDP.
import http from 'http';
import WebSocket from 'ws';

const TARGETS_URL = 'http://localhost:9222/json/list';

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function evaluate(ws, expression) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e9);
    const onMessage = (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id === id) {
        ws.off('message', onMessage);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify({
      id,
      method: 'Runtime.evaluate',
      params: { expression, returnByValue: true, awaitPromise: true },
    }));
  });
}

const targets = await fetchJson(TARGETS_URL);
const renderer = targets.find((t) => t.type === 'page' && t.url.startsWith('file://'));
if (!renderer) { console.error('no file:// renderer'); process.exit(1); }
console.log('renderer:', renderer.url);

const ws = new WebSocket(renderer.webSocketDebuggerUrl);
await new Promise((r) => ws.once('open', r));

const log = async (label, expr) => {
  const r = await evaluate(ws, expr);
  console.log(label + ':', r.result.value);
};

await log('T1 IPCs', `
  JSON.stringify({
    codeStats: typeof window.farnsworth?.memoryCodeStats,
    codeWatch: typeof window.farnsworth?.memoryCodeWatch,
    codeIndexFile: typeof window.farnsworth?.memoryCodeIndexFile,
    conceptEmbed: typeof window.farnsworth?.memoryConceptEmbed,
  })
`);

await log('T2 stats(null)', `window.farnsworth.memoryCodeStats(null).then(r => JSON.stringify(r))`);

await log('T3 stats(app)', `window.farnsworth.memoryCodeStats('/Users/long/Documents/Farnsworth/app').then(r => JSON.stringify(r))`);

await log('T4 watch(app)', `window.farnsworth.memoryCodeWatch('/Users/long/Documents/Farnsworth/app').then(r => JSON.stringify(r))`);

console.log('waiting 10s for chokidar to scan + index...');
await new Promise((r) => setTimeout(r, 10000));

await log('T5 stats after 10s', `window.farnsworth.memoryCodeStats('/Users/long/Documents/Farnsworth/app').then(r => JSON.stringify(r))`);

const recallRaw = await evaluate(ws, `window.farnsworth.memoryRecall('embed worker spawn chokidar', 8).then(r => JSON.stringify({ essentials_count: r.essentials.length, concepts_count: r.concepts.length, code_count: r.code.length, sample_code: r.code.slice(0, 2).map(c => ({ file: c.file_path, idx: c.chunk_index, dist: c.distance })) }))`);
console.log('T6 recall:', recallRaw.result.value);

await log('T7 unwatch', `window.farnsworth.memoryCodeUnwatch().then(r => JSON.stringify(r))`);

ws.close();
console.log('done');
