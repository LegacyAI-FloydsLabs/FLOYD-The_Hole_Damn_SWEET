/**
 * Command snippets — a togglable row of one-tap commands. Tapping a chip inserts
 * the command at the prompt (NO auto-run) so it can be reviewed before Enter.
 * Presets are constant; user snippets are added via "+", deleted via "x", and
 * persisted in localStorage.
 */
const KEY = 'terminalone.snippets';
const PRESETS = ['ls -la', 'git status', 'clear', 'cd ..', 'pwd'];

export function init(T1) {
  const tb = T1.ui.toolbar();
  if (!tb) return;

  T1.ui.addStyle(`
    .t1snip-row {
      flex: 0 0 auto;
      display: flex;
      gap: 6px;
      align-items: center;
      padding: 6px 8px;
      background: var(--ui-elevated);
      border-top: 1px solid var(--ui-border);
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
      scrollbar-width: none;
    }
    .t1snip-row::-webkit-scrollbar { display: none; }
    .t1snip-row.hidden { display: none; }
    .t1snip-chip { white-space: nowrap; }
    .t1snip-custom { display: inline-flex; align-items: center; gap: 2px; flex: 0 0 auto; }
    .t1snip-del { padding: 0 7px; min-width: 0; }
  `);

  const row = document.createElement('div');
  row.className = 't1snip-row hidden';
  tb.insertAdjacentElement('afterend', row);

  const load = () => {
    try { const v = JSON.parse(T1.storage.get(KEY, '[]')); return Array.isArray(v) ? v : []; }
    catch (_) { return []; }
  };
  const save = (list) => T1.storage.set(KEY, JSON.stringify(list));

  function render() {
    row.innerHTML = '';
    for (const cmd of PRESETS) {
      const chip = T1.ui.makeButton(cmd, `Insert: ${cmd}`, () => T1.sendData(cmd));
      chip.classList.add('t1snip-chip');
      row.appendChild(chip);
    }
    load().forEach((cmd, i) => {
      const wrap = document.createElement('span');
      wrap.className = 't1snip-custom';
      const chip = T1.ui.makeButton(cmd, `Insert: ${cmd}`, () => T1.sendData(cmd));
      chip.classList.add('t1snip-chip');
      const del = T1.ui.makeButton('x', `Delete snippet: ${cmd}`, () => {
        const list = load();
        list.splice(i, 1);
        save(list);
        render();
      });
      del.classList.add('t1snip-del');
      wrap.appendChild(chip);
      wrap.appendChild(del);
      row.appendChild(wrap);
    });
    const add = T1.ui.makeButton('+', 'Add a snippet', () => {
      const v = window.prompt('New snippet command:');
      if (v && v.trim()) { const list = load(); list.push(v.trim()); save(list); render(); }
    });
    add.classList.add('t1snip-chip');
    row.appendChild(add);
  }

  const toggle = T1.ui.makeButton('Snippets', 'Toggle command snippets', () => {
    const hidden = row.classList.toggle('hidden');
    toggle.classList.toggle('active', !hidden);
  });
  tb.appendChild(toggle);

  render();
}
