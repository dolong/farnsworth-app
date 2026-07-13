// test_status surface — shows test run results inline. Used when Claude runs
// tests (mocha, jest, vitest, etc.) and wants to summarize the outcome.
//
// Data shape:
//   { total, passed, failed, skipped, duration_ms,
//     tests?: [{ name, status, duration_ms?, message? }] }

(function () {
  'use strict';

  function statusIcon(status) {
    if (status === 'passed') return '✓';
    if (status === 'failed') return '✗';
    if (status === 'skipped') return '~';
    return '?';
  }

  function renderTestStatus(surface) {
    const data = surface.data || {};
    const node = document.createElement('div');
    node.className = 'surface surface--test-status';
    if (surface.surfaceId) node.dataset.surfaceId = surface.surfaceId;

    // Summary row — totals as big numbers with pass/fail/skip counts
    const summary = document.createElement('div');
    summary.className = 'test-status__summary';

    const totalCell = document.createElement('div');
    totalCell.className = 'test-status__cell test-status__cell--total';
    const totalVal = document.createElement('div');
    totalVal.className = 'test-status__num';
    totalVal.textContent = (data.total != null ? data.total : '?');
    const totalLbl = document.createElement('div');
    totalLbl.className = 'test-status__lbl';
    totalLbl.textContent = 'tests';
    totalCell.appendChild(totalVal);
    totalCell.appendChild(totalLbl);
    summary.appendChild(totalCell);

    if (data.passed != null) {
      const passedCell = document.createElement('div');
      passedCell.className = 'test-status__cell test-status__cell--passed';
      const v = document.createElement('div');
      v.className = 'test-status__num';
      v.textContent = data.passed;
      const l = document.createElement('div');
      l.className = 'test-status__lbl';
      l.textContent = 'passed';
      passedCell.appendChild(v); passedCell.appendChild(l);
      summary.appendChild(passedCell);
    }

    if (data.failed != null) {
      const failedCell = document.createElement('div');
      failedCell.className = 'test-status__cell test-status__cell--failed';
      const v = document.createElement('div');
      v.className = 'test-status__num';
      v.textContent = data.failed;
      const l = document.createElement('div');
      l.className = 'test-status__lbl';
      l.textContent = 'failed';
      failedCell.appendChild(v); failedCell.appendChild(l);
      summary.appendChild(failedCell);
    }

    if (data.skipped != null) {
      const skippedCell = document.createElement('div');
      skippedCell.className = 'test-status__cell test-status__cell--skipped';
      const v = document.createElement('div');
      v.className = 'test-status__num';
      v.textContent = data.skipped;
      const l = document.createElement('div');
      l.className = 'test-status__lbl';
      l.textContent = 'skipped';
      skippedCell.appendChild(v); skippedCell.appendChild(l);
      summary.appendChild(skippedCell);
    }

    if (data.duration_ms != null) {
      const durCell = document.createElement('div');
      durCell.className = 'test-status__cell test-status__cell--duration';
      const v = document.createElement('div');
      v.className = 'test-status__num';
      v.textContent = (data.duration_ms / 1000).toFixed(2) + 's';
      const l = document.createElement('div');
      l.className = 'test-status__lbl';
      l.textContent = 'duration';
      durCell.appendChild(v); durCell.appendChild(l);
      summary.appendChild(durCell);
    }

    node.appendChild(summary);

    // Optional list of individual test results
    if (Array.isArray(data.tests) && data.tests.length) {
      const list = document.createElement('div');
      list.className = 'test-status__list';
      for (const t of data.tests) {
        const row = document.createElement('div');
        row.className = 'test-status__row test-status__row--' + (t.status || 'unknown');
        const icon = document.createElement('span');
        icon.className = 'test-status__icon';
        icon.textContent = statusIcon(t.status);
        const name = document.createElement('span');
        name.className = 'test-status__name';
        name.textContent = t.name || '(unnamed)';
        const dur = document.createElement('span');
        dur.className = 'test-status__dur';
        dur.textContent = (t.duration_ms != null ? t.duration_ms + 'ms' : '');
        row.appendChild(icon); row.appendChild(name); row.appendChild(dur);
        if (t.message) {
          const msg = document.createElement('div');
          msg.className = 'test-status__msg';
          msg.textContent = t.message;
          row.appendChild(msg);
        }
        list.appendChild(row);
      }
      node.appendChild(list);
    }

    return node;
  }

  window.FarnsworthSurfaces._register('test_status', renderTestStatus);
})();