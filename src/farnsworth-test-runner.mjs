/**
 * Farnsworth Test Runner — Node-native CDP test runner
 *
 * Replaces farnsworth-test.py (Python + websocket-client) with an in-process
 * Node module that drives Electron's webContents.debugger API directly.
 *
 * No WebSocket, no Python, no third-party CDP library.
 *
 * Usage (from Electron main process):
 *   import { runTest } from './farnsworth-test-runner.mjs'
 *   const result = await runTest(view.webContents, steps, { timeout: 60000 })
 *
 * Format: 16 actions matching DEVVIT-TESTS.md (ground truth from farnsworth-test.py)
 *
 * KNOWN GAP (Aug 3 2026, see main.js test:run integration): switchUser /
 * switchDevvitUser is an unimplemented no-op stub here — the real
 * implementation needs a second CDP connection to Farnsworth's OWN renderer
 * plus a dev-server restart + re-attach dance (ported from farnsworth-test.py's
 * switch_devvit_user()). llm-step also differs from the Python runner: it
 * always shells to the `claude` CLI, where the Python runner takes a
 * direct-API fast path when FARNSWORTH_AUTH_TOKEN is present. main.js's
 * integration routes tests using either action to the Python runner instead
 * of silently degrading — do not flip that routing until both gaps are
 * closed and verified against a live project.
 */

// ─── Variable scope ───────────────────────────────────────────────────────────
// Runner-scoped variables, set/read via extract / setVar / increment.
// Survives page reloads (stored in Node memory, not page state).

const INTERPOLATE_REGEX = /\$\{([^}]+)\}/g

function interpolate(str, vars) {
  if (typeof str !== 'string') return str
  return str.replace(INTERPOLATE_REGEX, (_, name) => {
    if (name in vars) return String(vars[name])
    throw new Error(`Undefined variable "${name}" in interpolation`)
  })
}

// ─── Action implementations ───────────────────────────────────────────────────

async function action_reload(webContents, vars, step) {
  const waitMs = step.waitMs ?? 1500
  // Reload via sendCommand — this replaces Page.reload from CDP
  await webContents.debugger.sendCommand('Page.reload')
  await sleep(waitMs)
}

async function action_waitFor(webContents, vars, step) {
  const selector = interpolate(step.selector, vars)
  const timeout = step.timeout ?? 5000
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try {
      const result = await webContents.debugger.sendCommand('Runtime.evaluate', {
        expression: `!!document.querySelector(${selectorLiteral(selector)})`,
        returnByValue: true,
      })
      if (result.result?.value === true) return
    } catch {
      // Page may be mid-reload — retry
    }
    await sleep(200)
  }
  throw new Error(`waitFor timeout: selector "${selector}" not found within ${timeout}ms`)
}

async function action_waitForNotVisible(webContents, vars, step) {
  const selector = interpolate(step.selector, vars)
  const timeout = step.timeout ?? 5000
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try {
      const result = await webContents.debugger.sendCommand('Runtime.evaluate', {
        expression: `!document.querySelector(${selectorLiteral(selector)})`,
        returnByValue: true,
      })
      if (result.result?.value === true) return
    } catch {
      // retry
    }
    await sleep(200)
  }
  throw new Error(`waitForNotVisible timeout: selector "${selector}" still present within ${timeout}ms`)
}

async function action_click(webContents, vars, step) {
  const selector = interpolate(step.selector, vars)
  const box = await getElementBox(webContents, selector)
  if (!box) throw new Error(`click: element "${selector}" not found`)

  const x = box.x + box.width / 2
  const y = box.y + box.height / 2

  await webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x, y,
    button: 'left',
    clickCount: 1,
  })
  await webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x, y,
    button: 'left',
    clickCount: 1,
  })
}

async function action_clickIfPresent(webContents, vars, step) {
  const selector = interpolate(step.selector, vars)
  const box = await getElementBox(webContents, selector)
  if (!box) return // silently skip

  const x = box.x + box.width / 2
  const y = box.y + box.height / 2

  await webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x, y,
    button: 'left',
    clickCount: 1,
  })
  await webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x, y,
    button: 'left',
    clickCount: 1,
  })
}

async function action_type(webContents, vars, step) {
  const selector = interpolate(step.selector, vars)
  const value = step.value ?? ''

  // Focus the element first
  await webContents.debugger.sendCommand('Runtime.evaluate', {
    expression: `document.querySelector(${selectorLiteral(selector)})?.focus()`,
  })

  // Insert text
  await webContents.debugger.sendCommand('Input.insertText', { text: value })
}

async function action_screenshot(webContents, vars, step) {
  const result = await webContents.debugger.sendCommand('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
  })
  // Honour step.path like the Python runner does. Without this, a test that
  // says {"action":"screenshot","path":"/tmp/x.png"} silently produced no file
  // and the step still "passed" — the base64 went to the caller and nowhere else.
  if (step.path) {
    try {
      const { writeFile } = await import('fs/promises')
      await writeFile(step.path, Buffer.from(result.data, 'base64'))
    } catch (err) {
      throw new Error(`screenshot: could not write ${step.path}: ${err.message}`)
    }
  }
  // Return base64 data — caller decides what to do with it
  return { _screenshot: result.data }
}

async function action_eval(webContents, vars, step) {
  const expression = step.expression
  const result = await webContents.debugger.sendCommand('Runtime.evaluate', {
    expression,
    returnByValue: true,
  })
  return { _evalResult: result.result?.value }
}

async function action_sleep(webContents, vars, step) {
  const ms = step.ms ?? 1000
  await sleep(ms)
}

async function action_extract(webContents, vars, step) {
  const expression = step.expression
  const into = step.into
  if (!into) throw new Error('extract: missing "into" field')

  const result = await webContents.debugger.sendCommand('Runtime.evaluate', {
    expression,
    returnByValue: true,
  })
  vars[into] = result.result?.value
}

async function action_setVar(webContents, vars, step) {
  const name = step.name
  const value = step.value
  if (name === undefined) throw new Error('setVar: missing "name" field')
  vars[name] = value
}

async function action_increment(webContents, vars, step) {
  const name = step.var
  if (!name) throw new Error('increment: missing "var" field')
  vars[name] = (vars[name] ?? 0) + 1
}

async function action_if(webContents, vars, step) {
  const condition = step.condition
  if (!condition) throw new Error('if: missing "condition" field')

  const result = await webContents.debugger.sendCommand('Runtime.evaluate', {
    expression: condition,
    returnByValue: true,
  })
  if (result.result?.value === true && Array.isArray(step.steps)) {
    await runSteps(webContents, vars, step.steps, { abortOnFail: true })
  }
}

async function action_while(webContents, vars, step) {
  const max = step.max ?? 100
  const until = step.until
  const maxConsecutiveFailures = step.maxConsecutiveFailures ?? 8
  let consecutiveFailures = 0

  for (let i = 0; i < max; i++) {
    // Check until condition at top of each iteration
    if (until) {
      const result = await webContents.debugger.sendCommand('Runtime.evaluate', {
        expression: until,
        returnByValue: true,
      })
      if (result.result?.value === true) return // condition met, exit loop
    }

    if (!Array.isArray(step.steps)) continue

    try {
      await runSteps(webContents, vars, step.steps, { abortOnFail: true })
    } catch (err) {
      // A single failed iteration must NOT end the loop. These loops poll a
      // live, animating game: an element chosen by an extract can legitimately
      // disappear before the very next click (picker closes, possession ends),
      // and breaking there abandons the run mid-match while still reporting
      // success. Verified Aug 13 against production — one stale defense-picker
      // click ended a full-match test at H1 with gameOver:false.
      // Keep going, but bail out after enough CONSECUTIVE failures that the
      // loop is clearly wedged rather than merely racing.
      consecutiveFailures++
      console.warn(`[test-runner] while loop iteration ${i} failed (${consecutiveFailures} in a row): ${err.message}`)
      if (consecutiveFailures >= maxConsecutiveFailures) {
        console.warn(`[test-runner] while loop giving up after ${consecutiveFailures} consecutive failures`)
        break
      }
      continue
    }
    consecutiveFailures = 0
  }
  // max iterations reached — return success (matching Python runner behavior)
}

async function action_llmStep(webContents, vars, step) {
  // This action shells out to `claude` CLI.
  // In the Node runner, we call the system `claude` binary.
  // The step.prompt is used as-is with --output-format json.
  // This remains a CLI dependency, same as the Python runner.
  // For a fully bundled experience, this would route through Farnsworth's
  // own inference pipeline — but that's a future optimization.
  const prompt = step.prompt
  const model = step.model
  if (!prompt) throw new Error('llm-step: missing "prompt" field')

  const { spawnSync } = await import('child_process')
  const args = ['-p', prompt, '--output-format', 'json']
  if (model) args.push('--model', model)

  const result = spawnSync('claude', args, { timeout: 180_000, maxBuffer: 10 * 1024 * 1024 })
  if (result.error) throw new Error(`llm-step: claude execution failed: ${result.error.message}`)
  if (result.status !== 0) {
    throw new Error(`llm-step: claude exited ${result.status}: ${result.stderr?.toString() || '(no stderr)'}`)
  }

  // Parse JSON response into step instruction(s)
  try {
    const parsed = JSON.parse(result.stdout.toString())
    // The response should be a single step or array of steps
    const steps = Array.isArray(parsed) ? parsed : [parsed]
    await runSteps(webContents, vars, steps, { abortOnFail: true })
  } catch (parseErr) {
    throw new Error(`llm-step: failed to parse claude output as JSON: ${parseErr.message}`)
  }
}

async function action_switchUser(webContents, vars, step) {
  // switchUser requires opening a SECOND CDP connection to Farnsworth's renderer.
  // This is only supported when running inside Electron — the caller passes the
  // renderer webContents separately.
  // For pure webContents.debugger usage, this is a no-op that logs a warning.
  // The real implementation is in the integration layer (main.js).
  console.warn('[test-runner] switchUser not supported in standalone mode — use integrateWithFarnsworth()')
}

// ─── Action dispatch ──────────────────────────────────────────────────────────

const ACTION_MAP = {
  reload:              action_reload,
  waitFor:             action_waitFor,
  waitForNotVisible:   action_waitForNotVisible,
  click:               action_click,
  clickIfPresent:      action_clickIfPresent,
  type:                action_type,
  screenshot:          action_screenshot,
  eval:                action_eval,
  sleep:               action_sleep,
  extract:             action_extract,
  setVar:              action_setVar,
  increment:           action_increment,
  if:                  action_if,
  while:               action_while,
  'llm-step':          action_llmStep,
  switchUser:          action_switchUser,
  // Alias
  switchDevvitUser:    action_switchUser,
}

// Actions with a known correctness/parity gap vs. farnsworth-test.py (see
// module header). main.js checks this before choosing the Node path.
export const UNSUPPORTED_ACTIONS = new Set(['switchUser', 'switchDevvitUser', 'llm-step'])

// ─── Step runner ──────────────────────────────────────────────────────────────

async function runSteps(webContents, vars, steps, opts = {}) {
  const { abortOnFail = false } = opts

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    const action = step.action
    if (!action) throw new Error(`Step ${i}: missing "action" field`)

    const handler = ACTION_MAP[action]
    if (!handler) throw new Error(`Step ${i}: unknown action "${action}"`)

    try {
      const result = await handler(webContents, vars, step)
      // Accumulate side-channel results (screenshot, eval)
      if (result?._screenshot) {
        vars.__lastScreenshot = result._screenshot
      }
      if (result?._evalResult !== undefined) {
        vars.__lastEval = result._evalResult
      }
    } catch (err) {
      if (abortOnFail) throw err
      // Non-abort mode: log and continue (matching Python runner's default behavior)
      console.warn(`[test-runner] Step ${i} (${action}) failed (continuing): ${err.message}`)
    }
  }
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Run a test against a webContents.
 *
 * @param {Electron.WebContents} webContents - The webContents to drive (canvas preview's WebContentsView)
 * @param {Array<Object>} steps - Array of step objects (the "steps" field from a test JSON)
 * @param {Object} [opts]
 * @param {number} [opts.timeout] - Overall test timeout in ms (default 60000)
 * @param {Electron.WebContents} [opts.farnsworthWebContents] - Farnsworth's own renderer, needed for switchUser
 * @returns {Promise<{ok: boolean, steps: number, errors: string[], screenshots: string[], vars: Object}>}
 */
export async function runTest(webContents, steps, opts = {}) {
  const timeout = opts.timeout ?? 60_000
  const vars = {}
  // Optional observer, used by the video recorder to drive its step overlay.
  // Never allowed to affect the run: a throwing hook is swallowed.
  const rawOnStep = typeof opts.onStep === 'function' ? opts.onStep : null
  const onStep = rawOnStep ? (event) => { try { rawOnStep(event) } catch {} } : () => {}

  // Validate debugger is attached
  if (!webContents.debugger.isAttached()) {
    throw new Error('Debugger not attached to webContents — call webContents.debugger.attach("1.1") first')
  }

  const errors = []
  const screenshots = []
  let completed = 0
  const deadline = Date.now() + timeout

  for (let i = 0; i < steps.length; i++) {
    if (Date.now() >= deadline) {
      errors.push(`Overall timeout of ${timeout}ms exceeded at step ${i}`)
      break
    }

    const step = steps[i]
    const action = step.action
    const total = steps.length
    if (!action) {
      errors.push(`Step ${i}: missing "action" field`)
      onStep({ phase: 'end', index: i, total, action: '(none)', step, ok: false, error: 'missing "action" field' })
      continue
    }

    const handler = ACTION_MAP[action]
    if (!handler) {
      errors.push(`Step ${i}: unknown action "${action}"`)
      onStep({ phase: 'end', index: i, total, action, step, ok: false, error: `unknown action "${action}"` })
      continue
    }

    onStep({ phase: 'start', index: i, total, action, step })
    try {
      const result = await handler(webContents, vars, step)
      if (result?._screenshot) {
        screenshots.push(result._screenshot)
        vars.__lastScreenshot = result._screenshot
      }
      if (result?._evalResult !== undefined) {
        vars.__lastEval = result._evalResult
      }
      completed++
      onStep({ phase: 'end', index: i, total, action, step, ok: true })
    } catch (err) {
      errors.push(`Step ${i} (${action}): ${err.message}`)
      onStep({ phase: 'end', index: i, total, action, step, ok: false, error: err.message })
      // Don't break — keep going (matching Python runner behavior)
    }
  }

  return {
    ok: errors.length === 0,
    steps: completed,
    total: steps.length,
    errors,
    screenshots,
    vars: { ...vars },
  }
}

/**
 * Same as runTest but validates the input against DEVVIT-TESTS.md format first.
 */
export async function runTestFromJSON(webContents, jsonString, opts = {}) {
  let parsed
  try {
    parsed = JSON.parse(jsonString)
  } catch (err) {
    return { ok: false, error: `Invalid JSON: ${err.message}` }
  }

  // Accept both top-level array (just steps) and {steps: [...]} object
  const steps = Array.isArray(parsed) ? parsed : (parsed.steps ?? [])

  if (!Array.isArray(steps)) {
    return { ok: false, error: 'Test JSON must be an array or an object with a "steps" array' }
  }

  return await runTest(webContents, steps, opts)
}

/**
 * Load test steps from a JSON file.
 */
export async function loadTestFromFile(filePath) {
  const { readFile } = await import('fs/promises')
  const content = await readFile(filePath, 'utf-8')
  return content
}

// ─── Utility functions ────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// Emit the selector as a COMPLETE, correctly-escaped JS string literal —
// including its own quotes — for embedding in a Runtime.evaluate expression.
//
// The previous version escaped backslashes/backticks/$ and left the caller to
// wrap the result in single quotes. That silently broke every selector
// containing a single quote, which is the single most common form in this
// codebase's tests: `[data-testid='lobby-screen']` produced
//   document.querySelector('[data-testid='lobby-screen']')
// which is a syntax error, so the evaluate threw, waitFor swallowed it as
// "not found yet" and timed out, and click reported "element not found" for
// elements that were plainly on screen. Found Aug 13 while running a full-match
// test against production. JSON.stringify handles quotes, backslashes and
// control characters correctly in one step.
function selectorLiteral(selector) {
  return JSON.stringify(String(selector))
}

async function getElementBox(webContents, selector) {
  const result = await webContents.debugger.sendCommand('Runtime.evaluate', {
    expression: `(() => {
      const el = document.querySelector(${selectorLiteral(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    })()`,
    returnByValue: true,
  })
  return result.result?.value ?? null
}

// ─── Integration helpers ──────────────────────────────────────────────────────

/**
 * Create a test runner that's pre-attached to a webContents.
 * Returns { run(steps, opts), runFromJSON(jsonString, opts), attach(webContents), detach() }
 */
export function createTestRunner() {
  let wc = null

  return {
    attach(webContents) {
      wc = webContents
      if (!wc.debugger.isAttached()) {
        wc.debugger.attach('1.1')
      }
    },
    detach() {
      if (wc && wc.debugger.isAttached()) {
        wc.debugger.detach()
      }
      wc = null
    },
    run(steps, opts = {}) {
      if (!wc) throw new Error('No webContents attached — call attach() first')
      return runTest(wc, steps, opts)
    },
    runFromJSON(jsonString, opts = {}) {
      if (!wc) throw new Error('No webContents attached — call attach() first')
      return runTestFromJSON(wc, jsonString, opts)
    },
  }
}
