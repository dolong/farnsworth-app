// Usage: node shot.js [outfile.png]
const WebSocket = require('./node_modules/ws');
const fs = require('fs');
const out = process.argv[2] || '/tmp/farnsworth.png';
(async () => {
  const list = await (await fetch('http://localhost:9222/json')).json();
  const page = list.find(t => t.url && t.url.endsWith('index.html')) || list[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  const kill = setTimeout(() => { console.error('timeout'); process.exit(2); }, 10000);
  ws.on('open', () => ws.send(JSON.stringify({ id: 1, method: 'Page.captureScreenshot', params: { format: 'png' } })));
  ws.on('message', m => {
    const r = JSON.parse(m);
    if (r.id === 1) {
      if (r.result && r.result.data) { fs.writeFileSync(out, Buffer.from(r.result.data, 'base64')); console.log('saved', out); }
      else console.error('no data', JSON.stringify(r));
      clearTimeout(kill); ws.close(); process.exit(0);
    }
  });
  ws.on('error', e => { console.error('err', e.message); process.exit(1); });
})();
