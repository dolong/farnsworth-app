// Card surface — generic card with optional templates.
// Templates: task_progress (step tracker) or plain (title + subtitle + body + metadata).

(function () {
  'use strict';

  function renderTaskProgress(data) {
    const node = document.createElement('div');
    node.className = 'surface surface--card surface--task-progress';

    const template = data.templateData || {};
    const steps = Array.isArray(template.steps) ? template.steps : [];
    const status = template.status || 'in_progress';

    const titleRow = document.createElement('div');
    titleRow.className = 'task-progress__title';
    const titleText = document.createElement('span');
    titleText.className = 'task-progress__title-text';
    titleText.textContent = template.title || data.title || 'Working';
    titleRow.appendChild(titleText);

    const statusPill = document.createElement('span');
    statusPill.className = 'task-progress__status task-progress__status--' + status;
    statusPill.textContent =
      status === 'completed' ? 'Done' :
      status === 'failed' ? 'Failed' :
      status === 'partial' ? 'Partial' :
      'In progress';
    titleRow.appendChild(statusPill);
    node.appendChild(titleRow);

    if (steps.length) {
      const list = document.createElement('ol');
      list.className = 'task-progress__steps';
      for (const step of steps) {
        const li = document.createElement('li');
        li.className = 'task-progress__step task-progress__step--' + (step.status || 'pending');
        const indicator = document.createElement('span');
        indicator.className = 'task-progress__indicator';
        li.appendChild(indicator);
        const label = document.createElement('span');
        label.className = 'task-progress__label';
        label.textContent = step.label || '';
        li.appendChild(label);
        if (step.detail) {
          const detail = document.createElement('span');
          detail.className = 'task-progress__detail';
          detail.textContent = step.detail;
          li.appendChild(detail);
        }
        list.appendChild(li);
      }
      node.appendChild(list);
    }

    return node;
  }

  function renderCard(surface) {
    const data = surface.data || {};
    if (data.template === 'task_progress') {
      return renderTaskProgress(data);
    }
    const node = document.createElement('div');
    node.className = 'surface surface--card';
    if (data.title) {
      const title = document.createElement('div');
      title.className = 'card__title';
      title.textContent = data.title;
      node.appendChild(title);
    }
    if (data.subtitle) {
      const subtitle = document.createElement('div');
      subtitle.className = 'card__subtitle';
      subtitle.textContent = data.subtitle;
      node.appendChild(subtitle);
    }
    if (data.body) {
      const body = document.createElement('div');
      body.className = 'card__body';
      if (typeof data.body === 'string') body.textContent = data.body;
      else body.appendChild(data.body);
      node.appendChild(body);
    }
    if (Array.isArray(data.metadata)) {
      const meta = document.createElement('div');
      meta.className = 'card__metadata';
      for (const m of data.metadata) {
        const row = document.createElement('div');
        row.className = 'card__metadata-row';
        const label = document.createElement('span');
        label.className = 'card__metadata-label';
        label.textContent = m.label;
        const value = document.createElement('span');
        value.className = 'card__metadata-value';
        value.textContent = m.value;
        row.appendChild(label); row.appendChild(value);
        meta.appendChild(row);
      }
      node.appendChild(meta);
    }
    return node;
  }

  window.FarnsworthSurfaces._register('card', renderCard);
})();