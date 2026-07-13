// live_preview surface — embeds an iframe preview in the chat stream.
// Used when Claude boots a dev server, generates an artifact, or has an
// external URL to show. Auto-refresh is opt-in.
//
// Data shape:
//   { url, title?, height?, autoRefresh? }

(function () {
  'use strict';

  function renderLivePreview(surface) {
    const data = surface.data || {};
    const node = document.createElement('div');
    node.className = 'surface surface--live-preview';
    if (surface.surfaceId) node.dataset.surfaceId = surface.surfaceId;

    if (data.title) {
      const title = document.createElement('div');
      title.className = 'live-preview__title';
      title.textContent = data.title;
      node.appendChild(title);
    }

    const frameWrap = document.createElement('div');
    frameWrap.className = 'live-preview__frame-wrap';
    if (data.height) frameWrap.style.height = (typeof data.height === 'number' ? data.height + 'px' : data.height);

    if (data.url) {
      const frame = document.createElement('iframe');
      frame.className = 'live-preview__frame';
      frame.src = data.url;
      frame.title = data.title || 'Live preview';
      // Sandboxed: same-origin so the iframe can run its own JS, but no top-level nav.
      frame.sandbox = 'allow-scripts allow-same-origin allow-forms';
      frameWrap.appendChild(frame);
    } else {
      const empty = document.createElement('div');
      empty.className = 'live-preview__empty';
      empty.textContent = '(no preview URL)';
      frameWrap.appendChild(empty);
    }
    node.appendChild(frameWrap);

    // Optional refresh button
    if (data.autoRefresh) {
      const footer = document.createElement('div');
      footer.className = 'live-preview__footer';
      const refresh = document.createElement('button');
      refresh.type = 'button';
      refresh.className = 'live-preview__refresh';
      refresh.textContent = '↻ Refresh';
      refresh.addEventListener('click', () => {
        const iframe = node.querySelector('iframe');
        if (iframe) iframe.src = data.url;
      });
      footer.appendChild(refresh);
      node.appendChild(footer);
    }

    return node;
  }

  window.FarnsworthSurfaces._register('live_preview', renderLivePreview);
})();