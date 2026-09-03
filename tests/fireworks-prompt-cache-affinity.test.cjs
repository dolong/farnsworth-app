'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const appSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');

const helperStart = mainSource.indexOf('function endpointSessionRouting');
const helperEnd = mainSource.indexOf('// Aug 7 2026:', helperStart);
assert(helperStart >= 0 && helperEnd > helperStart, 'endpoint routing helper block must exist');
const helperSource = mainSource.slice(helperStart, helperEnd);
const mainNames = [
  'endpointSessionRouting',
  'endpointSessionValue',
  'openAIRequestHeaders',
  'applyEndpointSessionRouting',
];
const mainHelpers = new Function(`${helperSource}\nreturn { ${mainNames.join(', ')} };`)();
const conversationId = 'conv-1787950189044-gaby07';

const fireworks = {
  baseURL: 'https://api.fireworks.ai/inference/v1',
  sessionRouting: { mode: 'fireworks', header: 'x-session-affinity', bodyField: '' },
};
const fwHeaders = mainHelpers.openAIRequestHeaders(fireworks, 'secret', conversationId, true);
assert.equal(fwHeaders['x-session-affinity'], conversationId);
assert.equal(fwHeaders.Accept, 'text/event-stream');
assert.equal(mainHelpers.applyEndpointSessionRouting({ model: 'kimi-k3' }, fireworks, conversationId).prompt_cache_key, undefined,
  'Fireworks uses x-session-affinity, not prompt_cache_key');

const futureProvider = {
  baseURL: 'https://future.example/v1',
  sessionRouting: { mode: 'custom', header: 'x-thread-key', bodyField: 'cache_partition' },
};
assert.equal(mainHelpers.openAIRequestHeaders(futureProvider, 'secret', conversationId)['x-thread-key'], conversationId);
assert.equal(mainHelpers.applyEndpointSessionRouting({}, futureProvider, conversationId).cache_partition, conversationId);

for (const endpoint of [{ baseURL: 'https://api.fireworks.ai/inference/v1' }, { sessionRouting: { mode: 'none' } }, null]) {
  const headers = mainHelpers.openAIRequestHeaders(endpoint, 'secret', conversationId);
  assert.equal(headers['x-session-affinity'], undefined, 'runtime routing must require endpoint configuration, not hostname inference');
  assert.deepEqual(mainHelpers.applyEndpointSessionRouting({}, endpoint, conversationId), {});
}
assert.equal(mainHelpers.endpointSessionValue(fireworks, '   '), null, 'blank conversation IDs must not be sent');
assert.deepEqual(mainHelpers.endpointSessionRouting({ sessionRouting: { header: 'bad header', bodyField: 'bad.field' } }), { header: '', bodyField: '' },
  'invalid request field names must be rejected');
assert.deepEqual(mainHelpers.endpointSessionRouting({ sessionRouting: { header: 'Authorization', bodyField: 'model' } }), { header: '', bodyField: '' },
  'custom affinity fields must not overwrite core request fields');

assert.match(appSource, /sessionAffinity: state\.chatActiveId \|\| null/);
assert.match(appSource, /sessionRouting: ep\.sessionRouting \|\| null/,
  'resolved endpoints must carry the configured capability to main');
assert.match(appSource, /if \(!ep\.sessionRouting && isFireworksBaseURL\(ep\.baseURL\)\)/,
  'existing Fireworks endpoints must receive a one-time migration');
assert.match(appSource, /Fireworks prompt cache affinity/);
assert.match(appSource, /Custom request fields/);
assert.match(appSource, /ci-card__capabilities/,
  'endpoint cards must summarize the inherited capability');
assert.match(appSource, /reservedHeaders = new Set/,
  'the endpoint editor must reject reserved request fields before saving');
assert.match(appSource, /inputCostPerMTok/,
  'the existing custom model pricing editor must remain present');
assert.equal((mainSource.match(/return applyEndpointSessionRouting\(b, ep, opts\.sessionAffinity\);/g) || []).length, 2,
  'blocking and streaming bodies must apply endpoint session routing');
assert.equal((mainSource.match(/headers: openAIRequestHeaders\(ep, key, opts\.sessionAffinity/g) || []).length, 2,
  'blocking and streaming headers must apply endpoint session routing, including retries');
assert.doesNotMatch(mainSource, /isFireworksEndpoint|applyFireworksPromptCache|prompt_cache_key/,
  'main-process requests must not contain provider-specific Fireworks routing code');

console.log('endpoint prompt-cache affinity: ok');
