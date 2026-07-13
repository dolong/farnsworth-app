const WebSocket = require('ws');

async function fetchJson(url) {
  const res = await fetch(url);
  return await res.json();
}

async function main() {
  const targets = await fetchJson('http://localhost:9222/json');
  const tab = targets.find(t => t.type === 'page');
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });

  let id = 0;
  const pending = new Map();
  ws.on('message', m => {
    const r = JSON.parse(m);
    if (r.id && pending.has(r.id)) { pending.get(r.id)(r); pending.delete(r.id); }
  });
  const call = (method, params = {}) => new Promise(res => {
    const i = ++id;
    pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });

  // Wait for Monaco to mount (poll up to 10s)
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 500));
    const r = await call('Runtime.evaluate', { expression: 'JSON.stringify({monaco: !!window.monacoEditor, model: window.monacoEditor && window.monacoEditor.getModel ? window.monacoEditor.getModel().uri.path : null, cursor: window.monacoEditor && window.monacoEditor.getPosition ? window.monacoEditor.getPosition().lineNumber : null})' });
    const v = r.result?.result?.value;
    console.log(`tick ${i}: ${v}`);
    if (v && v.includes('"monaco":true') && v.includes('"model":')) break;
  }

  const shot = await call('Page.captureScreenshot', { format: 'png' });
  require('fs').writeFileSync('/tmp/monaco_loaded.png', Buffer.from(shot.result.data, 'base64'));

  ws.close();
}

main().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
