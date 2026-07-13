// memory_recall surface — shows what memory recall returned for the current
// turn. Used for transparency — the user can see which facts / concepts /
// code snippets influenced the response.
//
// Data shape:
//   { query, essentials?, concepts?, code?, buffer? }
//   concepts: [{ title, summary, source? }]
//   code: [{ file, snippet, language? }]

(function () {
  'use strict';

  function section(title, count) {
    const head = document.createElement('div');
    head.className = 'memory-recall__section-head';
    const label = document.createElement('span');
    label.className = 'memory-recall__section-title';
    label.textContent = title;
    head.appendChild(label);
    if (count != null) {
      const badge = document.createElement('span');
      badge.className = 'memory-recall__count';
      badge.textContent = count;
      head.appendChild(badge);
    }
    return head;
  }

  function renderMemoryRecall(surface) {
    const data = surface.data || {};
    const node = document.createElement('div');
    node.className = 'surface surface--memory-recall';
    if (surface.surfaceId) node.dataset.surfaceId = surface.surfaceId;

    // Header — query + summary
    const header = document.createElement('div');
    header.className = 'memory-recall__header';
    const eyebrow = document.createElement('span');
    eyebrow.className = 'memory-recall__eyebrow';
    eyebrow.textContent = 'Memory recall';
    header.appendChild(eyebrow);
    if (data.query) {
      const query = document.createElement('div');
      query.className = 'memory-recall__query';
      query.textContent = '"' + data.query + '"';
      header.appendChild(query);
    }
    node.appendChild(header);

    // Essentials — bullets
    if (Array.isArray(data.essentials) && data.essentials.length) {
      node.appendChild(section('Essentials', data.essentials.length));
      const list = document.createElement('ul');
      list.className = 'memory-recall__essentials';
      for (const e of data.essentials) {
        const li = document.createElement('li');
        li.textContent = e;
        list.appendChild(li);
      }
      node.appendChild(list);
    }

    // Concepts — title + summary cards
    if (Array.isArray(data.concepts) && data.concepts.length) {
      node.appendChild(section('Concepts', data.concepts.length));
      const list = document.createElement('div');
      list.className = 'memory-recall__concepts';
      for (const c of data.concepts) {
        const card = document.createElement('div');
        card.className = 'memory-recall__concept';
        const title = document.createElement('div');
        title.className = 'memory-recall__concept-title';
        title.textContent = c.title || c.name || '(untitled)';
        card.appendChild(title);
        if (c.summary) {
          const sum = document.createElement('div');
          sum.className = 'memory-recall__concept-summary';
          sum.textContent = c.summary;
          card.appendChild(sum);
        }
        if (c.source) {
          const src = document.createElement('div');
          src.className = 'memory-recall__concept-source';
          src.textContent = c.source;
          card.appendChild(src);
        }
        list.appendChild(card);
      }
      node.appendChild(list);
    }

    // Code — file + snippet
    if (Array.isArray(data.code) && data.code.length) {
      node.appendChild(section('Code', data.code.length));
      const list = document.createElement('div');
      list.className = 'memory-recall__code';
      for (const c of data.code) {
        const block = document.createElement('div');
        block.className = 'memory-recall__code-block';
        const file = document.createElement('div');
        file.className = 'memory-recall__code-file';
        file.textContent = c.file || '(no file)';
        block.appendChild(file);
        if (c.snippet) {
          const pre = document.createElement('pre');
          pre.className = 'memory-recall__code-snippet';
          if (c.language) pre.dataset.language = c.language;
          pre.textContent = c.snippet;
          block.appendChild(pre);
        }
        list.appendChild(block);
      }
      node.appendChild(list);
    }

    // Buffer — short list of recent items
    if (Array.isArray(data.buffer) && data.buffer.length) {
      node.appendChild(section('Recent', data.buffer.length));
      const list = document.createElement('ul');
      list.className = 'memory-recall__buffer';
      for (const b of data.buffer) {
        const li = document.createElement('li');
        li.textContent = b;
        list.appendChild(li);
      }
      node.appendChild(list);
    }

    return node;
  }

  window.FarnsworthSurfaces._register('memory_recall', renderMemoryRecall);
})();