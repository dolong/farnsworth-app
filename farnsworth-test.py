#!/usr/bin/env python3
"""farnsworth-test — run a JSON test against a Farnsworth WebContentsView target.

Usage:
  farnsworth-test.py <test.json>           # run an existing test
  farnsworth-test.py new <name>            # scaffold a blank template
  farnsworth-test.py new <name> --steps "..."   # scaffold from plain English

Connects to CDP port 9222, finds the WebContentsView target (type=page, url
contains 'localhost:5174'), and runs each step in the JSON test file in order.
Saves screenshots + reports pass/fail.

Test JSON shape:
{
  "name": "draft 5 picks picking the rarest",
  "steps": [
    {"action": "reload"},
    {"action": "waitFor", "selector": ".fw-stage--desktop", "timeout": 5000},
    {"action": "clickIfPresent", "selector": ".lobby2-ftue svg"},
    {"action": "click", "selector": ".bnav-play"},
    {"action": "while", "max": 10, "until": "window.__drafted >= 5", "steps": [
      {"action": "waitFor", "selector": ".draft-card-slot", "timeout": 30000},
      {"action": "eval", "expression": "(() => { const tiers = Array.from(document.querySelectorAll('.draft-card-slot .dc-tier-label')); const m = {'COMMON':0,'UNCOMMON':0,'RARE':1,'ULTRA RARE':2}; let best = 0, br = -1; tiers.forEach((t,i) => { const r = m[t.textContent.trim()] ?? 0; if (r > br) { br = r; best = i + 1; } }); window.__drafted = (window.__drafted ?? 0) + 1; return best; })()"},
      {"action": "click", "selector": ".draft-card-slot:nth-child(${bestN}) .draft-card-anim"},
      {"action": "waitForNotVisible", "selector": ".draft-card-slot", "timeout": 15000}
    ]},
    {"action": "click", "selector": ".da-btn.ghost"},
    {"action": "click", "selector": ".da-btn.primary.big"}
  ]
}

Available actions:
  waitFor             - poll document.querySelector until found or timeout
  waitForNotVisible   - poll until selector absent (or timeout)
  click               - click center of element matching selector
  clickIfPresent      - click only if selector exists (no exception if absent)
  screenshot          - save PNG to given path
  eval                - run JS in the page, print return value
  reload              - Page.reload + sleep, resets state for idempotent runs
  type                - focus input, type characters via CDP key events
  extract             - eval JS, store return value in ${var}
  setVar              - set ${var} to literal value
  increment           - ${var} += 1
  while               - repeat nested steps up to `max` times; stop if `until` truthy
  if                  - run nested steps only if `condition` is truthy
  llm-step            - take screenshot (optional), ask an LLM. Fast path:
                        direct Anthropic API call (auth via FARNSWORTH_AUTH_TOKEN
                        or ANTHROPIC_API_KEY env). Fallback: `claude` CLI,
                        store response text in ${var}

Variable interpolation: any string arg (selector, path, expression) supports
${varName} substitution from values set via extract/setVar/increment. llm-step
can also store its response into a var with `into: "varName"`.

Selector prefix: `text=substring` matches any visible element whose text
contains the substring. Used for clicking SVG-based buttons (e.g. TeamSelect
START GAME button) that aren't queryable via standard CSS.

Plain-English keywords for `new --steps`:
  reload                            -> reload
  wait for X / wait until X         -> waitFor (selector = X)
  click X / tap X / press X         -> click (selector = X)
  dismiss / close modal / close X   -> clickIfPresent (selector = X or [role=dialog] button)
  screenshot / snap / shot          -> screenshot
  eval / inspect / check X          -> eval (expression = X)
"""

import json
import sys
import os
import re
import time
import base64
import subprocess
import urllib.request
import websocket

CDP_PORT = 9222

def find_target(port=CDP_PORT, prefer_url='localhost:5174'):
    targets = json.loads(urllib.request.urlopen(f'http://localhost:{port}/json').read())
    bv = next((t for t in targets if t.get('type') == 'page' and prefer_url in t.get('url', '')), None)
    if bv:
        return bv
    page_targets = [t for t in targets if t.get('type') == 'page']
    if len(page_targets) == 1 and 'index.html' in page_targets[0].get('url', ''):
        print(f'ERROR: No WebContentsView target found at port {port}.')
        print(f'  Only the Farnsworth main renderer is active (file://...index.html).')
        print(f'  Switch the canvas to App Mobile / App Desktop / App Fullscreen')
        print(f'  to create a WebContentsView, then re-run.')
        return None
    return page_targets[0] if page_targets else None

class Tester:
    def __init__(self, ws):
        self.ws = ws
        self._id = 0
        self.vars = {}  # persistent across steps; ${var} interpolates from here

    def send(self, method, params=None):
        self._id += 1
        self.ws.send(json.dumps({'id': self._id, 'method': method, 'params': params or {}}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get('id') == self._id:
                if 'error' in msg:
                    raise Exception(f'CDP {method} error: {msg["error"]}')
                return msg.get('result', {})

    def eval(self, expr, await_promise=False):
        r = self.send('Runtime.evaluate', {
            'expression': expr,
            'returnByValue': True,
            'awaitPromise': await_promise,
        })
        if 'exceptionDetails' in r:
            ex = r['exceptionDetails']
            raise Exception(f'JS exception: {ex.get("text", "")}: {ex.get("exception", {}).get("description", "")}')
        # `returnByValue: true` returns `{"type": "undefined"}` (no value key)
        # for expressions that return undefined. Use `.get('value')` to handle
        # both undefined and missing-key cases — otherwise Python raises KeyError.
        return r['result'].get('value')

    def screenshot(self, path):
        r = self.send('Page.captureScreenshot', {'format': 'png'})
        with open(path, 'wb') as f:
            f.write(base64.b64decode(r['data']))
        return path

    def interpolate(self, text):
        """Replace ${varName} with self.vars[varName] in any string arg."""
        if not isinstance(text, str):
            return text
        def repl(m):
            key = m.group(1)
            return str(self.vars.get(key, ''))
        return re.sub(r'\$\{(\w+)\}', repl, text)

    def _text_selector_js(self, substring):
        """Build a JS expression that returns either an element (for click)
        or a truthy value (for waitFor). substring is the raw text fragment."""
        # Return {x, y} for click path; we use the same JS but the caller
        # checks the return shape.
        return f'''(() => {{
            const target = {json.dumps(substring)};
            const all = Array.from(document.querySelectorAll(
                'button, [role="button"], .lb2-qbtn, .da-btn, .bnav-item, .bnav-play, .draft-start-btn, .draft-card-anim, .lb2-mission-tab, .lb2-mission-cta, .lb2-ts-events, .lb2-ts-mute, .lb2-ts-bell, .paid-result-btn, g, text, rect'
            ));
            // Also include foreignObject descendants (TeamSelect input lives in one)
            document.querySelectorAll('foreignObject').forEach(fo => {{
                fo.querySelectorAll('button, [role="button"]').forEach(b => all.push(b));
            }});
            const matches = all.filter(el => {{
                if (el.offsetParent === null && el.tagName !== 'foreignObject') return false;
                return (el.textContent || '').trim().includes(target);
            }});
            if (matches.length === 0) return null;
            // Prefer the most specific match (fewest descendants)
            matches.sort((a, b) => a.children.length - b.children.length);
            const el = matches[0];
            let clickable = el;
            while (clickable && !['BUTTON','A','INPUT'].includes(clickable.tagName) && clickable.tagName !== 'g' && clickable.onclick == null) {{
                if (clickable.parentElement && clickable.parentElement.onclick) {{ clickable = clickable.parentElement; break; }}
                clickable = clickable.parentElement;
                if (!clickable || clickable === document.body) break;
            }}
            const target2 = clickable && clickable.getBoundingClientRect ? clickable : el;
            const r = target2.getBoundingClientRect();
            return {{ x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) }};
        }})()'''

    def _text_present_js(self, substring):
        # Use innerText (rendered text of all visible elements) — much more
        # robust than enumerating specific selectors because the Last Draft UI
        # uses decorative spans (.ts-label, .ah-label, etc.) for headings.
        return f'document.body.innerText && document.body.innerText.includes({json.dumps(substring)})'

    def wait_for(self, selector, timeout_ms=5000):
        selector = self.interpolate(selector)
        start = time.time()
        while (time.time() - start) * 1000 < timeout_ms:
            if selector.startswith('text='):
                found = self.eval(self._text_present_js(selector[5:]))
            else:
                found = self.eval(f'!!document.querySelector({json.dumps(selector)})')
            if found:
                return True
            time.sleep(0.1)
        return False

    def wait_for_not_visible(self, selector, timeout_ms=5000):
        selector = self.interpolate(selector)
        start = time.time()
        while (time.time() - start) * 1000 < timeout_ms:
            if selector.startswith('text='):
                present = self.eval(self._text_present_js(selector[5:]))
            else:
                present = self.eval(f'!!document.querySelector({json.dumps(selector)})')
            if not present:
                return True
            time.sleep(0.1)
        return False

    def click(self, selector):
        selector = self.interpolate(selector)
        if selector.startswith('text='):
            coords = self.eval(self._text_selector_js(selector[5:]))
        else:
            coords = self.eval(f'''
                (() => {{
                    const e = document.querySelector({json.dumps(selector)});
                    if (!e) return null;
                    const r = e.getBoundingClientRect();
                    return {{ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }};
                }})()
            ''')
        if coords is None:
            raise Exception(f'Selector not found: {selector}')
        x, y = coords['x'], coords['y']
        self.send('Input.dispatchMouseEvent', {'type': 'mouseMoved', 'x': x, 'y': y})
        self.send('Input.dispatchMouseEvent', {'type': 'mousePressed', 'x': x, 'y': y, 'button': 'left', 'clickCount': 1})
        self.send('Input.dispatchMouseEvent', {'type': 'mouseReleased', 'x': x, 'y': y, 'button': 'left', 'clickCount': 1})
        return coords

    def reload(self, wait_ms=1500):
        self.send('Page.enable')
        self.send('Page.reload', {'ignoreCache': True})
        time.sleep(wait_ms / 1000)

    def click_if_present(self, selector):
        selector = self.interpolate(selector)
        present = self.wait_for(selector, timeout_ms=300)
        if present:
            self.click(selector)
            return True
        return False

    def type_text(self, selector, text):
        """Focus input + use CDP Input.insertText. Works with React-controlled
        inputs because Input.insertText fires the proper beforeinput event
        that React listens for, instead of bypassing React's value tracker."""
        selector = self.interpolate(selector)
        # Focus the element
        self.eval(f'''
            (() => {{
                const e = document.querySelector({json.dumps(selector)});
                if (!e) throw new Error('type target not found: ' + {json.dumps(selector)});
                e.focus();
                e.select && e.select();
            }})()
        ''')
        time.sleep(0.05)
        # Insert text as a single CDP command — fires beforeinput + input events
        # that React/Vue/Svelte all listen for, so controlled inputs update correctly.
        self.send('Input.insertText', {'text': text})

    # Short aliases for the `model` field on llm-step. Full API ids pass
    # through untouched. Source: src/app.js modelToApiId (Jul 6 2026 table).
    LLM_MODEL_ALIASES = {
        'haiku': 'claude-haiku-4-5',
        'sonnet': 'claude-sonnet-5',
        'opus': 'claude-opus-4-8',
    }

    def _llm_api(self, prompt, img_path, into, model, max_tokens, token, kind):
        """llm-step fast path: ONE direct POST to api.anthropic.com with the
        screenshot inlined as base64. No CLI boot, no agentic Read-tool round
        trip, no Claude Code system-prompt prefill. Same model = same judgment."""
        # Model precedence: per-step "model" field > FARNSWORTH_TEST_MODEL env
        # (Farnsworth Settings → AI → Testing model) > sonnet.
        model_id = (
            self.LLM_MODEL_ALIASES.get((model or '').strip().lower(), model)
            or os.environ.get('FARNSWORTH_TEST_MODEL')
            or 'claude-sonnet-5'
        )
        print(f'[{model_id}]', end=' ', flush=True)
        content = []
        if img_path:
            with open(img_path, 'rb') as f:
                b64 = base64.b64encode(f.read()).decode('ascii')
            content.append({'type': 'image', 'source': {'type': 'base64', 'media_type': 'image/png', 'data': b64}})
        content.append({'type': 'text', 'text': prompt})
        body = {
            'model': model_id,
            'max_tokens': int(max_tokens) if max_tokens else 512,
            'messages': [{'role': 'user', 'content': content}],
        }
        # Header shape mirrors main.js inference:send exactly (oauth vs api_key).
        headers = {'Content-Type': 'application/json', 'anthropic-version': '2023-06-01'}
        if kind == 'oauth':
            headers['Authorization'] = f'Bearer {token}'
            headers['anthropic-beta'] = 'oauth-2025-04-20,claude-code-20250219'
        else:
            headers['x-api-key'] = token
        req = urllib.request.Request(
            'https://api.anthropic.com/v1/messages',
            data=json.dumps(body).encode('utf-8'),
            headers=headers, method='POST')
        with urllib.request.urlopen(req, timeout=90) as res:
            data = json.loads(res.read())
        response = ''.join(
            b.get('text', '') for b in data.get('content', []) if b.get('type') == 'text'
        ).strip()
        if into:
            self.vars[into] = response
        return response

    def llm_step(self, prompt, into=None, screenshot=False, model=None, max_tokens=None):
        """LLM judgment step, two transports:

        FAST PATH (default when auth is available): direct API call via
        _llm_api. Auth comes from FARNSWORTH_AUTH_TOKEN + FARNSWORTH_AUTH_KIND
        (injected by Farnsworth's test:run spawn) or ANTHROPIC_API_KEY
        (terminal runs).

        FALLBACK: shell to `claude -p` (the original path) when no auth env is
        present or the API call fails. Slow: Node CLI boot + TWO inference
        turns, because the model has to Read-tool the screenshot file before
        it can answer.
        """
        img_path = None
        if screenshot:
            img_path = f'/tmp/llm-step-{int(time.time()*1000)}.png'
            self.screenshot(img_path)

        token = os.environ.get('FARNSWORTH_AUTH_TOKEN') or os.environ.get('ANTHROPIC_API_KEY')
        if token:
            kind = os.environ.get('FARNSWORTH_AUTH_KIND') or 'api_key'
            try:
                return self._llm_api(prompt, img_path, into, model, max_tokens, token, kind)
            except Exception as e:
                print(f'(API fast path failed: {e}; falling back to claude CLI)', end=' ')

        if img_path:
            full_prompt = f'{prompt}\n\nThe current page screenshot is at: {img_path}\nUse the Read tool to view it before answering.'
        else:
            full_prompt = prompt

        cmd = ['claude', '-p', full_prompt, '--output-format', 'json']
        if model:
            cmd.extend(['--model', model])
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
            stdout = proc.stdout
            try:
                envelope = json.loads(stdout)
                # claude -p --output-format json returns the response inside the
                # envelope. The exact field varies by version; try common ones.
                response = (
                    envelope.get('result')
                    or envelope.get('response')
                    or envelope.get('content')
                    or envelope.get('message')
                    or envelope.get('text')
                    or stdout
                )
            except Exception:
                response = stdout
            if into:
                self.vars[into] = response.strip() if isinstance(response, str) else response
            return response
        except subprocess.TimeoutExpired:
            raise Exception('claude CLI timed out (>180s)')
        except FileNotFoundError:
            raise Exception('claude CLI not found on PATH')

def run_step(t, step, idx):
    action = step['action']
    desc = step.get('selector') or step.get('path') or step.get('expression') or step.get('prompt', '')[:60]
    print(f'  [{idx}] {action:18} {str(desc)[:60]}', end='... ')
    try:
        if action == 'waitFor':
            ok = t.wait_for(step['selector'], step.get('timeout', 5000))
            if not ok:
                print('TIMEOUT')
                return False
            print('OK')
            return True
        elif action == 'waitForNotVisible':
            ok = t.wait_for_not_visible(step['selector'], step.get('timeout', 5000))
            if not ok:
                print('STILL VISIBLE (timeout)')
                return False
            print('GONE')
            return True
        elif action == 'click':
            coords = t.click(step['selector'])
            print(f'OK ({coords["x"]},{coords["y"]})')
            return True
        elif action == 'screenshot':
            path = step['path']
            t.screenshot(path)
            print(f'saved {path}')
            return True
        elif action == 'eval':
            result = t.eval(step['expression'])
            display = str(result)[:80]
            print(f'{display}')
            return True
        elif action == 'reload':
            wait = step.get('waitMs', 1500)
            t.reload(wait)
            print(f'OK (waited {wait}ms)')
            return True
        elif action == 'clickIfPresent':
            clicked = t.click_if_present(step['selector'])
            print('OK' if clicked else 'SKIPPED (not present)')
            return True
        elif action == 'sleep':
            ms = step.get('ms', 1000)
            time.sleep(ms / 1000)
            print(f'OK ({ms}ms)')
            return True
        elif action == 'type':
            t.type_text(step['selector'], step['text'])
            print(f'OK ({len(step["text"])} chars)')
            return True
        elif action == 'extract':
            result = t.eval(step['expression'])
            t.vars[step['into']] = result
            display = str(result)[:60]
            print(f'{step["into"]} = {display}')
            return True
        elif action == 'setVar':
            t.vars[step['name']] = step['value']
            print(f'{step["name"]} = {step["value"]!r}')
            return True
        elif action == 'increment':
            t.vars[step['var']] = t.vars.get(step['var'], 0) + 1
            print(f'{step["var"]} = {t.vars[step["var"]]}')
            return True
        elif action == 'if':
            cond = t.eval(step['condition'])
            if cond:
                for j, ns in enumerate(step.get('steps', [])):
                    if not run_step(t, ns, f'{idx}.if.{j+1}'):
                        return False
                print(f'(condition true, ran {len(step.get("steps", []))} steps)')
            else:
                print('(condition false, skipping)')
            return True
        elif action == 'while':
            nested = step.get('steps', [])
            max_iter = step.get('max', 100)
            until = step.get('until')
            if not nested:
                print('(no nested steps!)')
                return False
            for i in range(max_iter):
                if until:
                    keep_going = not t.eval(until)
                    if not keep_going:
                        print(f'until-true after {i} iter')
                        return True
                all_ok = True
                for j, ns in enumerate(nested):
                    if not run_step(t, ns, f'{idx}.w{i+1}.{j+1}'):
                        all_ok = False
                        break
                if not all_ok:
                    return False
            print(f'max {max_iter} reached')
            return True
        elif action == 'llm-step':
            response = t.llm_step(
                prompt=step['prompt'],
                into=step.get('into'),
                screenshot=step.get('screenshot', False),
                model=step.get('model'),
                max_tokens=step.get('max_tokens'),
            )
            display = str(response).strip()[:80]
            into_str = f' -> ${{{step["into"]}}}' if step.get('into') else ''
            print(f'{display}{into_str}')
            return True
        else:
            print(f'UNKNOWN ACTION: {action}')
            return False
    except Exception as e:
        print(f'EXCEPTION: {e}')
        return False

def parse_english_steps(text):
    steps = []
    parts = [p.strip() for p in re.split(r'[,;\n]|then|and then', text) if p.strip()]
    for p in parts:
        pl = p.lower()
        if pl == 'reload':
            steps.append({'action': 'reload', 'waitMs': 2000})
        elif pl.startswith('wait for ') or pl.startswith('wait until '):
            sel = p.split(' ', 2)[-1].strip()
            steps.append({'action': 'waitFor', 'selector': sel, 'timeout': 5000})
        elif pl.startswith('wait for your turn') or pl.startswith('wait until your turn'):
            steps.append({'action': 'waitFor', 'selector': '.your-turn-indicator', 'timeout': 30000})
        elif pl.startswith('click ') or pl.startswith('tap ') or pl.startswith('press '):
            sel = p.split(' ', 1)[1].strip()
            steps.append({'action': 'click', 'selector': sel})
        elif pl.startswith('dismiss') or pl.startswith('close modal') or pl.startswith('close dialogue'):
            steps.append({'action': 'clickIfPresent', 'selector': '[role=dialog] button, .lobby2-ftue svg, .close, [aria-label*="close" i]'})
        elif pl.startswith('screenshot') or pl.startswith('snap') or pl.startswith('shot'):
            steps.append({'action': 'screenshot', 'path': '/tmp/' + re.sub(r'[^a-z0-9]+', '-', pl) + '.png'})
        elif pl.startswith('eval ') or pl.startswith('inspect ') or pl.startswith('check '):
            expr = p.split(' ', 1)[1].strip()
            steps.append({'action': 'eval', 'expression': expr})
        elif pl.startswith('repeat ') or pl.startswith('loop '):
            # emit a placeholder while loop that the user fills in
            steps.append({'_comment': f'Repeat block — please fill in nested steps: {p}', 'action': 'while', 'max': 5, 'steps': []})
        else:
            steps.append({'action': 'eval', 'expression': p})
    return steps

def scaffold_test(name, steps_text=None):
    safe_name = re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-')
    path = f'tests/{safe_name}.json'
    os.makedirs('tests', exist_ok=True)
    if steps_text:
        steps = parse_english_steps(steps_text)
    else:
        steps = [
            {'action': 'reload', 'waitMs': 2000, '_comment': 'Reset state so test is idempotent'},
            {'action': 'waitFor', 'selector': '.fw-stage--desktop', 'timeout': 5000, '_comment': 'Wait for canvas to render'},
            {'action': 'clickIfPresent', 'selector': '.lobby2-ftue svg', '_comment': 'Dismiss any welcome modal'},
            {'action': 'click', 'selector': '.bnav-play', '_comment': 'Click PLAY tab'},
            {'action': 'screenshot', 'path': f'/tmp/{safe_name}.png', '_comment': 'Save visual snapshot'},
            {'action': 'eval', 'expression': 'document.title', '_comment': 'Verify state'},
        ]
    template = {'name': name, 'steps': steps}
    with open(path, 'w') as f:
        json.dump(template, f, indent=2)
    return path

def main():
    if len(sys.argv) < 2 or sys.argv[1] in ('-h', '--help'):
        print(__doc__)
        sys.exit(0)
    if sys.argv[1] == 'new':
        name = sys.argv[2]
        steps_text = None
        if '--steps' in sys.argv:
            i = sys.argv.index('--steps')
            if i + 1 < len(sys.argv):
                steps_text = sys.argv[i + 1]
        path = scaffold_test(name, steps_text)
        print(f'Wrote {path}')
        print(f'Run with: python3 farnsworth-test.py {path}')
        if steps_text:
            print(f'Scaffolded from: "{steps_text}"')
        sys.exit(0)
    with open(sys.argv[1]) as f:
        test = json.load(f)
    print(f'Test: {test.get("name", "?")}')
    target = find_target()
    if not target:
        sys.exit(1)
    print(f'Target: {target["url"][:80]}')
    ws = websocket.create_connection(target['webSocketDebuggerUrl'], timeout=10)
    t = Tester(ws)
    passed = 0
    failed = 0
    for i, step in enumerate(test['steps']):
        if run_step(t, step, i + 1):
            passed += 1
        else:
            failed += 1
    ws.close()
    print(f'\n{passed} passed, {failed} failed (of {passed + failed})')
    if failed:
        sys.exit(1)

if __name__ == '__main__':
    main()