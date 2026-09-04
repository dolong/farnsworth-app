const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'src/app.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');

test('provider catalog is account-specific and keeps secrets in main', () => {
  assert.match(main, /https:\/\/api\.anthropic\.com\/v1\/models\?limit=1000/);
  assert.match(main, /https:\/\/api\.openai\.com\/v1\/models/);
  assert.match(main, /ipcMain\.handle\('models:listAvailable'/);
  assert.match(preload, /listAvailableModels: \(provider\) => ipcRenderer\.invoke\('models:listAvailable', provider\)/);
  assert.doesNotMatch(app, /db\.getAuthToken|Authorization: `Bearer \${key}`|x-api-key.*accessToken/);
});

test('GPT-6 Astra stays visible but gated until the Responses API tool loop exists', () => {
  assert.ok(main.includes('^gpt-6-astra'));
  assert.ok(main.includes('Tool calling requires the OpenAI Responses API'));
  assert.ok(main.includes('Needs compatibility validation with the current Chat Completions agent adapter'));
  assert.ok(main.includes('function collapseOpenAIModelSnapshots(models)'));
  assert.ok(app.includes('GPT-6 Astra'));
  assert.ok(app.includes('Needs adapter support'));
});

test('enabled provider models drive app pickers and persist add-remove choices', () => {
  assert.match(app, /providerModels: \[\]/);
  assert.match(app, /function getBuiltInModelOptions\(\)/);
  assert.match(app, /function renderProviderModelCatalog\(wrap\)/);
  assert.match(app, /catalogApiId: incoming\.apiId/);
  assert.match(app, /function setProviderModelEnabled\(row, enabled\)/);
  assert.match(app, /sendModelsListToCompanions\(\)/);
  assert.match(main, /stored Anthropic credential could not be read/);
  assert.match(main, /stored OpenAI credential could not be read/);
  assert.match(app, /settingsKey === 'testingModel'[\s\S]*provider === 'anthropic'/);
  assert.match(app, /At least one Anthropic model must stay enabled for testing and memory/);
});
