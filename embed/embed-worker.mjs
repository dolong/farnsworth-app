// embed-worker.mjs — runs in a separate Node process, communicates via JSON-lines.
// Embeds text batches using @huggingface/transformers (Xenova MiniLM L6 v2).
process.title = 'farnsworth-embed-worker';
import { pipeline, env } from '@huggingface/transformers';

const model = process.argv[2] || 'Xenova/all-MiniLM-L6-v2';
const cacheDir = process.argv[3] || null;
if (cacheDir && env) env.cacheDir = cacheDir;

let extractor;
try {
  extractor = await pipeline('feature-extraction', model, { dtype: 'fp32' });
  process.stdout.write(JSON.stringify({ type: 'ready', model }) + '\n');
} catch (err) {
  process.stdout.write(JSON.stringify({ type: 'error', error: err.message || String(err) }) + '\n');
  process.exit(1);
}

// Sequential request queue — single ONNX session, no concurrent inference.
const decoder = new TextDecoder();
let buffer = '';
let processing = false;
const queue = [];

process.stdin.on('data', (chunk) => {
  buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
  let idx;
  while ((idx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (line.trim()) queue.push(line);
  }
  if (!processing) processQueue();
});

async function processQueue() {
  processing = true;
  while (queue.length > 0) {
    const line = queue.shift();
    let req;
    try { req = JSON.parse(line); } catch { continue; }
    try {
      const texts = Array.isArray(req.texts) ? req.texts : [req.texts];
      const output = await extractor(texts, { pooling: 'cls', normalize: true });
      const vectors = output.tolist();
      process.stdout.write(JSON.stringify({ id: req.id, vectors, dim: vectors[0]?.length }) + '\n');
    } catch (err) {
      process.stdout.write(JSON.stringify({ id: req.id, error: err.message || String(err) }) + '\n');
    }
  }
  processing = false;
}

process.stdin.on('end', () => process.exit(0));
