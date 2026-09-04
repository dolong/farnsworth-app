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
  assert.match(main, /https:\/\/developers\.openai\.com\/api\/docs\/models\.md/);
  assert.match(main, /https:\/\/developers\.openai\.com\/api\/docs\/guides\/latest-model\.md/);
  assert.match(main, /ipcMain\.handle\('models:listAvailable'/);
  assert.match(preload, /listAvailableModels: \(provider\) => ipcRenderer\.invoke\('models:listAvailable', provider\)/);
  assert.doesNotMatch(app, /db\.getAuthToken|Authorization: `Bearer \${key}`|x-api-key.*accessToken/);
});

test('GPT-6 Astra stays visible but gated until the Responses API tool loop exists', () => {
  assert.ok(main.includes('^gpt-6-astra'));
  assert.ok(main.includes('Tool calling requires the OpenAI Responses API'));
  assert.ok(main.includes('Needs compatibility validation with the current Chat Completions agent adapter'));
  assert.ok(main.includes('function collapseOpenAIModelSnapshots(models)'));
  assert.ok(main.includes('function parseOpenAIDocumentedModels(catalogMarkdown, latestMarkdown)'));
  assert.ok(main.includes('latestModelInfo:'));
  assert.ok(app.includes('ROLLING OUT'));
  assert.ok(app.includes('DOCUMENTED'));
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

test('official OpenAI Markdown discovers the featured and latest model IDs', () => {
  const relevantSource = extractFunction(main, 'relevantOpenAIModelId');
  const parserSource = extractFunction(main, 'parseOpenAIDocumentedModels');
  const parse = new Function(`${relevantSource}\n${parserSource}\nreturn parseOpenAIDocumentedModels;`)();
  const catalog = `# Models\n\n## Featured models\n\n- [GPT-6 Astra](/api/docs/models/gpt-6-astra.md): Hardest end-to-end work\n- [GPT-5.6 Terra](/api/docs/models/gpt-5.6-terra.md): Balanced intelligence and cost\n\n## Browse our full catalog of models\n\n- [GPT-Image-2](/api/docs/models/gpt-image-2.md): Images`;
  const latest = `---\nlatestModelInfo:\n  model: gpt-6-astra\n---\n`;
  assert.deepEqual(parse(catalog, latest), [
    { apiId: 'gpt-6-astra', display: 'GPT-6 Astra', docsDescription: 'Hardest end-to-end work', documented: true, latestDocumented: true },
    { apiId: 'gpt-5.6-terra', display: 'GPT-5.6 Terra', docsDescription: 'Balanced intelligence and cost', documented: true, latestDocumented: false },
  ]);
});
