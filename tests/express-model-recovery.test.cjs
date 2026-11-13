'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');

function extractFunction(name) {
  const start = src.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} exists`);
  const asyncStart = src.indexOf(`async function ${name}(`);
  const actualStart = name === 'runExpressOffer' ? asyncStart : start;
  const brace = src.indexOf('{', actualStart);
  let depth = 0;
  for (let i = brace; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(actualStart, i + 1);
    }
  }
  throw new Error(`Could not extract ${name}`);
}

test('only transient provider failures qualify for the Kimi K3.1 recovery', () => {
  const factory = new Function(`${extractFunction('isTransientExpressModelError')}; return isTransientExpressModelError;`);
  const matches = factory();
  assert.equal(matches('Error: 503 credential validation failed'), true);
  assert.equal(matches('HTTP 429 rate limited'), true);
  assert.equal(matches('fetch failed'), true);
  assert.equal(matches('Error: 400 thinking blocks cannot be modified'), false);
  assert.equal(matches('Error: 401 invalid api key'), false);
});

test('a delegated Anthropic outage resumes the same conversation on Kimi K3.1', async () => {
  const state = { settings: { defaultModel: 'Opus 5.5' }, chatMessages: [], chatGeneratedTitles: {}, memoryInjectedSlugs: new Set() };
  const persisted = { id: 'express-xt-1', messages: [] };
  const sends = [];
  const completions = [];
  const api = {
    async expressAgentAccept() { return { ok: true, task: { id: 'xt-1', title: 'Fix it', text: 'investigate and fix', folder: null } }; },
    async setActiveWorkspace() {},
    async chatConvCreate() { return { id: 'express-xt-1' }; },
    async chatConvLoad() { return persisted; },
    async expressAgentStarted() {},
    async expressAgentProgress() {},
    async expressAgentComplete(payload) { completions.push(payload); },
  };
  const window = { farnsworth: api };
  async function sendChatMessage({ text }) {
    sends.push({ text, conversationId: state.chatActiveId, model: state.settings.defaultModel });
    const ok = sends.length === 2;
    persisted.messages = [...persisted.messages,
      { role: 'user', text },
      { role: 'agent', text: ok ? 'Fixed on the backup model.' : 'Error: 503 credential validation failed', error: !ok, working: false },
    ];
  }
  const factory = new Function('state', 'window', 'sendChatMessage', 'saveActiveConversation', 'expressUsageFrom',
    `const EXPRESS_OUTAGE_MODEL = 'Kimi K3.1 Pro (OpenRouter)';\n${extractFunction('isTransientExpressModelError')}\n${extractFunction('expressOutagePrompt')}\n${extractFunction('runExpressOffer')}\nreturn runExpressOffer;`);
  const run = factory(state, window, sendChatMessage, async () => {}, () => null);
  await run({ id: 'offer-1' });
  assert.equal(sends.length, 2);
  assert.equal(sends[0].model, 'Opus 5.5');
  assert.equal(sends[1].model, 'Kimi K3.1 Pro (OpenRouter)');
  assert.equal(sends[0].conversationId, 'express-xt-1');
  assert.equal(sends[1].conversationId, 'express-xt-1', 'the backup resumes the same conversation');
  assert.match(sends[1].text, /existing conversation and tool history/);
  assert.doesNotMatch(sends[1].text, /investigate and fix/);
  assert.equal(completions.at(-1).status, 'succeeded');
  assert.equal(completions.at(-1).model, 'Kimi K3.1 Pro (OpenRouter)');
  assert.equal(state.settings.defaultModel, 'Opus 5.5', 'the previous default is restored');
});
