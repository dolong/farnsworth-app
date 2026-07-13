// Work result surface — structured receipt after real work. Supports
// streaming updates via surfaceId (re-emit with same id replaces in place).

(function () {
  'use strict';

  function toneClass(tone) {
    return 'work-result__tone--' + (tone || 'neutral');
  }

  function renderWorkResult(surface) {
    const data = surface.data || {};
    const node = document.createElement('div');
    node.className = 'surface surface--work-result surface--work-result--' + (data.status || 'completed');
    if (surface.surfaceId) node.dataset.surfaceId = surface.surfaceId;

    const header = document.createElement('div');
    header.className = 'work-result__header';

    if (data.eyebrow) {
      const eyebrow = document.createElement('span');
      eyebrow.className = 'work-result__eyebrow';
      eyebrow.textContent = data.eyebrow;
      header.appendChild(eyebrow);
    }

    if (data.summary) {
      const summary = document.createElement('div');
      summary.className = 'work-result__summary';
      summary.textContent = data.summary;
      header.appendChild(summary);
    }

    const badge = document.createElement('span');
    badge.className = 'work-result__status work-result__status--' + (data.status || 'completed');
    badge.textContent =
      data.status === 'failed' ? 'Failed' :
      data.status === 'partial' ? 'Partial' :
      data.status === 'in_progress' ? 'Working' :
      'Completed';
    header.appendChild(badge);

    node.appendChild(header);

    if (Array.isArray(data.metrics) && data.metrics.length) {
      const metrics = document.createElement('div');
      metrics.className = 'work-result__metrics';
      for (const m of data.metrics) {
        const cell = document.createElement('div');
        cell.className = 'work-result__metric ' + toneClass(m.tone);
        const label = document.createElement('div');
        label.className = 'work-result__metric-label';
        label.textContent = m.label;
        const value = document.createElement('div');
        value.className = 'work-result__metric-value';
        value.textContent = m.value;
        cell.appendChild(label); cell.appendChild(value);
        if (m.detail) {
          const detail = document.createElement('div');
          detail.className = 'work-result__metric-detail';
          detail.textContent = m.detail;
          cell.appendChild(detail);
        }
        metrics.appendChild(cell);
      }
      node.appendChild(metrics);
    }

    if (Array.isArray(data.sections)) {
      for (const section of data.sections) {
        const sect = document.createElement('div');
        sect.className = 'work-result__section';
        if (section.title) {
          const t = document.createElement('div');
          t.className = 'work-result__section-title';
          t.textContent = section.title;
          sect.appendChild(t);
        }
        if (section.type === 'items' && Array.isArray(section.items)) {
          const list = document.createElement('div');
          list.className = 'work-result__items';
          for (const item of section.items) {
            const row = document.createElement('div');
            row.className = 'work-result__item ' + (item.tone ? 'work-result__item--' + item.tone : '');
            const title = document.createElement('div');
            title.className = 'work-result__item-title';
            title.textContent = item.title || '';
            row.appendChild(title);
            if (item.description) {
              const desc = document.createElement('div');
              desc.className = 'work-result__item-desc';
              desc.textContent = item.description;
              row.appendChild(desc);
            }
            list.appendChild(row);
          }
          sect.appendChild(list);
        }
        node.appendChild(sect);
      }
    }

    return node;
  }

  window.FarnsworthSurfaces._register('work_result', renderWorkResult);
})();