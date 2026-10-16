'use strict';

// Sep 7, 2026 — reading one conversation's transcript from another chat.
//
// Long asked whether a Citadel chat could read the dialogue of a scheduled
// run ("what did Rita actually do on post 2?"). It could not: schedule_list
// exposed status/timing/usage and the run's final result text, memory_recall
// returned titles and snippets, and read_file only reached files the run
// wrote to disk. The turn-by-turn record lived in the run's own
// [Scheduled] conversation and no tool could load it.
//
// The blocker was never access, it was size. A scheduled browsing run is
// stored as TWO messages (the prompt and the final agent turn) whose detail
// lives in ~100 tool chips, and every take_canvas_screenshot chip carries a
// ~1 MB inline `screenshotBase64`. Rita's Sep 6 run is 32,315,397 bytes of
// conversation JSON — but only 41,335 bytes once screenshot payloads are
// dropped. That is the whole trick: strip the base64, keep the tool calls,
// and a run that could never fit in a context window becomes readable.
//
// This module is deliberately pure (no electron, no db) so the flattening
// rules are unit-testable against real transcript shapes.

const MAX_MESSAGE_TEXT = 6000;
const MAX_NARRATION_ENTRIES = 80;
const MAX_NARRATION_TEXT = 700;
const MAX_LABEL = 300;
const MAX_INPUT_JSON = 800;
const DEFAULT_OUTPUT_CHARS = 600;
const MAX_OUTPUT_CHARS = 4000;
const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 200;

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function messageText(message) {
  if (typeof message?.text === 'string') return message.text;
  if (typeof message?.content === 'string') return message.content;
  if (Array.isArray(message?.content)) {
    return message.content.filter((b) => b && b.type === 'text').map((b) => b.text || '').join(' ');
  }
  return '';
}

function truncate(value, max) {
  const s = String(value == null ? '' : value);
  return s.length > max ? s.slice(0, max) + `… [+${s.length - max} chars]` : s;
}

// Tool inputs are small objects, but a write_file input can carry an entire
// file body — cap the serialized form rather than the object.
function safeInput(input) {
  if (input === undefined || input === null) return undefined;
  let json;
  try { json = JSON.stringify(input); } catch { return '[unserializable input]'; }
  if (json === undefined) return undefined;
  return json.length > MAX_INPUT_JSON ? json.slice(0, MAX_INPUT_JSON) + `… [+${json.length - MAX_INPUT_JSON} chars]` : json;
}

// A chip is one tool call: { label, kind, name, input, output,
// screenshotBase64, _superseded, runIndex }. screenshotBase64 is dropped
// unconditionally and reported as a boolean — the chip's own output already
// carries the screenshot's path and dimensions, which is what an agent
// reasoning about the run actually needs.
function flattenToolCalls(messages) {
  const calls = [];
  messages.forEach((message, messageIndex) => {
    const chips = Array.isArray(message?.chips) ? message.chips : [];
    chips.forEach((chip) => {
      if (!chip) return;
      const output = String(chip.output == null ? '' : chip.output);
      calls.push({
        index: calls.length,
        message: messageIndex,
        kind: chip.kind || null,
        name: chip.name || null,
        label: truncate(chip.label || '', MAX_LABEL),
        input: safeInput(chip.input),
        output,
        outputChars: output.length,
        screenshot: chip.screenshotBase64 ? true : undefined,
        superseded: chip._superseded ? true : undefined,
      });
    });
  });
  return calls;
}

// The agent's interleaved thinking/preamble text lives in message.timeline
// as { type:'text', text } entries — this is the closest thing to a
// narration of what the run was doing between tool calls.
function flattenNarration(messages) {
  const out = [];
  messages.forEach((message, messageIndex) => {
    const timeline = Array.isArray(message?.timeline) ? message.timeline : [];
    timeline.forEach((entry) => {
      if (!entry || entry.type !== 'text') return;
      const text = String(entry.text || '').trim();
      if (text.length < 2) return;
      out.push({ message: messageIndex, text: truncate(text, MAX_NARRATION_TEXT) });
    });
  });
  return out;
}

function matchesSearch(call, needle) {
  if (!needle) return true;
  const haystack = [call.label, call.name, call.input, call.output].join('\u0000').toLowerCase();
  return haystack.includes(needle);
}

/**
 * Flatten a stored conversation into an agent-readable transcript.
 *
 * @param {object} args
 * @param {object} args.conversation row from chat_conversations (messages already parsed or raw JSON string)
 * @param {object} [args.run] matching scheduled_job_runs record, when this conversation came from a scheduled run
 * @param {object} [args.options] { search, offset, limit, includeOutputs, outputChars, includeNarration }
 */
function buildTranscript({ conversation, run = null, options = {} } = {}) {
  if (!conversation) return { ok: false, error: 'not_found' };

  let messages = conversation.messages;
  if (typeof messages === 'string') {
    try { messages = JSON.parse(messages); } catch { messages = []; }
  }
  if (!Array.isArray(messages)) messages = [];

  const search = String(options.search || '').trim().toLowerCase();
  const limit = clampInt(options.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const offset = clampInt(options.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const includeOutputs = options.includeOutputs !== false;
  const outputChars = clampInt(options.outputChars, DEFAULT_OUTPUT_CHARS, 0, MAX_OUTPUT_CHARS);
  const includeNarration = options.includeNarration !== false;

  const allCalls = flattenToolCalls(messages);
  const matched = search ? allCalls.filter((c) => matchesSearch(c, search)) : allCalls;
  const page = matched.slice(offset, offset + limit).map((call) => {
    const shaped = { ...call };
    if (!includeOutputs || outputChars === 0) {
      delete shaped.output;
    } else {
      shaped.output = truncate(shaped.output, outputChars);
    }
    if (shaped.input === undefined) delete shaped.input;
    if (shaped.output === '') delete shaped.output;
    return shaped;
  });

  const narrationAll = includeNarration ? flattenNarration(messages) : [];
  const narration = search
    ? narrationAll.filter((n) => n.text.toLowerCase().includes(search))
    : narrationAll;

  const transcript = {
    ok: true,
    conversation: {
      id: conversation.id,
      title: conversation.title || null,
      workspacePath: conversation.workspace_path || conversation.workspacePath || null,
      updatedAt: conversation.updated_at || conversation.updatedAt || null,
      messageCount: messages.length,
    },
    messages: messages.map((message, index) => {
      const shaped = {
        index,
        role: message?.role || 'unknown',
        text: truncate(messageText(message), MAX_MESSAGE_TEXT),
        toolCalls: Array.isArray(message?.chips) ? message.chips.length : 0,
      };
      if (message?.model) shaped.model = message.model;
      if (message?.error) shaped.error = true;
      if (message?.stopped) shaped.stopped = true;
      return shaped;
    }),
    toolCalls: page,
    toolCallCount: allCalls.length,
    matchedToolCalls: matched.length,
    returned: page.length,
    // Screenshot payloads are never returned; this is why a 32 MB run is readable.
    screenshotsOmitted: allCalls.filter((c) => c.screenshot).length,
  };

  if (offset + page.length < matched.length) transcript.nextOffset = offset + page.length;
  if (search) transcript.search = search;
  if (includeNarration) {
    transcript.narration = narration.slice(0, MAX_NARRATION_ENTRIES).map((n) => n.text);
    if (narration.length > MAX_NARRATION_ENTRIES) transcript.narrationTruncated = narration.length - MAX_NARRATION_ENTRIES;
  }
  if (run) {
    transcript.run = {
      id: run.id,
      jobId: run.jobId,
      status: run.status,
      trigger: run.trigger,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      error: run.error || null,
      model: run.details?.model || null,
      usage: run.details?.usage || null,
    };
  }
  return transcript;
}

module.exports = { buildTranscript, flattenToolCalls, flattenNarration, messageText };
