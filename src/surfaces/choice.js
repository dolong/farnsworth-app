// Choice surface — single or multi-select buttons.

(function () {
  'use strict';

  function buildUserText(data, value, label) {
    if (Array.isArray(value)) {
      if (value.length === 0) return '[choice] (no selection)';
      const labels = value.map(id => {
        const opt = (data.options || []).find(o => o.id === id);
        return opt ? (id + ' (' + opt.label + ')') : id;
      });
      return '[choice] selected: ' + labels.join(', ');
    }
    return label ? ('[choice:' + value + '] ' + label) : ('[choice:' + value + ']');
  }

  function renderChoice(surface) {
    const data = surface.data || {};
    const node = document.createElement('div');
    node.className = 'surface surface--choice';
    if (surface.surfaceId) node.dataset.surfaceId = surface.surfaceId;

    if (data.description) {
      const desc = document.createElement('div');
      desc.className = 'choice__description';
      desc.textContent = data.description;
      node.appendChild(desc);
    }

    const options = Array.isArray(data.options) ? data.options : [];
    const isMulti = data.selectionMode === 'multiple';
    const selected = new Set();

    const optionsWrap = document.createElement('div');
    optionsWrap.className = 'choice__options';

    for (const opt of options) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'choice__option';
      btn.dataset.optionId = opt.id || '';
      if (opt.description) btn.title = opt.description;
      if (opt.recommended) btn.classList.add('choice__option--recommended');

      const label = document.createElement('span');
      label.className = 'choice__option-label';
      label.textContent = opt.label || opt.id || '';
      btn.appendChild(label);

      if (opt.description) {
        const desc = document.createElement('span');
        desc.className = 'choice__option-desc';
        desc.textContent = opt.description;
        btn.appendChild(desc);
      }

      btn.addEventListener('click', () => {
        if (isMulti) {
          if (selected.has(opt.id)) {
            selected.delete(opt.id);
            btn.classList.remove('choice__option--selected');
          } else {
            selected.add(opt.id);
            btn.classList.add('choice__option--selected');
          }
        } else {
          window.FarnsworthSurfaces.onSurfaceAction(surface, {
            kind: 'synthetic-turn',
            userText: buildUserText(data, opt.id, opt.label),
          });
        }
      });

      optionsWrap.appendChild(btn);
    }
    node.appendChild(optionsWrap);

    if (isMulti) {
      const submit = document.createElement('button');
      submit.type = 'button';
      submit.className = 'choice__submit';
      submit.textContent = data.submitLabel || 'Continue';
      submit.addEventListener('click', () => {
        window.FarnsworthSurfaces.onSurfaceAction(surface, {
          kind: 'synthetic-turn',
          userText: buildUserText(data, Array.from(selected), null),
        });
      });
      node.appendChild(submit);
    }

    return node;
  }

  window.FarnsworthSurfaces._register('choice', renderChoice);
})();