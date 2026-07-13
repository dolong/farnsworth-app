// Confirmation surface — yes/no for destructive or important ops.

(function () {
  'use strict';

  function renderConfirmation(surface) {
    const data = surface.data || {};
    const node = document.createElement('div');
    node.className = 'surface surface--confirmation';
    if (data.destructive) node.classList.add('surface--confirmation--destructive');
    if (surface.surfaceId) node.dataset.surfaceId = surface.surfaceId;

    const message = document.createElement('div');
    message.className = 'confirmation__message';
    message.textContent = data.message || 'Are you sure?';
    node.appendChild(message);

    if (data.detail) {
      const detail = document.createElement('div');
      detail.className = 'confirmation__detail';
      detail.textContent = data.detail;
      node.appendChild(detail);
    }

    const buttons = document.createElement('div');
    buttons.className = 'confirmation__buttons';

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'confirmation__button confirmation__button--cancel';
    cancel.textContent = data.cancelLabel || 'Cancel';
    cancel.addEventListener('click', () => {
      window.FarnsworthSurfaces.onSurfaceAction(surface, {
        kind: 'synthetic-turn', userText: '[confirmation] cancelled',
      });
    });
    buttons.appendChild(cancel);

    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'confirmation__button ' + (data.destructive
      ? 'confirmation__button--destructive'
      : 'confirmation__button--confirm');
    confirm.textContent = data.confirmLabel || 'Confirm';
    confirm.addEventListener('click', () => {
      window.FarnsworthSurfaces.onSurfaceAction(surface, {
        kind: 'synthetic-turn', userText: '[confirmation] confirmed',
      });
    });
    buttons.appendChild(confirm);

    node.appendChild(buttons);
    return node;
  }

  window.FarnsworthSurfaces._register('confirmation', renderConfirmation);
})();