'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const appSource = fs.readFileSync(path.join(root, 'src', 'app.js'), 'utf8');
const cssSource = fs.readFileSync(path.join(root, 'src', 'styles.css'), 'utf8');

const helperStart = appSource.indexOf('function normalizeCustomModelPrice');
const helperEnd = appSource.indexOf('function formatUSD', helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart, 'pricing helpers must be present');
const helperSource = appSource.slice(helperStart, helperEnd);
const context = {
  state: { settings: { customEndpoints: [{
    models: [
      { apiId: 'accounts/fireworks/models/kimi-k3', display: 'Kimi K3', inputCostPerMTok: 0.5, outputCostPerMTok: 2.5 },
      { apiId: 'local/free', display: 'Local Free', inputCostPerMTok: 0, outputCostPerMTok: 0 },
      { apiId: 'custom/unpriced', display: 'Unpriced' },
      { apiId: 'custom/collision', display: 'Built In' },
    ],
  }] } },
  MODEL_PRICING_PER_MTOK: { 'Built In': { input: 3, output: 15 }, 'Built In Only': { input: 3, output: 15 } },
};
vm.createContext(context);
vm.runInContext(`${helperSource}
this.pricing = { normalizeCustomModelPrice, modelPricingFor, estimateCostUSD };`, context);

assert.deepEqual({ ...context.pricing.modelPricingFor('Kimi K3') }, { input: 0.5, output: 2.5 });
assert.equal(context.pricing.estimateCostUSD('Kimi K3', 2_000_000, 1_000_000), 3.5);
assert.deepEqual({ ...context.pricing.modelPricingFor('Local Free') }, { input: 0, output: 0 }, 'zero-priced local models must remain priced');
assert.equal(context.pricing.estimateCostUSD('Local Free', 999, 999), 0);
assert.equal(context.pricing.modelPricingFor('Unpriced'), null, 'legacy model records without prices remain valid and unpriced');
assert.equal(context.pricing.modelPricingFor('Built In'), null, 'an unpriced custom model must not inherit a same-name built-in price');
assert.deepEqual({ ...context.pricing.modelPricingFor('Built In Only') }, { input: 3, output: 15 }, 'built-in pricing remains the fallback when no custom model matches');
assert.equal(context.pricing.normalizeCustomModelPrice(-1), null);
assert.equal(context.pricing.normalizeCustomModelPrice('nope'), null);

assert.match(appSource, /class="apikey-input ci-model-input-cost"/);
assert.match(appSource, /class="apikey-input ci-model-output-cost"/);
assert.match(appSource, /model\.inputCostPerMTok = inputCostPerMTok/);
assert.match(appSource, /model\.outputCostPerMTok = outputCostPerMTok/);
assert.match(appSource, /Configure custom model rates in Settings → AI → Custom inference/);
assert.match(cssSource, /\.ci-model-grid-head, \.ci-model-row/);
assert.match(appSource, /const record = \{ id, name, baseURL: url, keyRef, models, sessionRouting \};/,
  'custom endpoint records must preserve pricing models and endpoint-level session routing');

console.log('custom model pricing regression: OK');
