// Verify Phase 1 of the chat surface system.
import WebSocket from 'ws';

const wsUrl = process.argv[2];
const ws = new WebSocket(wsUrl);

let testId = 0;

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++testId;
    const onMsg = (data) => {
      const msg = JSON.parse(data);
      if (msg.id === id) {
        ws.off('message', onMsg);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evalExpr(expression, awaitPromise = false) {
  const res = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise,
  });
  if (res.exceptionDetails) throw new Error('Eval exception: ' + JSON.stringify(res.exceptionDetails));
  return res.result.value;
}

ws.on('open', async () => {
  try {
    console.log('Step 1: reloading renderer...');
    await send('Page.enable');
    await send('Page.reload', { ignoreCache: true });
    await new Promise(r => setTimeout(r, 1500));

    console.log('Step 2: checking FarnsworthSurfaces namespace...');
    const exists = await evalExpr(`typeof window.FarnsworthSurfaces`);
    if (exists !== 'object') throw new Error('FarnsworthSurfaces missing: ' + exists);
    console.log('  OK window.FarnsworthSurfaces = ' + exists);

    console.log('Step 3: checking registered surface types...');
    const types = await evalExpr(`
      JSON.stringify({
        card: window.FarnsworthSurfaces.hasSurface('card'),
        choice: window.FarnsworthSurfaces.hasSurface('choice'),
        confirmation: window.FarnsworthSurfaces.hasSurface('confirmation'),
        form: window.FarnsworthSurfaces.hasSurface('form'),
        copy_block: window.FarnsworthSurfaces.hasSurface('copy_block'),
        work_result: window.FarnsworthSurfaces.hasSurface('work_result'),
        credential: window.FarnsworthSurfaces.hasSurface('credential'),
        oauth_connect: window.FarnsworthSurfaces.hasSurface('oauth_connect'),
      })
    `);
    const parsed = JSON.parse(types);
    console.log('  Registered: ' + JSON.stringify(parsed));
    const expected = ['card', 'choice', 'confirmation', 'form', 'copy_block', 'work_result', 'credential', 'oauth_connect'];
    for (const t of expected) {
      if (!parsed[t]) throw new Error('Surface not registered: ' + t);
    }
    console.log('  OK all 8 surface types registered');

    console.log('Step 4: rendering test task_progress card...');
    const result = await evalExpr(`
      (function() {
        const mount = document.createElement('div');
        mount.id = 'test-mount';
        document.body.appendChild(mount);
        const node = window.FarnsworthSurfaces.render({
          surfaceId: 'test-1',
          surfaceType: 'card',
          data: {
            template: 'task_progress',
            templateData: {
              title: 'Test progress card',
              status: 'in_progress',
              steps: [
                { label: 'Step A', status: 'completed' },
                { label: 'Step B', status: 'in_progress' },
                { label: 'Step C', status: 'pending' },
              ]
            }
          }
        }, {});
        mount.appendChild(node);
        return JSON.stringify({
          hasTaskProgressClass: !!mount.querySelector('.surface--task-progress'),
          stepCount: mount.querySelectorAll('.task-progress__step').length,
          titleText: mount.querySelector('.task-progress__title-text')?.textContent,
          statusText: mount.querySelector('.task-progress__status')?.textContent,
          firstStepLabel: mount.querySelector('.task-progress__step:nth-child(1) .task-progress__label')?.textContent,
          secondStepClass: mount.querySelector('.task-progress__step:nth-child(2)')?.className,
        });
      })()
    `);
    const cardCheck = JSON.parse(result);
    console.log('  Card render: ' + JSON.stringify(cardCheck));
    if (!cardCheck.hasTaskProgressClass) throw new Error('Task progress class missing');
    if (cardCheck.stepCount !== 3) throw new Error('Step count wrong: ' + cardCheck.stepCount);
    if (cardCheck.titleText !== 'Test progress card') throw new Error('Title wrong: ' + cardCheck.titleText);
    console.log('  OK task_progress card renders correctly');

    console.log('Step 5: rendering test choice surface...');
    const choiceResult = await evalExpr(`
      (function() {
        const mount = document.getElementById('test-mount');
        mount.innerHTML = '';
        const node = window.FarnsworthSurfaces.render({
          surfaceId: 'test-2',
          surfaceType: 'choice',
          data: {
            description: 'Pick one',
            options: [
              { id: 'a', label: 'Option A', description: 'first option' },
              { id: 'b', label: 'Option B' },
            ],
            selectionMode: 'single',
          }
        }, {});
        mount.appendChild(node);
        return JSON.stringify({
          optionCount: mount.querySelectorAll('.choice__option').length,
          firstOptionLabel: mount.querySelector('.choice__option:nth-child(1) .choice__option-label')?.textContent,
        });
      })()
    `);
    const choiceCheck = JSON.parse(choiceResult);
    console.log('  Choice render: ' + JSON.stringify(choiceCheck));
    if (choiceCheck.optionCount !== 2) throw new Error('Choice option count wrong: ' + choiceCheck.optionCount);
    console.log('  OK choice surface renders correctly');

    console.log('Step 6: rendering test work_result surface...');
    const workResult = await evalExpr(`
      (function() {
        const mount = document.getElementById('test-mount');
        mount.innerHTML = '';
        const node = window.FarnsworthSurfaces.render({
          surfaceId: 'test-3',
          surfaceType: 'work_result',
          data: {
            eyebrow: 'Built',
            status: 'completed',
            summary: 'Test receipt',
            metrics: [
              { label: 'Files', value: '3', tone: 'positive' },
              { label: 'Lines', value: '+218/-129', tone: 'positive' },
            ],
            sections: [
              { id: 'files', title: 'Files changed', type: 'items', items: [
                { title: 'src/app.js', description: '10 new commands', tone: 'positive' },
              ]}
            ]
          }
        }, {});
        mount.appendChild(node);
        return JSON.stringify({
          metricCount: mount.querySelectorAll('.work-result__metric').length,
          statusText: mount.querySelector('.work-result__status')?.textContent,
          itemCount: mount.querySelectorAll('.work-result__item').length,
        });
      })()
    `);
    const wrCheck = JSON.parse(workResult);
    console.log('  Work result render: ' + JSON.stringify(wrCheck));
    if (wrCheck.metricCount !== 2) throw new Error('Metric count wrong: ' + wrCheck.metricCount);
    if (wrCheck.itemCount !== 1) throw new Error('Item count wrong: ' + wrCheck.itemCount);
    console.log('  OK work_result surface renders correctly');

    console.log('Step 7: checking AGENT_TOOLS via window.farnsworth.getAgentTools()...');
    const tools = await evalExpr(`
      window.farnsworth.getAgentTools().then(r => JSON.stringify({
        ok: r.ok,
        toolNames: (r.tools || []).map(t => t.name),
        uiShowPresent: !!(r.tools || []).find(t => t.name === 'ui_show'),
      }))
    `, true);
    const toolsCheck = JSON.parse(tools);
    console.log('  Tools: ' + (toolsCheck.toolNames || []).join(', '));
    if (!toolsCheck.uiShowPresent) throw new Error('ui_show tool not in AGENT_TOOLS');
    console.log('  OK ui_show registered in AGENT_TOOLS');

    console.log('Step 8: inspecting ui_show tool spec...');
    const spec = await evalExpr(`
      window.farnsworth.getAgentTools().then(r => {
        const t = (r.tools || []).find(t => t.name === 'ui_show');
        return JSON.stringify({
          hasDescription: !!t?.description && t.description.length > 50,
          hasInputSchema: !!t?.input_schema,
          surfaceTypeEnum: t?.input_schema?.properties?.surfaceType?.enum,
        });
      })
    `, true);
    const specCheck = JSON.parse(spec);
    console.log('  Spec: ' + JSON.stringify(specCheck));
    if (!specCheck.hasDescription) throw new Error('ui_show description missing or too short');
    if (!specCheck.surfaceTypeEnum || specCheck.surfaceTypeEnum.length < 5) throw new Error('ui_show surfaceType enum too small');
    console.log('  OK ui_show tool spec is well-formed');

    await evalExpr(`document.getElementById('test-mount')?.remove()`);

    console.log('');
    console.log('===== ALL PHASE 1 SURFACE CHECKS PASSED =====');
    console.log('Phase 1 complete: surfaces register, render, and ui_show is in AGENT_TOOLS.');
    process.exit(0);
  } catch (e) {
    console.error('FAILURE: ' + e.message);
    process.exit(1);
  }
});

ws.on('error', (e) => {
  console.error('WS error: ' + e.message);
  process.exit(1);
});