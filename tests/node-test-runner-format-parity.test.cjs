#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const runnerUrl = pathToFileURL(path.resolve(__dirname, '..', 'src', 'farnsworth-test-runner.mjs')).href;

async function loadRunner() {
  return import(runnerUrl + `?t=${Date.now()}-${Math.random()}`);
}

function mockWebContents(handler) {
  const calls = [];
  return {
    calls,
    debugger: {
      isAttached: () => true,
      sendCommand: async (method, params = {}) => {
        calls.push({ method, params });
        return handler(method, params, calls);
      },
    },
  };
}

test('type uses the documented text field', async () => {
  const mod = await loadRunner();
  const wc = mockWebContents((method) => method === 'Runtime.evaluate' ? { result: { value: true } } : {});
  const result = await mod.runTest(wc, [{ action: 'type', selector: '#name', text: 'court' }]);
  assert.equal(result.ok, true);
  const insert = wc.calls.find((c) => c.method === 'Input.insertText');
  assert.deepEqual(insert.params, { text: 'court' });
});

test('text= click resolves rendered text before dispatching mouse input', async () => {
  const mod = await loadRunner();
  const wc = mockWebContents((method, params) => {
    if (method === 'Runtime.evaluate') {
      assert.match(params.expression, /PLAY WITHOUT SOUND/);
      assert.match(params.expression, /textContent/);
      return { result: { value: { x: 10, y: 20, width: 100, height: 40 } } };
    }
    return {};
  });
  const result = await mod.runTest(wc, [{ action: 'click', selector: 'text=PLAY WITHOUT SOUND' }]);
  assert.equal(result.ok, true);
  const downs = wc.calls.filter((c) => c.method === 'Input.dispatchMouseEvent');
  assert.equal(downs.length, 2);
  assert.equal(downs[0].params.x, 60);
  assert.equal(downs[0].params.y, 40);
});

test('text= wait checks visible body text rather than treating it as CSS', async () => {
  const mod = await loadRunner();
  const wc = mockWebContents((method, params) => {
    if (method === 'Runtime.evaluate') {
      assert.match(params.expression, /document\.body\.innerText/);
      assert.match(params.expression, /PLAY WITHOUT SOUND/);
      return { result: { value: true } };
    }
    return {};
  });
  const result = await mod.runTest(wc, [{ action: 'waitFor', selector: 'text=PLAY WITHOUT SOUND', timeout: 50 }]);
  assert.equal(result.ok, true);
});
