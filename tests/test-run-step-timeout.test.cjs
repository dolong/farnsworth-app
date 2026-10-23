// Oct 23 2026: a step whose CDP call never returns must not hang runTest,
// and a stop signal must end the run promptly.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const mod = () => import(path.join(__dirname, '..', 'src', 'farnsworth-test-runner.mjs'));

function fakeWc({ hangOn = () => false } = {}) {
  const calls = [];
  return {
    calls,
    debugger: {
      isAttached: () => true,
      sendCommand: (method, params) => {
        calls.push(method);
        if (method === 'Runtime.terminateExecution') return Promise.resolve({});
        if (hangOn(method, params)) return new Promise(() => {});
        return Promise.resolve({ result: { value: true } });
      },
    },
  };
}

test('a hung eval fails the step, stops the run and unsticks the page', async () => {
  const { runTest } = await mod();
  const wc = fakeWc({ hangOn: (m, p) => m === 'Runtime.evaluate' && /HANG/.test(p.expression) });
  const t0 = Date.now();
  const r = await runTest(wc, [
    { action: 'eval', expression: '1' },
    { action: 'eval', expression: 'HANG' },
    { action: 'eval', expression: '2' },
  ], { timeout: 1500 });
  const ms = Date.now() - t0;
  assert.ok(ms < 4000, `finished in ${ms}ms`);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.steps, 1);
  assert.match(r.errors[0], /Step 1 \(eval\): did not finish/);
  assert.strictEqual(r.errors.length, 1, 'later steps are skipped after a hang');
  assert.ok(wc.calls.includes('Runtime.terminateExecution'));
});

test('stop signal ends a hung run immediately', async () => {
  const { runTest } = await mod();
  const wc = fakeWc({ hangOn: () => true });
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 200);
  const t0 = Date.now();
  const r = await runTest(wc, [{ action: 'eval', expression: 'x' }, { action: 'eval', expression: 'y' }], { timeout: 60000, signal: ac.signal });
  assert.ok(Date.now() - t0 < 1500);
  assert.strictEqual(r.ok, false);
  assert.match(r.errors[0], /stopped/);
  assert.strictEqual(r.errors.length, 1);
});

test('healthy steps are unaffected', async () => {
  const { runTest } = await mod();
  const r = await runTest(fakeWc(), [
    { action: 'eval', expression: '1' },
    { action: 'sleep', ms: 50 },
    { action: 'waitFor', selector: '#x', timeout: 1000 },
  ]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.steps, 3);
});

test('step budget scales with the step\'s own wait', async () => {
  const { stepBudgetMs } = await mod();
  assert.strictEqual(stepBudgetMs({ action: 'eval' }), 20000);
  assert.strictEqual(stepBudgetMs({ action: 'waitFor', timeout: 30000 }), 45000);
  assert.strictEqual(stepBudgetMs({ action: 'sleep', ms: 40000 }), 55000);
  assert.strictEqual(stepBudgetMs({ action: 'while' }), Infinity);
});
