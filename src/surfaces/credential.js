// Credential surface — secure secret entry. Captures an API key / token via
// password input, stores it in the OS keychain via credential:promptSecret.
//
// SECURITY: the secret value is never written to chat history. On submit:
//   1. Renderer reads the input value
//   2. Calls window.farnsworth.credentialPromptSecret({service, account, value})
//   3. Main stores via keytar
//   4. Renderer emits a synthetic-turn confirmation that names the service
//      but NOT the value.
//
// Data shape:
//   { service, account?, label, description?, placeholder?, remember? }
//   service:   keychain service name (required)
//   account:   keychain account (optional, defaults to 'farnsworth')
//   label:     human-readable label (required)
//   remember:  if true, persist; if false, ephemeral (still keychain-stored for the session)

(function () {
  'use strict';

  function renderCredential(surface) {
    const data = surface.data || {};
    const node = document.createElement('div');
    node.className = 'surface surface--credential';
    if (surface.surfaceId) node.dataset.surfaceId = surface.surfaceId;

    // Header — label + service hint
    const header = document.createElement('div');
    header.className = 'credential__header';
    const label = document.createElement('div');
    label.className = 'credential__label';
    label.textContent = data.label || 'Credential';
    header.appendChild(label);
    if (data.service) {
      const serviceTag = document.createElement('span');
      serviceTag.className = 'credential__service';
      serviceTag.textContent = data.service;
      header.appendChild(serviceTag);
    }
    node.appendChild(header);

    if (data.description) {
      const desc = document.createElement('div');
      desc.className = 'credential__description';
      desc.textContent = data.description;
      node.appendChild(desc);
    }

    // Input form
    const form = document.createElement('div');
    form.className = 'credential__form';

    const inputWrap = document.createElement('div');
    inputWrap.className = 'credential__input-wrap';
    const input = document.createElement('input');
    input.type = 'password';
    input.className = 'credential__input';
    input.placeholder = data.placeholder || 'Paste secret value';
    input.autocomplete = 'off';
    input.spellcheck = false;
    inputWrap.appendChild(input);

    // Reveal toggle
    const revealBtn = document.createElement('button');
    revealBtn.type = 'button';
    revealBtn.className = 'credential__reveal';
    revealBtn.textContent = '👁';
    revealBtn.title = 'Reveal value';
    revealBtn.addEventListener('click', () => {
      input.type = input.type === 'password' ? 'text' : 'password';
      revealBtn.textContent = input.type === 'password' ? '👁' : '🙈';
    });
    inputWrap.appendChild(revealBtn);
    form.appendChild(inputWrap);

    // Submit + status row
    const actions = document.createElement('div');
    actions.className = 'credential__actions';
    const submit = document.createElement('button');
    submit.type = 'button';
    submit.className = 'credential__submit';
    submit.textContent = data.submitLabel || 'Save to keychain';
    submit.addEventListener('click', async () => {
      const value = input.value;
      if (!value) {
        status.textContent = 'Enter a value first.';
        status.className = 'credential__status credential__status--error';
        return;
      }
      submit.disabled = true;
      status.textContent = 'Saving…';
      status.className = 'credential__status';
      try {
        const result = await window.farnsworth.credentialPromptSecret({
          service: data.service,
          account: data.account || 'farnsworth',
          value,
        });
        if (result.ok) {
          status.textContent = 'Saved to keychain (service: ' + result.service + ')';
          status.className = 'credential__status credential__status--ok';
          // Wipe the in-memory value
          input.value = '';
          // Dispatch synthetic-turn confirmation (no secret value in chat history)
          if (window.__onSurfaceAction) {
            window.__onSurfaceAction(surface, {
              id: 'credential-submit',
              syntheticTurn: '[Stored credential for ' + (data.label || data.service) + ']',
              surfaceData: { service: data.service, account: data.account || 'farnsworth' },
            });
          }
        } else {
          status.textContent = 'Save failed: ' + (result.error || 'unknown');
          status.className = 'credential__status credential__status--error';
          submit.disabled = false;
        }
      } catch (e) {
        status.textContent = 'Error: ' + e.message;
        status.className = 'credential__status credential__status--error';
        submit.disabled = false;
      }
    });
    actions.appendChild(submit);

    const status = document.createElement('span');
    status.className = 'credential__status';
    actions.appendChild(status);
    form.appendChild(actions);

    // Optional "delete stored" button
    if (data.allowDelete) {
      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'credential__delete';
      deleteBtn.textContent = 'Delete stored secret';
      deleteBtn.addEventListener('click', async () => {
        const result = await window.farnsworth.credentialDeleteSecret({
          service: data.service,
          account: data.account || 'farnsworth',
        });
        status.textContent = result.removed ? 'Deleted.' : (result.ok ? 'No stored value to delete.' : 'Delete failed: ' + result.error);
        status.className = 'credential__status' + (result.ok ? ' credential__status--ok' : ' credential__status--error');
      });
      form.appendChild(deleteBtn);
    }

    node.appendChild(form);

    // Security footer
    const footer = document.createElement('div');
    footer.className = 'credential__footer';
    footer.textContent = '🔒 Stored in OS keychain. Not saved to chat history.';
    node.appendChild(footer);

    return node;
  }

  window.FarnsworthSurfaces._register('credential', renderCredential);
})();