// Form surface — multi-field input (settings, config, one-off prompts).
// Supports field types: text, textarea, select, toggle, number, password.
// On submit, dispatches a synthetic-turn message with the field values
// formatted as JSON. Values are NOT stored in chat history beyond the
// single submit message.
//
// Data shape:
//   { description?, fields: [...], submitLabel?, cancelLabel? }
//   each field:
//     { id, label, type, default?, options?, placeholder?, required? }
//   type ∈ 'text' | 'textarea' | 'select' | 'toggle' | 'number' | 'password'

(function () {
  'use strict';

  function buildField(field, surface) {
    const wrap = document.createElement('div');
    wrap.className = 'form__field form__field--' + (field.type || 'text');
    wrap.dataset.fieldId = field.id;

    const label = document.createElement('label');
    label.className = 'form__label';
    label.textContent = field.label || field.id;
    if (field.required) {
      const req = document.createElement('span');
      req.className = 'form__required';
      req.textContent = ' *';
      label.appendChild(req);
    }
    wrap.appendChild(label);

    let input;

    if (field.type === 'textarea') {
      input = document.createElement('textarea');
      input.className = 'form__textarea';
      input.placeholder = field.placeholder || '';
      input.value = field.default != null ? String(field.default) : '';
      input.rows = field.rows || 3;
    } else if (field.type === 'select') {
      input = document.createElement('select');
      input.className = 'form__select';
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = field.placeholder || 'Select…';
      placeholder.disabled = true;
      placeholder.selected = field.default == null;
      input.appendChild(placeholder);
      for (const opt of (field.options || [])) {
        const option = document.createElement('option');
        option.value = String(opt.value != null ? opt.value : opt);
        option.textContent = opt.label != null ? opt.label : String(opt);
        if (field.default != null && String(field.default) === option.value) {
          option.selected = true;
          placeholder.selected = false;
        }
        input.appendChild(option);
      }
    } else if (field.type === 'toggle') {
      input = document.createElement('input');
      input.type = 'checkbox';
      input.className = 'form__toggle';
      input.checked = !!field.default;
      wrap.classList.add('form__field--toggle-wrap');
    } else if (field.type === 'number') {
      input = document.createElement('input');
      input.type = 'number';
      input.className = 'form__input';
      input.placeholder = field.placeholder || '';
      if (field.default != null) input.value = String(field.default);
      if (field.min != null) input.min = String(field.min);
      if (field.max != null) input.max = String(field.max);
      if (field.step != null) input.step = String(field.step);
    } else if (field.type === 'password') {
      input = document.createElement('input');
      input.type = 'password';
      input.className = 'form__input';
      input.placeholder = field.placeholder || '';
      input.autocomplete = 'off';
      if (field.default != null) input.value = String(field.default);
    } else {
      // text (default)
      input = document.createElement('input');
      input.type = 'text';
      input.className = 'form__input';
      input.placeholder = field.placeholder || '';
      if (field.default != null) input.value = String(field.default);
    }

    wrap.appendChild(input);

    if (field.help) {
      const help = document.createElement('div');
      help.className = 'form__help';
      help.textContent = field.help;
      wrap.appendChild(help);
    }

    return { wrap, input };
  }

  function collectValues(fields) {
    const out = {};
    for (const { wrap, input } of fields) {
      const id = wrap.dataset.fieldId;
      if (input.type === 'checkbox') {
        out[id] = input.checked;
      } else if (input.tagName === 'SELECT') {
        out[id] = input.value;
      } else {
        out[id] = input.value;
      }
    }
    return out;
  }

  function renderForm(surface) {
    const data = surface.data || {};
    const node = document.createElement('div');
    node.className = 'surface surface--form';
    if (surface.surfaceId) node.dataset.surfaceId = surface.surfaceId;

    if (data.description) {
      const desc = document.createElement('div');
      desc.className = 'form__description';
      desc.textContent = data.description;
      node.appendChild(desc);
    }

    const fields = (data.fields || []).map(f => buildField(f, surface));
    const body = document.createElement('div');
    body.className = 'form__body';
    for (const { wrap } of fields) body.appendChild(wrap);
    node.appendChild(body);

    const actions = document.createElement('div');
    actions.className = 'form__actions';

    const submit = document.createElement('button');
    submit.type = 'button';
    submit.className = 'form__submit';
    submit.textContent = data.submitLabel || 'Submit';
    actions.appendChild(submit);

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'form__cancel';
    cancel.textContent = data.cancelLabel || 'Cancel';
    if (!data.showCancel) cancel.style.display = 'none';
    actions.appendChild(cancel);

    const status = document.createElement('span');
    status.className = 'form__status';
    actions.appendChild(status);
    node.appendChild(actions);

    submit.addEventListener('click', () => {
      const values = collectValues(fields);
      // Validate required
      const missing = [];
      for (const f of (data.fields || [])) {
        if (f.required) {
          const v = values[f.id];
          if (v == null || v === '' || (typeof v === 'string' && v.trim() === '')) {
            missing.push(f.label || f.id);
          }
        }
      }
      if (missing.length > 0) {
        status.textContent = 'Required: ' + missing.join(', ');
        status.className = 'form__status form__status--error';
        return;
      }
      submit.disabled = true;
      status.textContent = 'Submitting…';
      status.className = 'form__status';

      // Dispatch synthetic-turn with the form values
      if (window.__onSurfaceAction) {
        window.__onSurfaceAction(surface, {
          id: 'form-submit',
          syntheticTurn: '[Form submitted: ' + JSON.stringify(values) + ']',
          surfaceData: { fieldValues: values, formId: data.formId },
        });
      }
      status.textContent = 'Submitted';
      status.className = 'form__status form__status--ok';
    });

    cancel.addEventListener('click', () => {
      if (window.__onSurfaceAction) {
        window.__onSurfaceAction(surface, {
          id: 'form-cancel',
          syntheticTurn: '[Form cancelled]',
        });
      }
    });

    return node;
  }

  window.FarnsworthSurfaces._register('form', renderForm);
})();