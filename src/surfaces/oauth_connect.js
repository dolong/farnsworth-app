// OAuth connect surface — managed OAuth CTA card. Clicking Connect calls
// window.farnsworth.oauthStart (existing IPC for Claude.ai OAuth) and shows
// status feedback. The actual auth flow happens via the existing
// oauthStart / oauthWaitForCallback / oauthComplete chain in main.js.
//
// Data shape:
//   { providerKey, displayName, description?, logoUrl?, scope?, ctaLabel? }

(function () {
  'use strict';

  function renderOAuthConnect(surface) {
    const data = surface.data || {};
    const node = document.createElement('div');
    node.className = 'surface surface--oauth-connect';
    if (surface.surfaceId) node.dataset.surfaceId = surface.surfaceId;

    // Header — logo + title
    const header = document.createElement('div');
    header.className = 'oauth-connect__header';

    if (data.logoUrl) {
      const logo = document.createElement('img');
      logo.className = 'oauth-connect__logo';
      logo.src = data.logoUrl;
      logo.alt = '';
      header.appendChild(logo);
    }

    const title = document.createElement('div');
    title.className = 'oauth-connect__title';
    title.textContent = data.displayName || 'Connect';
    header.appendChild(title);
    node.appendChild(header);

    if (data.description) {
      const desc = document.createElement('div');
      desc.className = 'oauth-connect__description';
      desc.textContent = data.description;
      node.appendChild(desc);
    }

    // Action row — connect button + status
    const actions = document.createElement('div');
    actions.className = 'oauth-connect__actions';

    const connectBtn = document.createElement('button');
    connectBtn.type = 'button';
    connectBtn.className = 'oauth-connect__cta';
    connectBtn.textContent = data.ctaLabel || ('Connect ' + (data.displayName || 'account'));
    actions.appendChild(connectBtn);

    const status = document.createElement('span');
    status.className = 'oauth-connect__status';
    actions.appendChild(status);
    node.appendChild(actions);

    connectBtn.addEventListener('click', async () => {
      connectBtn.disabled = true;
      status.textContent = 'Opening browser…';
      status.className = 'oauth-connect__status';
      try {
        const result = await window.farnsworth.oauthStart();
        if (result.ok) {
          status.textContent = 'Browser opened. ' + (result.instructions || 'Complete the flow and return.');
          status.className = 'oauth-connect__status oauth-connect__status--ok';
          // Dispatch action — main-side will wait for callback via oauthWaitForCallback
          if (window.__onSurfaceAction) {
            window.__onSurfaceAction(surface, {
              id: 'oauth-start',
              syntheticTurn: '[Started OAuth flow for ' + (data.displayName || 'service') + ']',
              surfaceData: { providerKey: data.providerKey, state: result.state, authUrl: result.authUrl },
            });
          }
        } else {
          status.textContent = 'Failed: ' + (result.error || 'unknown');
          status.className = 'oauth-connect__status oauth-connect__status--error';
          connectBtn.disabled = false;
        }
      } catch (e) {
        status.textContent = 'Error: ' + e.message;
        status.className = 'oauth-connect__status oauth-connect__status--error';
        connectBtn.disabled = false;
      }
    });

    return node;
  }

  window.FarnsworthSurfaces._register('oauth_connect', renderOAuthConnect);
})();