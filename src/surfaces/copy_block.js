// Copy block surface — shareable commands/paths/URLs with copy button.

(function () {
  'use strict';

  function renderCopyBlock(surface) {
    const data = surface.data || {};
    const text = (data.text || '').trim();
    const label = data.label || '';
    // Skip empty copy_blocks (Long reported an agent that emitted an empty
    // copy_block surface, which rendered as a phantom rectangle with a Copy
    // button and nothing in it). Nothing useful to render if both text and
    // label are blank.
    if (!text && !label) return null;

    const node = document.createElement('div');
    node.className = 'surface surface--copy-block';
    if (surface.surfaceId) node.dataset.surfaceId = surface.surfaceId;

    if (label) {
      const labelEl = document.createElement('div');
      labelEl.className = 'copy-block__label';
      labelEl.textContent = label;
      node.appendChild(labelEl);
    }

    if (text) {
      const code = document.createElement('pre');
      code.className = 'copy-block__code';
      const codeInner = document.createElement('code');
      if (data.language) codeInner.className = 'language-' + data.language;
      codeInner.textContent = data.text;
      code.appendChild(codeInner);
      node.appendChild(code);
    }

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'copy-block__copy';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(data.text || '');
        copyBtn.textContent = 'Copied';
        setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1200);
      } catch (e) {
        console.warn('[copy-block] clipboard write failed:', e);
        copyBtn.textContent = 'Failed';
      }
    });
    node.appendChild(copyBtn);

    return node;
  }

  window.FarnsworthSurfaces._register('copy_block', renderCopyBlock);
})();