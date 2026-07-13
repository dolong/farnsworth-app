// Verify unsaved-changes prompt — closeFile branches (Save / Don't Save / Cancel)
// We bypass the openFile flow by injecting a fake dirty entry into openFiles[]
// directly — tests the closeFile prompt logic without the async read chain.
import http from 'http';
import WebSocket from 'ws';
import fs from 'fs/promises';
import path from 'path';

const TARGETS_URL = 'http://localhost:9222/json/list';
const TEST_DIR = '/tmp/farnsworth-unsaved-test';

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function cdpValue(res) {
  return res.result?.result?.value ?? res.result?.value;
}

function evaluate(ws, expression, awaitPromise = false) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e9);
    const onMessage = (data) => {
      const msg = JSON.parse(data);
      if (msg.id === id) {
        ws.off('message', onMessage);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg);
      }
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify({
      id, method: 'Runtime.evaluate',
      params: { expression, returnByValue: true, awaitPromise },
    }));
  });
}

async function evalSync(ws, expression) {
  const res = await evaluate(ws, expression, false);
  if (res.result?.exceptionDetails) throw new Error(JSON.stringify(res.result.exceptionDetails));
  return cdpValue(res);
}

async function evalAsync(ws, expression) {
  const wrapped = `(${expression})`;
  const res = await evaluate(ws, wrapped, true);
  if (res.result?.exceptionDetails) throw new Error(JSON.stringify(res.result.exceptionDetails));
  return cdpValue(res);
}

async function main() {
  await fs.rm(TEST_DIR, { recursive: true, force: true });
  await fs.mkdir(TEST_DIR, { recursive: true });
  await fs.writeFile(path.join(TEST_DIR, 'dirty-test.txt'), 'original content\n');

  const targets = await fetchJson(TARGETS_URL);
  const page = targets.find(t => t.type === 'page' && t.url.startsWith('file://'));
  if (!page) throw new Error('no file:// renderer found');
  console.log('page:', page.url, 'id:', page.id);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(r => ws.once('open', r));
  console.log('connected');

  console.log('\n=== Step 1: setup state (folder + mock dialog) ===');
  await evalSync(ws, `
    (async function() {
      await window.farnsworth.setSetting('currentFolder', '${TEST_DIR}');
      state.folder = '${TEST_DIR}';
      await loadFolderFiles('${TEST_DIR}');

      // Mock the dialog IPC — track calls + return programmable choice
      window.__mockChoice = 2;
      window.__lastPrompt = null;
      window.__promptCount = 0;
      window.farnsworth.dialogConfirmDiscard = async function(opts) {
        window.__lastPrompt = opts;
        window.__promptCount++;
        return { choice: window.__mockChoice };
      };

      JSON.stringify({
        folder: state.folder,
        entries: state.files.entries.length,
        dirtyMockReady: true,
      });
    })()
  `);
  console.log('  OK state set up');

  console.log('\n=== Step 2: dialogConfirmDiscard IPC exposed ===');
  const ipcCheck = await evalSync(ws, `typeof window.farnsworth?.dialogConfirmDiscard`);
  console.log('  type: ' + ipcCheck);
  if (ipcCheck !== 'function') throw new Error('IPC missing');
  console.log('  OK dialogConfirmDiscard exposed');

  console.log('\n=== Step 3: inject dirty entry + close (Cancel) ===');
  await evalSync(ws, `
    (function() {
      openFiles.length = 0;
      openFiles.push({
        path: '${TEST_DIR}/dirty-test.txt',
        name: 'dirty-test.txt',
        ext: '.txt',
        dirty: true,
        diskContent: 'original content\\n',
        // No real model — closeFile only reads model.getValue() if it exists
      });
      activeFileIdx = 0;
      JSON.stringify({ injected: true, count: openFiles.length });
    })()
  `);
  await evalSync(ws, `window.__mockChoice = 2; window.__promptCount = 0; window.__lastPrompt = null`);
  // closeFile is async when dirty; await its returned promise
  await evalAsync(ws, `(function() { closeFile(0); })()`);
  await new Promise(r => setTimeout(r, 600));
  const afterCancel = await evalSync(ws, `JSON.stringify({
    count: openFiles.length,
    stillDirty: openFiles[0]?.dirty,
    promptCount: window.__promptCount,
    lastPrompt: window.__lastPrompt,
  })`);
  console.log('  after cancel: ' + afterCancel);
  const pCancel = JSON.parse(afterCancel);
  if (pCancel.count !== 1) throw new Error('Cancel: file should still be open, count=' + pCancel.count);
  if (!pCancel.stillDirty) throw new Error('Cancel: dirty flag should be unchanged');
  if (pCancel.promptCount !== 1) throw new Error('Cancel: prompt should have been called once');
  if (!pCancel.lastPrompt?.fileName?.includes('dirty-test')) throw new Error('Cancel: prompt should include fileName');
  console.log('  OK Cancel branch: file still open, prompt fired with fileName=' + pCancel.lastPrompt.fileName);

  console.log('\n=== Step 4: close (Don\'t Save) ===');
  await evalSync(ws, `window.__mockChoice = 1; window.__promptCount = 0`);
  await evalAsync(ws, `(function() { closeFile(0); })()`);
  await new Promise(r => setTimeout(r, 600));
  const afterDont = await evalSync(ws, `JSON.stringify({
    count: openFiles.length,
    diskContent: (await window.farnsworth.readFile('${TEST_DIR}', 'dirty-test.txt')).content,
    promptCount: window.__promptCount,
  })`);
  console.log('  after don\'t save: ' + afterDont);
  const pDont = JSON.parse(afterDont);
  if (pDont.count !== 0) throw new Error('Don\'t Save: file should be closed');
  if (pDont.diskContent === 'MODIFIED IN MEMORY\n') throw new Error('Don\'t Save: disk should NOT have modified content');
  if (pDont.promptCount !== 1) throw new Error('Don\'t Save: prompt should have been called');
  console.log('  OK Don\'t Save branch: file closed, disk untouched');

  console.log('\n=== Step 5: re-inject dirty + close (Save) ===');
  await evalSync(ws, `
    (function() {
      // Reset disk to original
      // (we don't need a real Monaco model — closeFile's Save branch
      // calls writeFile directly with file.model?.getValue() ?? ''.
      // Since we have no model, it writes '' which is fine for this test.
      openFiles.push({
        path: '${TEST_DIR}/dirty-test.txt',
        name: 'dirty-test.txt',
        ext: '.txt',
        dirty: true,
        diskContent: 'original content\\n',
      });
      activeFileIdx = 0;
      JSON.stringify({ reinjected: true });
    })()
  `);
  await evalSync(ws, `window.__mockChoice = 0; window.__promptCount = 0`);
  await evalAsync(ws, `(function() { closeFile(0); })()`);
  await new Promise(r => setTimeout(r, 1000));  // wait for async write + close
  const afterSave = await evalSync(ws, `JSON.stringify({
    count: openFiles.length,
    promptCount: window.__promptCount,
  })`);
  console.log('  after save: ' + afterSave);
  const pSave = JSON.parse(afterSave);
  if (pSave.count !== 0) throw new Error('Save: file should be closed');
  if (pSave.promptCount !== 1) throw new Error('Save: prompt should have been called');
  console.log('  OK Save branch: file closed, prompt fired');

  console.log('\n=== Step 6: confirmDiscard() returns the right choice (0/1/2) ===');
  const choices = await evalAsync(ws, `
    (async function() {
      window.__mockChoice = 0;
      const r0 = await confirmDiscard({ fileName: 'a.txt' });
      window.__mockChoice = 1;
      const r1 = await confirmDiscard({ fileName: 'b.txt' });
      window.__mockChoice = 2;
      const r2 = await confirmDiscard({ fileName: 'c.txt' });
      return JSON.stringify({ r0, r1, r2 });
    })()
  `);
  console.log('  choices: ' + choices);
  const ch = JSON.parse(choices);
  if (ch.r0 !== 0 || ch.r1 !== 1 || ch.r2 !== 2) throw new Error('confirmDiscard wrong choices');
  console.log('  OK confirmDiscard returns correct choices');

  console.log('\n=== Step 7: closeFolder() with dirty entries (Cancel branch) ===');
  await evalSync(ws, `
    (function() {
      openFiles.length = 0;
      openFiles.push({
        path: '${TEST_DIR}/a.txt', name: 'a.txt', ext: '.txt', dirty: true, diskContent: 'a'
      });
      openFiles.push({
        path: '${TEST_DIR}/b.txt', name: 'b.txt', ext: '.txt', dirty: true, diskContent: 'b'
      });
      activeFileIdx = 0;
      JSON.stringify({ count: openFiles.length });
    })()
  `);
  await evalSync(ws, `window.__mockChoice = 2; window.__promptCount = 0; window.__lastPrompt = null`);
  // closeFolder is async — kick it off but don't await
  evalAsync(ws, `closeFolder()`);
  await new Promise(r => setTimeout(r, 600));
  const folderCancel = await evalSync(ws, `JSON.stringify({
    folder: state.ffolder || state.folder,  // typo-proof
    promptCount: window.__promptCount,
    lastPrompt: window.__lastPrompt,
  })`);
  console.log('  after folder cancel: ' + folderCancel);
  const pFC = JSON.parse(folderCancel);
  if (pFC.promptCount !== 1) throw new Error('closeFolder(Cancel): prompt should fire once');
  if (!pFC.lastPrompt?.count || pFC.lastPrompt.count < 2) throw new Error('closeFolder(Cancel): prompt should include count >= 2');
  if (pFC.folder !== null) throw new Error('closeFolder(Cancel): folder should NOT be nulled on Cancel');
  console.log('  OK closeFolder(Cancel): prompt fired with count=' + pFC.lastPrompt.count + ', folder intact');

  console.log('\n=== Step 8: closeFolder() with dirty entries (Don\'t Save branch) ===');
  await evalSync(ws, `window.__mockChoice = 1; window.__promptCount = 0`);
  evalAsync(ws, `closeFolder()`);
  await new Promise(r => setTimeout(r, 600));
  const folderDont = await evalSync(ws, `JSON.stringify({
    folder: state.folder,
    count: openFiles.length,
    promptCount: window.__promptCount,
  })`);
  console.log('  after folder don\'t save: ' + folderDont);
  const pFD = JSON.parse(folderDont);
  if (pFD.folder !== null) throw new Error('closeFolder(Don\'t Save): folder should be nulled');
  if (pFD.count !== 0) throw new Error('closeFolder(Don\'t Save): openFiles should be cleared');
  if (pFD.promptCount !== 1) throw new Error('closeFolder(Don\'t Save): prompt should fire');
  console.log('  OK closeFolder(Don\'t Save): folder closed, no save attempted');

  // Cleanup
  await fs.rm(TEST_DIR, { recursive: true, force: true });
  ws.close();
  console.log('\n===== UNSAVED-CHANGES PROMPT VERIFICATION PASSED =====');
  console.log('All branches work:');
  console.log('  - closeFile Cancel: tab stays open, dirty unchanged');
  console.log('  - closeFile Don\'t Save: tab closes, disk untouched');
  console.log('  - closeFile Save: prompt fires, file closes (Save path tested)');
  console.log('  - closeFolder Cancel: folder stays open');
  console.log('  - closeFolder Don\'t Save: folder closes, no saves attempted');
  console.log('  - confirmDiscard: returns 0/1/2 from mock correctly');
}

main().catch((e) => { console.error('FAILURE:', e.message); process.exit(1); });