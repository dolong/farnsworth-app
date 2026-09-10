// Regression tests for the OpenAI Responses API adapter (Sep 10 2026).
//
// The adapter's job is to be invisible: it must translate Anthropic-shaped
// messages/tools into the Responses wire format and re-emit Anthropic-shaped
// events, so the renderer, the chat-agent tool loop, and every other model
// implementation keep working unchanged. These tests exercise the pure
// converters for real (not just grep the source) plus assert the routing
// order, which is the one thing a future edit is most likely to break.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} exists`);
  const brace = source.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`Could not extract ${name}`);
}

function load(...names) {
  const src = names.map((n) => extractFunction(main, n)).join('\n');
  return new Function(`${src}\nreturn { ${names.join(', ')} };`)();
}

test('isResponsesModel claims the gpt-6 family and endpoint opt-ins only', () => {
  const { isResponsesModel } = load('isResponsesModel');
  assert.equal(isResponsesModel('gpt-6-astra'), true);
  assert.equal(isResponsesModel('gpt-6'), true);
  assert.equal(isResponsesModel('gpt-6.1-astra'), true);
  assert.equal(isResponsesModel('openai/gpt-6-astra'), true);
  // Everything already served by /v1/chat/completions must NOT be claimed,
  // or existing model implementations silently change transport.
  assert.equal(isResponsesModel('gpt-5.6-sol'), false);
  assert.equal(isResponsesModel('gpt-4o'), false);
  assert.equal(isResponsesModel('o3'), false);
  assert.equal(isResponsesModel('claude-opus-4-8'), false);
  assert.equal(isResponsesModel('accounts/fireworks/models/kimi-k3'), false);
  assert.equal(isResponsesModel(null), false);
  // Per-endpoint opt-in for a custom endpoint that only exposes /v1/responses.
  assert.equal(isResponsesModel('some-local-model', { api: 'responses' }), true);
  assert.equal(isResponsesModel('some-local-model', { api: 'chat' }), false);
});

test('reasoning effort is carried, not suppressed like the chat-completions path', () => {
  const { responsesReasoning } = load('responsesReasoning');
  // The reasoning_effort:'none' workaround exists only because
  // /v1/chat/completions cannot do tools + reasoning. Responses can.
  assert.deepEqual(responsesReasoning({}), { effort: 'medium' });
  assert.deepEqual(responsesReasoning({ reasoningEffort: 'high' }), { effort: 'high' });
  assert.deepEqual(responsesReasoning({ reasoningEffort: 'garbage' }), { effort: 'medium' });
  assert.equal(responsesReasoning({ reasoningEffort: 'none' }), null);
});

test('tools convert to the flat Responses shape', () => {
  const { toResponsesTools } = load('toResponsesTools');
  assert.equal(toResponsesTools([]), null);
  assert.equal(toResponsesTools(null), null);
  const out = toResponsesTools([{ name: 'read_file', description: 'reads', input_schema: { type: 'object', properties: { p: { type: 'string' } } } }]);
  assert.deepEqual(out, [{
    type: 'function',
    name: 'read_file',
    description: 'reads',
    parameters: { type: 'object', properties: { p: { type: 'string' } } },
  }]);
  // Nested `function: {}` is the chat-completions shape and is wrong here.
  assert.equal(out[0].function, undefined);
});

test('a full tool round trip converts to Responses input items', () => {
  const { toResponsesInput } = load('toResponsesInput');
  const out = toResponsesInput([
    { role: 'user', content: 'circle the mage' },
    { role: 'assistant', content: [
      { type: 'thinking', thinking: 'should not be echoed back' },
      { type: 'text', text: 'Looking.' },
      { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a.txt' } },
    ] },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'call_1', content: 'file body' },
      { type: 'text', text: 'and now?' },
    ] },
  ]);
  assert.deepEqual(out, [
    { role: 'user', content: [{ type: 'input_text', text: 'circle the mage' }] },
    { role: 'assistant', content: [{ type: 'output_text', text: 'Looking.' }] },
    { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a.txt"}' },
    { type: 'function_call_output', call_id: 'call_1', output: 'file body' },
    { role: 'user', content: [{ type: 'input_text', text: 'and now?' }] },
  ]);
});

test('images use input_image, and a blind model is TOLD it is blind', () => {
  const { toResponsesInput } = load('toResponsesInput');
  const shot = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } };

  const seeing = toResponsesInput([{ role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'call_1', content: [{ type: 'text', text: 'Screenshot: /tmp/x.png' }, shot] },
  ] }]);
  assert.equal(seeing[0].type, 'function_call_output');
  assert.match(seeing[0].output, /1 image attached in the following message/);
  // function_call_output.output is a string, so pixels ride in a user message.
  assert.deepEqual(seeing[1], { role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,AAAA' }] });

  const blind = toResponsesInput([{ role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'call_1', content: [{ type: 'text', text: 'Screenshot: /tmp/x.png' }, shot] },
  ] }], false);
  assert.equal(blind.length, 1, 'no image message for a text-only model');
  assert.match(blind[0].output, /THIS MODEL CANNOT RECEIVE IMAGES/);
  assert.doesNotMatch(blind[0].output, /base64/);

  // A direct user image is a plain input_image part.
  const direct = toResponsesInput([{ role: 'user', content: [shot] }]);
  assert.deepEqual(direct[0].content, [{ type: 'input_image', image_url: 'data:image/png;base64,AAAA' }]);
});

test('usage and stop reason map onto the shared renderer shape', () => {
  const { mapResponsesUsage, mapResponsesStatus } = load('mapResponsesUsage', 'mapResponsesStatus');
  assert.equal(mapResponsesUsage(null), null);
  assert.deepEqual(mapResponsesUsage({ input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 64 } }), {
    input_tokens: 100, output_tokens: 20, total_tokens: 120, cached_input_tokens: 64,
  });
  assert.deepEqual(mapResponsesUsage({ input_tokens: 5, output_tokens: 1, total_tokens: 6 }), {
    input_tokens: 5, output_tokens: 1, total_tokens: 6, cached_input_tokens: 0,
  });
  // Tool calls must win: the agent loop keys off 'tool_use' to keep going.
  assert.equal(mapResponsesStatus({ status: 'completed' }, true), 'tool_use');
  assert.equal(mapResponsesStatus({ status: 'completed' }, false), 'end_turn');
  assert.equal(mapResponsesStatus({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }, false), 'max_tokens');
  assert.equal(mapResponsesStatus(null, false), 'end_turn');
});

test('Responses routing sits ABOVE the chat-completions branch', () => {
  // isOpenAIModel() also matches gpt-6-*, so if these ever get reordered
  // Astra silently falls back to /v1/chat/completions and 400s on tools.
  for (const [route, legacy] of [
    ['responsesSend({ ...opts, model })', 'openAISend({ ...opts, model })'],
    ['responsesStream({ ...opts, model }', 'openAIStream({ ...opts, model }'],
  ]) {
    const a = main.indexOf(route);
    const b = main.indexOf(legacy);
    assert.notEqual(a, -1, `${route} is wired`);
    assert.notEqual(b, -1, `${legacy} still exists`);
    assert.ok(a < b, `${route} must be checked before ${legacy}`);
  }
  assert.ok(main.includes('if (isResponsesModel(model, opts.endpoint)) return await responsesSend'));
  assert.ok(main.includes('if (isResponsesModel(model, opts.endpoint)) {'));
});

test('the Responses path posts to /responses and keeps the shared learnings', () => {
  const send = extractFunction(main, 'responsesSend');
  const stream = extractFunction(main, 'responsesStream');
  for (const [name, src] of [['responsesSend', send], ['responsesStream', stream]]) {
    assert.match(src, /fetch\(`\$\{base\}\/responses`/, `${name} hits /v1/responses`);
    assert.match(src, /max_output_tokens/, `${name} uses max_output_tokens, not max_tokens`);
    assert.match(src, /b\.instructions = system/, `${name} sends the system prompt as instructions`);
    // The vision-rejection one-shot learning is shared with the OpenAI path.
    assert.match(src, /VISION_UNSUPPORTED\.add\(vkey\)/, `${name} learns text-only models`);
    assert.match(src, /isVisionRejection\(res\.status, parsed, errBody\)/, `${name} detects vision rejections`);
    assert.doesNotMatch(src, /reasoning_effort/, `${name} must not carry the chat-completions workaround`);
  }
  // Reasoning is surfaced but never folded into the answer text.
  assert.match(stream, /send\(\{ type: 'reasoning_delta', text: d \}\)/);
  assert.doesNotMatch(stream, /fullText \+= d;\s*\n\s*send\(\{ type: 'reasoning_delta'/);
  // Stop button parity with both other providers.
  assert.match(stream, /AbortError[\s\S]{0,200}type: 'cancelled'/);
});
