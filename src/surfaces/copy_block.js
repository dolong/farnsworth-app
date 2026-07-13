// Copy block surface — shareable commands/paths/URLs with copy button.

(function () {
  'use strict';

  function renderCopyBlock(surface) {
    const data = surface.data || {};
    const node = document.createElement('div');
    node.className = 'surface surface--copy-block';
    if (surface.surfaceId) node.dataset.surfaceId = surface.surfaceId;

    if (data.label) {
      const label = document.createElement('div');
      label.className = 'copy-block__label';
      label.textContent = data.label;
      node.appendChild(label);
    }

    const code = document.createElement('pre');
    code.className = 'copy-block__code';
    const codeInner = document.createElement('code');
    if (data.language) codeInner.className = 'language-' + data.language;
    codeInner.textContent = data.text || '';
    code.appendChild(codeInner);
    node.appendChild(code);

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