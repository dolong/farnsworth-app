// Sep 8 2026: regression tests for the Session token usage modal, ported from
// Citadel v0.2.43 + v0.2.47 after Long asked whether the cost estimates in
// Farnsworth were wrong the same way Citadel's were.
//
// They were, and worse: Farnsworth never had cumulative accounting at all, so
// the usage chip was emitted ONLY on the final tool-free round. A turn that
// made 100 tool calls recorded one round's tokens, and the modal reported a
// total ~50x too low under a disclaimer claiming cost "can run high". A turn
// that died mid-loop or was stopped recorded nothing, even though every
// completed round was billed.
//
// Two halves are tested here:
//   1. accounting -- turnUsage accumulates every round and is emitted on all
//      exit paths (success, stream throw, not-ok result, user Stop).
//   2. honesty -- legacy chips are detected arithmetically and shown as
//      floors, since a turn's usage must cover every round it made and the
//      system prompt plus ~29 tool definitions bill far more than the floor
//      on every single round.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
const cssSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8');

// Extract the pure aggregation logic and run it against a `state` shim.
function loadComputeSessionUsage(chatMessages) {
  const constAt = appSrc.indexOf('const USAGE_MIN_TOKENS_PER_ROUND');
  assert.ok(constAt > -1, 'per-round floor constant exists');
  const endAt = appSrc.indexOf('function normalizeCustomModelPrice');
  assert.ok(endAt > constAt, 'aggregator block located');
  const seg = appSrc.slice(constAt, endAt);
  const factory = new Function('state', `${seg}; return { computeSessionUsage, usageUnderReported, USAGE_MIN_TOKENS_PER_ROUND };`);
  return factory({ chatMessages });
}

// A tool-heavy agent turn: N tool chips (each carrying a `name`) plus one
// usage chip on the agent message.
function toolTurn({ toolCalls, input, output, cached = 0, model = 'Kimi K3' }) {
  const chips = [];
  for (let i = 0; i < toolCalls; i++) chips.push({ kind: i % 3 === 0 ? 'terminal' : 'edit', name: `tool_${i}`, label: `tool_${i}()` });
  chips.push({ kind: 'read', label: `${input.toLocaleString()}→${output.toLocaleString()} tok${cached ? ` (${cached.toLocaleString()} cached)` : ''}` });
  return [{ role: 'user', text: 'do the work' }, { role: 'agent', model, chips }];
}

// ---------------------------------------------------------------- accounting

test('every billed round is accumulated, not just the final one', () => {
  const at = appSrc.indexOf('const turnUsage = { input: 0, output: 0, cached: 0, rounds: 0 };');
  assert.ok(at > -1, 'turn-level usage accumulator exists');
  const seg = appSrc.slice(at, at + 1200);
  assert.ok(seg.includes('turnUsage.input += u.input_tokens || 0'), 'input accumulates across rounds');
  assert.ok(seg.includes('turnUsage.output += u.output_tokens || 0'), 'output accumulates across rounds');
  assert.ok(seg.includes('u.cached_input_tokens || u.cache_read_input_tokens'), 'provider cached-token counts pass through');
  assert.ok(seg.includes('turnUsage.rounds += 1'), 'round count tracked');
  // Two call sites: the mid-loop round and the final answer round.
  const calls = appSrc.split('addRoundUsage(res.usage)').length - 1;
  assert.equal(calls, 2, 'usage recorded for both mid-loop rounds and the final round');
});

test('the chip carries the turn total on every exit path', () => {
  // Success path: the final chip is the turn total, NOT this round's usage.
  assert.ok(appSrc.includes('const usageChip = turnUsageChip();'), 'success path emits the cumulative chip');
  assert.ok(!/const usageChip = res\.usage \? \{ label: `\$\{res\.usage\.input_tokens\}/.test(appSrc.slice(appSrc.indexOf('No tool_use blocks'))),
    'the old last-round-only chip is gone from the tool loop');
  // Failure paths: a turn that died still burned its completed rounds.
  const spread = appSrc.split('...(turnUsageChip() ? [turnUsageChip()] : [])').length - 1;
  assert.equal(spread, 2, 'both the stream-throw and not-ok error paths append usage');
  // Stop path.
  assert.ok(appSrc.includes('const spentChip = turnUsageChip();'), 'stopped turns record what they spent');
  assert.ok(appSrc.includes("stopped: true, ...(spentChip ? { chips: [...(agentMsg.chips || []), spentChip] } : {})"), 'stop path appends the chip');
});

test('the cumulative chip renders bare or with a cached suffix', () => {
  const at = appSrc.indexOf('const turnUsageChip = () => {');
  assert.ok(at > -1, 'chip builder exists');
  // Bound the slice to the builder itself; following code contains a try block.
  const end = appSrc.indexOf('\n  };', at);
  assert.ok(end > at, 'chip builder end located');
  const seg = appSrc.slice(at, end + 5);
  const factory = new Function(`
    let turnUsage = { input: 0, output: 0, cached: 0, rounds: 0 };
    ${seg}
    return (u) => { turnUsage = u; return turnUsageChip(); };
  `);
  const chip = factory();
  assert.equal(chip({ input: 0, output: 0, cached: 0, rounds: 0 }), null, 'no rounds means no chip');
  assert.deepEqual(chip({ input: 3412477, output: 9231, cached: 0, rounds: 90 }),
    { label: '3412477→9231 tok', kind: 'read' }, 'bare label when no cache reported');
  assert.deepEqual(chip({ input: 3412477, output: 9231, cached: 3329321, rounds: 90 }),
    { label: '3412477→9231 tok (3329321 cached)', kind: 'read' }, 'cached suffix when reported');
});

// ------------------------------------------------------------------- honesty

test('rounds are counted from tool chips, not from usage chips', () => {
  const { computeSessionUsage } = loadComputeSessionUsage(toolTurn({ toolCalls: 76, input: 65842, output: 332 }));
  const u = computeSessionUsage();
  assert.equal(u.totalTurns, 1, 'one usage chip means one turn');
  assert.equal(u.totalRounds, 77, '76 tool calls + the final answer round');
  assert.equal(u.perModel['Kimi K3'].rounds, 77, 'per-model rounds tracked too');
});

test('a legacy last-round-only figure is flagged as under-reported', () => {
  // The measured Citadel shape: 76 tool calls but a chip reading 65,842 in.
  // 855 input tokens per round is impossible for a cumulative total.
  const { computeSessionUsage } = loadComputeSessionUsage(toolTurn({ toolCalls: 76, input: 65842, output: 332 }));
  const u = computeSessionUsage();
  assert.equal(u.underReported, true, 'legacy figure detected');
  assert.equal(u.perModel['Kimi K3'].underReported, true, 'per-model row flagged');
});

test('a correctly accounted turn is NOT flagged', () => {
  // 125 tool calls, 3,412,477→9,231 with 3,329,321 cached: 27,083 per round.
  const { computeSessionUsage } = loadComputeSessionUsage(toolTurn({ toolCalls: 125, input: 3412477, output: 9231, cached: 3329321 }));
  const u = computeSessionUsage();
  assert.equal(u.totalRounds, 126);
  assert.equal(u.underReported, false, 'cumulative figures pass the arithmetic test');
  assert.equal(u.totalCached, 3329321, 'cached suffix parsed');
});

test('ordinary short conversations are never flagged', () => {
  for (const toolCalls of [0, 1, 2]) {
    const u = loadComputeSessionUsage(toolTurn({ toolCalls, input: 900, output: 120 })).computeSessionUsage();
    assert.equal(u.underReported, false, `${toolCalls} tool calls is below the judging threshold`);
  }
  const healthy = [
    ...toolTurn({ toolCalls: 5, input: 90000, output: 800 }),
    ...toolTurn({ toolCalls: 3, input: 60000, output: 400 }),
  ];
  const u = loadComputeSessionUsage(healthy).computeSessionUsage();
  assert.equal(u.totalTurns, 2, 'two usage chips');
  assert.equal(u.underReported, false, 'normal per-round sizes pass');
});

test('bare legacy chips without a cached suffix still parse', () => {
  const u = loadComputeSessionUsage([
    { role: 'agent', model: 'Sonnet 5', chips: [{ kind: 'read', label: '12,345→678 tok' }] },
  ]).computeSessionUsage();
  assert.equal(u.totalIn, 12345);
  assert.equal(u.totalOut, 678);
  assert.equal(u.totalCached, 0);
});

test('a flagged conversation renders floors and a corrected disclaimer', () => {
  const renderAt = appSrc.indexOf('function renderUsageModal()');
  const seg = appSrc.slice(renderAt, renderAt + 4000);
  assert.ok(seg.includes('const atLeast = (text) => (underReported ? `≥ ${text}` : text);'), 'totals print as floors when under-reported');
  assert.ok(seg.includes('atLeast((totalIn + totalOut).toLocaleString())'), 'token total goes through atLeast');
  assert.ok(seg.includes('atLeast(formatUSD(totalCost))'), 'cost estimate goes through atLeast');
  assert.ok(seg.includes('>API rounds<'), 'the misleading "Turns" stat box now reports API rounds');
  assert.ok(seg.includes('Incomplete accounting — the real cost is higher.'), 'warning states the direction of the error');
  assert.ok(seg.includes('usage-modal__note--warn'), 'warning uses its own style');
  const warnAt = seg.indexOf('usage-modal__note--warn');
  const highAt = seg.indexOf('so it can run high');
  assert.ok(highAt > warnAt, 'the "can run high" disclaimer survives only in the non-flagged branch');
  assert.ok(cssSrc.includes('.usage-modal__note--warn'), 'warning style defined');
});
