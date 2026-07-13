// file_change surface — shows what Claude just edited to a file. Replaces the
// current "files changed" chip with a real inline diff. Designed for the case
// where one edit = one card; if you need many files, emit multiple cards.
//
// Data shape:
//   { file, operation, diff, summary }
//   operation: 'edit' | 'create' | 'delete' | 'rename'
//   diff: array of { type: 'context' | 'add' | 'remove', text, line? }
//   summary: optional one-line description of the change

(function () {
  'use strict';

  const OP_LABEL = {
    edit: 'Edited',
    create: 'Created',
    delete: 'Deleted',
    rename: 'Renamed',
  };

  function renderFileChange(surface) {
    const data = surface.data || {};
    const node = document.createElement('div');
    node.className = 'surface surface--file-change surface--file-change--' + (data.operation || 'edit');
    if (surface.surfaceId) node.dataset.surfaceId = surface.surfaceId;

    // Header — file path + operation badge
    const header = document.createElement('div');
    header.className = 'file-change__header';

    const opBadge = document.createElement('span');
    opBadge.className = 'file-change__op file-change__op--' + (data.operation || 'edit');
    opBadge.textContent = OP_LABEL[data.operation || 'edit'] || data.operation || 'Edit';
    header.appendChild(opBadge);

    const path = document.createElement('span');
    path.className = 'file-change__path';
    path.textContent = data.file || '(unknown file)';
    path.title = data.file || '';
    header.appendChild(path);

    node.appendChild(header);

    // Summary (optional one-line description)
    if (data.summary) {
      const summary = document.createElement('div');
      summary.className = 'file-change__summary';
      summary.textContent = data.summary;
      node.appendChild(summary);
    }

    // Diff body (only when there are diff lines)
    if (Array.isArray(data.diff) && data.diff.length) {
      const body = document.createElement('div');
      body.className = 'file-change__body';
      let added = 0;
      let removed = 0;
      for (const line of data.diff) {
        const row = document.createElement('div');
        row.className = 'file-change__line file-change__line--' + (line.type || 'context');
        const marker = document.createElement('span');
        marker.className = 'file-change__marker';
        marker.textContent = line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' ';
        row.appendChild(marker);
        const text = document.createElement('span');
        text.className = 'file-change__text';
        text.textContent = line.text || '';
        row.appendChild(text);
        body.appendChild(row);
        if (line.type === 'add') added++;
        else if (line.type === 'remove') removed++;
      }
      node.appendChild(body);

      // Stats footer — +N −M
      const stats = document.createElement('div');
      stats.className = 'file-change__stats';
      const addedEl = document.createElement('span');
      addedEl.className = 'file-change__stat file-change__stat--add';
      addedEl.textContent = '+' + added;
      stats.appendChild(addedEl);
      const removedEl = document.createElement('span');
      removedEl.className = 'file-change__stat file-change__stat--remove';
      removedEl.textContent = '−' + removed;
      stats.appendChild(removedEl);
      node.appendChild(stats);
    }

    return node;
  }

  window.FarnsworthSurfaces._register('file_change', renderFileChange);
})();