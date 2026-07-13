// ============================================================================
// Surfaces — inline UI surfaces rendered inside the chat stream.
//
// Plain script (not ES module) — matches the rest of Farnsworth's renderer.
// All surfaces register themselves on window.FarnsworthSurfaces, which
// app.js calls into when it intercepts a ui_show tool call.
//
// API:
//   FarnsworthSurfaces.render(surface, ctx) -> DOM node
//   FarnsworthSurfaces.hasSurface(type) -> bool
//   FarnsworthSurfaces.onSurfaceAction(surface, action) -> dispatches via window.__onSurfaceAction
// ============================================================================

(function () {
  'use strict';

  const registry = {};

  function render(surface, ctx) {
    const renderFn = registry[surface.surfaceType];
    if (!renderFn) {
      const node = document.createElement('div');
      node.className = 'surface surface--unknown';
      node.textContent = '[Unknown surface type: ' + (surface.surfaceType || '') + ']';
      return node;
    }
    return renderFn(surface, ctx);
  }

  function hasSurface(type) {
    return !!registry[type];
  }

  function onSurfaceAction(surface, action) {
    if (window.__surfaceRegistry) window.__surfaceRegistry[surface.surfaceId || surface._id] = surface;
    if (window.__onSurfaceAction) {
      window.__onSurfaceAction(surface, action);
    } else {
      console.warn('[surface] No action handler registered for surface action:', action);
    }
  }

  window.FarnsworthSurfaces = {
    _registry: registry,
    render: render,
    hasSurface: hasSurface,
    onSurfaceAction: onSurfaceAction,
    // Surfaces call this from their own IIFEs to register their render fn.
    _register: function (type, fn) { registry[type] = fn; },
  };
})();