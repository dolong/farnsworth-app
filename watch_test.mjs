// watch_test.mjs — minimal CDP test to invoke memory:code-watch
import http from 'http';
import WebSocket from 'ws';

const targets = await new Promise((resolve, reject) => {
  http.get('http://localhost:9222/json/list', (res) => {
    let d = '';
    res.on('data', (c) => d += c);
    res.on('end', () => resolve(JSON.parse(d)));
  }).on('error', reject);
});
const renderer = targets.find(t => t.type === 'page' && t.url.startsWith('file://'));
console.log('renderer:', renderer.url);
const ws = new WebSocket(renderer.webSocketDebuggerUrl);
await new Promise(r => ws.once('open', r));
console.log('connected');

const id = 12345;
const result = await new Promise((resolve) => {
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.id === id) resolve(msg.result);
  });
  ws.send(JSON.stringify({
    id,
    method: 'Runtime.evaluate',
    params: {
      expression: `window.farnsworth.memoryCodeWatch('/Users/long/Documents/Farnsworth/app').then(r => JSON.stringify({ ok: r?.ok, watching: r?.watching, err: r?.error }))`,
      returnByValue: true,
      awaitPromise: true,
    },
  }));
});
console.log('watch result:', result.result.value);
ws.close();
process.exit(0);