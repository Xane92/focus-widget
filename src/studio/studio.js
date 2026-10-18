/* Focus Studio renderer: tasks, appearance, logs, settings. All edits go through the main process. */
window.__errors = []; window.addEventListener('error', (e) => window.__errors.push(String(e.message))); window.addEventListener('unhandledrejection', (e) => window.__errors.push(String(e.reason)));
(() => {
  'use strict';
  const C = window.Core;
  const api = window.api || mockApi();
  const app = document.getElementById('app');
  const VIEWS = { tasks: tasksView, appearance: appearanceView, logs: logsView, settings: settingsView };
  const NAV = [
    ['tasks', 'ph-list-checks', 'Tasks'],
    ['appearance', 'ph-paint-brush-broad', 'Appearance'],
    ['logs', 'ph-clock-counter-clockwise', 'Logs'],
    ['settings', 'ph-gear-six', 'Settings'],
  ];
  const KEY_NAMES = { Control: 'Ctrl', CommandOrControl: 'Ctrl', CmdOrCtrl: 'Ctrl', Super: 'Win', Meta: 'Win' };

  const q = new URLSearchParams(location.search);
  let S = null;
  let META = { hotkeys: {}, version: '', dataPath: '', widgetVisible: true };
  let view = VIEWS[q.get('view')] ? q.get('view') : 'tasks';
  let shownView = null;
  let range = 'today';
  let logLimit = 120;
  const expanded = new Set();
  let armed = null;
  let armTimer = null;
  let capture = null;
  let hold = false;
  let pending = false;
  let dragId = null;

  const now = () => Date.now();
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const send = (type, payload) => api.dispatch({ type, payload });
  const setSetting = (key, value) => send('settings/set', { key, value });
  const fmtT = (ts) => C.fmtTime(ts, S.settings.clock24);

  function theme() {
    const t = S.settings.theme;
    if (t === 'light' || t === 'dark') return t;
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  const gradientCss = () => (C.GRADIENTS[S.settings.gradient] || C.GRADIENTS.dusk).css;
  function photoUrl() {
    const p = S.settings.photo;
    if (!S.settings.showPhoto || !p) return null;
    return `url("${p.replace(/"/g, '%22')}")`;
  }

  const startOfDay = (ts) => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const isToday = (ts) => startOfDay(ts) === startOfDay(now());
  const shortDate = (ts) => new Date(ts).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
  const when = (ts) => (isToday(ts) ? fmtT(ts) : `${shortDate(ts)}, ${fmtT(ts)}`);

  /* ---------- Shared pieces ---------- */
  const stack = () => '<div class="media" data-media></div><div class="tint" data-tint></div><div class="shade"></div>';
  const row = (label, desc, ctl, warn) => `
    <div class="row">
      <div><div class="row__label">${label}</div>${desc ? `<div class="row__desc ${warn ? 'is-warn' : ''}">${desc}</div>` : ''}</div>
      <div class="row__ctl">${ctl || ''}</div>
    </div>`;
  const toggle = (key, label) => `<button class="switch" role="switch" aria-checked="${!!S.settings[key]}" aria-label="${esc(label || key)}" data-act="switch" data-setting="${key}"></button>`;
  const seg = (key, opts) => `<div class="seg" role="group">${opts.map(([v, l]) => `<button data-act="seg" data-setting="${key}" data-val="${v}" aria-pressed="${String(S.settings[key]) === v}">${l}</button>`).join('')}</div>`;
  const emptyTpl = (icon, title, text) => `<div class="empty"><i class="ph ${icon}"></i><b>${title}</b>${text}</div>`;

  function metaText(a) {
    if (!a) return 'Add a task to start';
    if (S.running && S.running.taskId === a.id) return `since ${fmtT(S.running.since)}`;
    if (a.elapsedMs > 0 && a.lastStoppedAt) return `paused at ${fmtT(a.lastStoppedAt)}`;
    return 'not started';
  }

  function durHtml(ms) {
    const sec = Math.floor(Math.max(0, ms) / 1000);
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
    if (h > 0) return `${h}<small>h</small>${m}<small>m</small>`;
    if (m > 0) return `${m}<small>m</small>`;
    return `${sec}<small>s</small>`;
  }

  /* ---------- Layout ---------- */
  function tpl() {
    return `
      <header class="titlebar"><img src="../assets/icon.png" alt=""><span>Focus Studio</span></header>
      <aside class="rail">
        <nav aria-label="Sections">${NAV.map(([k, icon, label]) => `
          <button class="nav__btn" data-act="nav" data-val="${k}" ${view === k ? 'aria-current="page"' : ''}><i class="ph ${icon}"></i>${label}</button>`).join('')}
        </nav>
        ${nowTpl()}
      </aside>
      <main class="main"><div class="view">${VIEWS[view]()}</div></main>`;
  }

  function nowTpl() {
    const a = C.active(S);
    const live = !!(a && S.running && S.running.taskId === a.id);
    return `
      <section class="now ${photoUrl() ? 'has-photo' : ''}">
        ${stack()}
        <p class="now__task">${a ? esc(a.title) : 'Nothing queued.'}</p>
        <div class="now__row">
          <div><div class="now__timer" data-timer>00:00</div><div class="now__label" data-meta></div></div>
          <button class="media-btn ${live ? 'is-running' : ''}" data-act="timer" aria-label="${live ? 'Pause' : 'Start'}" ${a ? '' : 'disabled'}><i class="ph-fill ${live ? 'ph-pause' : 'ph-play'}"></i></button>
        </div>
      </section>`;
  }

  /* ---------- Tasks ---------- */
  function tasksView() {
    const open = S.tasks.filter((t) => !t.done);
    const done = S.tasks.filter((t) => t.done);
    const a = C.active(S);
    return `
      <header class="head"><h1>Tasks</h1><p>${open.length} open${done.length ? `, ${done.length} done` : ''}. Drag to reorder; when you check one off, the top task is up next.</p></header>
      <div class="addbar">
        <span class="plus"><i class="ph-bold ph-plus"></i></span>
        <input data-key="add-task" data-enter="add-task" placeholder="Add a task" maxlength="140" aria-label="New task">
        <span class="kbd">Enter</span>
      </div>
      <section class="panel" data-list="open">
        ${open.length ? open.map((t) => taskRow(t, a)).join('') : emptyTpl('ph-check-circle', 'All clear.', 'Add a task above and it lands on your widget.')}
      </section>
      ${done.length ? `
        <div class="sect"><h2>Done</h2><button class="btn btn--soft btn--sm" data-act="clear-done">Clear done</button></div>
        <section class="panel">${done.map((t) => taskRow(t, a)).join('')}</section>` : ''}`;
  }

  function taskRow(t, a) {
    const isActive = !t.done && a && a.id === t.id;
    const live = !!(S.running && S.running.taskId === t.id);
    const ms = C.elapsed(S, t, now());
    const open = expanded.has(t.id);
    const subsDone = t.subtasks.filter((x) => x.done).length;
    let meta = '';
    if (t.done) meta = `${ms >= 1000 ? `${C.fmtDur(ms)}, ` : ''}checked ${when(t.completedAt)}`;
    else if (!live && ms >= 1000) meta = C.fmtDur(ms);
    let btn = '';
    if (!t.done) {
      if (live) btn = `<button class="tbtn is-running" data-act="pause" aria-label="Pause"><i class="ph-fill ph-pause"></i><span data-live="${t.id}">${C.fmtClock(ms)}</span></button>`;
      else if (isActive) btn = `<button class="tbtn" data-act="start"><i class="ph-fill ph-play"></i>${ms > 0 ? 'Resume' : 'Start'}</button>`;
      else btn = '<button class="tbtn reveal" data-act="start"><i class="ph-fill ph-play"></i>Focus</button>';
    }
    const delArmed = armed === `del-${t.id}`;
    return `
      <div class="trow ${isActive ? 'is-active' : ''} ${t.done ? 'is-done' : ''}" data-id="${t.id}">
        <div class="trow__main">
          ${t.done ? '<span class="handle-slot"></span>' : '<span class="handle" draggable="true" data-handle title="Drag to reorder"><i class="ph-bold ph-dots-six-vertical"></i></span>'}
          <button class="check" role="checkbox" aria-checked="${t.done}" aria-label="Mark done" data-act="toggle"><i class="ph-bold ph-check"></i></button>
          <input class="tinput" data-key="t-${t.id}" data-edit="task" value="${esc(t.title)}" maxlength="140" aria-label="Task title">
          ${meta ? `<span class="tmeta">${meta}</span>` : ''}
          ${btn}
          <button class="icon-btn caret" data-act="expand" aria-expanded="${open}" aria-label="Subtasks">${t.subtasks.length ? `<span class="subcount">${subsDone}/${t.subtasks.length}</span>` : ''}<i class="ph-bold ph-caret-down"></i></button>
          <button class="icon-btn reveal ${delArmed ? 'is-armed' : ''}" data-act="delete" aria-label="Delete task">${delArmed ? 'Delete?' : '<i class="ph ph-trash"></i>'}</button>
        </div>
        ${open ? subsTpl(t) : ''}
      </div>`;
  }

  function subsTpl(t) {
    return `
      <div class="subs">
        ${t.subtasks.map((s) => `
          <div class="srow ${s.done ? 'is-done' : ''}" data-sub="${s.id}">
            <button class="check check--sm" role="checkbox" aria-checked="${s.done}" aria-label="Mark done" data-act="sub-toggle"><i class="ph-bold ph-check"></i></button>
            <input data-key="s-${s.id}" data-edit="sub" value="${esc(s.title)}" maxlength="140" aria-label="Subtask title">
            <button class="icon-btn icon-btn--sm reveal" data-act="sub-delete" aria-label="Delete subtask"><i class="ph ph-x"></i></button>
          </div>`).join('')}
        <div class="srow">
          <span class="plus plus--sm"><i class="ph-bold ph-plus"></i></span>
          <input data-key="as-${t.id}" data-enter="add-sub" placeholder="Add subtask" maxlength="140" aria-label="New subtask">
        </div>
      </div>`;
  }

  /* ---------- Appearance ---------- */
  function appearanceView() {
    const st = S.settings;
    const photo = !!st.photo;
    const op = Math.round((Number(st.opacity) || 1) * 100);
    const a = C.active(S);
    return `
      <header class="head"><h1>Appearance</h1><p>Changes land on the widget the moment you make them.</p></header>
      <div class="sect" style="margin-top:0"><h2>Photo</h2></div>
      <section class="panel">
        <div class="photo">
          <div class="preview ${photoUrl() ? 'has-photo' : ''}">
            ${stack()}
            <p class="now__task">${esc(a ? a.title : 'Your next task')}</p>
            <div class="now__timer" data-timer>00:00</div>
          </div>
          <div class="photo__side">
            <p>${photo
              ? 'Your photo sits behind the timer. The gradient tints it so the numbers stay readable.'
              : 'No photo yet. The card shows your gradient on its own.'}</p>
            <div class="btns">
              <button class="btn btn--ink" data-act="pick-photo"><i class="ph ph-image"></i>${photo ? 'Change photo' : 'Choose photo'}</button>
              ${photo ? '<button class="btn btn--soft" data-act="remove-photo">Remove</button>' : ''}
            </div>
            ${photo ? `<div class="photo__toggle"><span class="row__label">Show photo</span>${toggle('showPhoto', 'Show photo')}</div>` : ''}
          </div>
        </div>
      </section>

      <div class="sect"><h2>Gradient</h2></div>
      <section class="panel">
        <div class="swatches">${Object.entries(C.GRADIENTS).map(([k, g]) => `
          <button class="swatch" data-act="gradient" data-val="${k}" aria-pressed="${st.gradient === k}">
            <span class="swatch__fill" data-grad="${k}"></span><span class="swatch__name">${g.name}</span>
          </button>`).join('')}
        </div>
      </section>

      <div class="sect"><h2>Play button</h2></div>
      <section class="panel">
        ${colorRow('btnIdle', 'When paused', 'paused')}
        ${colorRow('btnLive', 'When running', 'running')}
      </section>

      <div class="sect"><h2>Widget</h2></div>
      <section class="panel">
        ${row('Theme', 'Auto follows your Windows setting.', seg('theme', [['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']]))}
        ${row('Opacity', 'Let more of your screen show through.', `
          <div class="range">
            <input type="range" min="40" max="100" step="5" value="${op}" data-range="opacity" data-key="range-opacity" aria-label="Opacity">
            <output data-out="opacity">${op}%</output>
          </div>`)}
        ${row('Mini mode', 'A slim card with your task, timer and photo. Double-click the timer on the widget to switch.', toggle('compact', 'Mini mode'))}
      </section>`;
  }

  function colorRow(key, label, state) {
    const bc = C.buttonColors(S.settings);
    const cur = state === 'running' ? bc.live : bc.idle;
    const isSet = C.HEX.test(S.settings[key] || '');
    const custom = !C.BTN_PRESETS.some(([hex]) => hex.toLowerCase() === cur.toLowerCase());
    const def = C.BTN_PRESETS.find(([hex]) => hex === C.BTN_DEFAULTS[key]);
    return `
      <div class="row">
        <div class="crow__label">
          <span class="chip"><span class="media" data-media></span><span class="chip__btn chip__btn--${state}"><i class="ph-fill ${state === 'running' ? 'ph-pause' : 'ph-play'}"></i></span></span>
          <div><div class="row__label">${label}</div><div class="row__desc">${isSet ? 'Custom colour' : `Default: ${def ? def[1] : ''}`}</div></div>
        </div>
        <div class="row__ctl">
          <div class="colors" role="group" aria-label="${label} colour">
            ${C.BTN_PRESETS.map(([hex, name]) => `<button class="dot" style="--dot:${hex}" data-act="color" data-setting="${key}" data-val="${hex}" aria-pressed="${hex.toLowerCase() === cur.toLowerCase()}" title="${name}" aria-label="${name}"></button>`).join('')}
            <label class="dot dot--custom ${custom ? 'is-on' : ''}" style="${custom ? `--dot:${cur}` : ''}" title="Pick any colour">
              <input type="color" value="${cur}" data-color="${key}" data-key="color-${key}" aria-label="Pick any colour">
              <i class="ph-bold ph-eyedropper"></i>
            </label>
          </div>
          <button class="btn btn--soft btn--sm" data-act="color-reset" data-setting="${key}" ${isSet ? '' : 'disabled'}>Default</button>
        </div>
      </div>`;
  }

  /* ---------- Logs ---------- */
  function rangeStart() {
    const today = startOfDay(now());
    if (range === 'today') return today;
    if (range === 'week') return today - 6 * 86400000;
    return 0;
  }

  function focusedIn(from, t) {
    let ms = 0;
    for (const s of S.sessions) if (s.end > from) ms += s.end - Math.max(s.start, from);
    if (S.running) ms += Math.max(0, t - Math.max(S.running.since, from));
    return ms;
  }

  const EV_ICON = {
    start: 'ph-fill ph-play', stop: 'ph-fill ph-pause', reset: 'ph-bold ph-arrow-counter-clockwise',
    done: 'ph-bold ph-check', undone: 'ph-bold ph-arrow-u-up-left', subdone: 'ph-bold ph-check',
    subundone: 'ph-bold ph-minus', add: 'ph-bold ph-plus', delete: 'ph ph-trash',
  };

  function evText(e) {
    const t = `<b>${esc(e.title || 'a task')}</b>`;
    switch (e.type) {
      case 'start': return `Started ${t}`;
      case 'stop': return `Paused ${t} <span>after ${C.fmtDur(e.durationMs || 0)}${e.note ? `, ${esc((C.STOP_NOTES[e.note] || e.note).toLowerCase())}` : ''}</span>`;
      case 'reset': return `Reset the timer on ${t}${e.totalMs ? ` <span>(was ${C.fmtDur(e.totalMs)})</span>` : ''}`;
      case 'done': return `Checked off ${t}${e.totalMs ? ` <span>after ${C.fmtDur(e.totalMs)} of focus</span>` : ''}`;
      case 'undone': return `Unchecked ${t}`;
      case 'subdone': return `Checked <b>${esc(e.subTitle)}</b> <span>in ${esc(e.title)}</span>`;
      case 'subundone': return `Unchecked <b>${esc(e.subTitle)}</b> <span>in ${esc(e.title)}</span>`;
      case 'add': return `Added ${t}`;
      case 'delete': return `Deleted ${t}`;
      default: return `${esc(e.type)} ${t}`;
    }
  }

  function dayLabel(ts) {
    const d = startOfDay(ts), today = startOfDay(now());
    if (d === today) return 'Today';
    if (d === today - 86400000) return 'Yesterday';
    return shortDate(ts);
  }

  function logsView() {
    const from = rangeStart();
    const t = now();
    let sessions = S.sessions.filter((s) => s.end > from).length + (S.running ? 1 : 0);
    const finished = [...S.tasks, ...S.archive].filter((x) => x.done && x.completedAt >= from).sort((x, y) => y.completedAt - x.completedAt);
    const events = S.log.filter((e) => e.at >= from).reverse();
    const shown = events.slice(0, logLimit);
    let lastDay = null;
    const timeline = shown.map((e) => {
      const day = dayLabel(e.at);
      const head = day !== lastDay ? `<div class="day">${day}</div>` : '';
      lastDay = day;
      return `${head}
        <div class="ev ev--${e.type}">
          <span class="ev__time">${fmtT(e.at)}</span>
          <span class="ev__icon"><i class="${EV_ICON[e.type] || 'ph ph-circle'}"></i></span>
          <span class="ev__text">${evText(e)}</span>
        </div>`;
    }).join('');
    const clearArmed = armed === 'clear-log';
    const rangeSeg = `<div class="seg" role="group">${[['today', 'Today'], ['week', '7 days'], ['all', 'All time']].map(([v, l]) => `<button data-act="range" data-val="${v}" aria-pressed="${range === v}">${l}</button>`).join('')}</div>`;

    return `
      <header class="head">
        <div class="head__row">
          <div><h1>Logs</h1><p>Every start, pause and check-off, with the real time it happened.</p></div>
          <div class="btns">
            <button class="btn btn--soft btn--sm" data-act="export" data-val="events"><i class="ph ph-download-simple"></i>Activity CSV</button>
            <button class="btn btn--soft btn--sm" data-act="export" data-val="tasks"><i class="ph ph-download-simple"></i>Tasks CSV</button>
          </div>
        </div>
      </header>
      <div style="margin-bottom:14px">${rangeSeg}</div>
      <section class="panel stats">
        <div class="stat"><div class="stat__num" data-focused>${durHtml(focusedIn(from, t))}</div><div class="stat__label">Focused</div></div>
        <div class="stat"><div class="stat__num">${finished.length}</div><div class="stat__label">Tasks finished</div></div>
        <div class="stat"><div class="stat__num">${sessions}</div><div class="stat__label">Timer sessions</div></div>
      </section>

      <div class="sect"><h2>Finished</h2></div>
      <section class="panel">
        ${finished.length ? finished.map((x) => `
          <div class="frow">
            <div style="flex:1;min-width:0">
              <div class="frow__title">${esc(x.title)}</div>
              <div class="frow__when">${x.firstStartedAt ? `started ${when(x.firstStartedAt)}, ` : ''}checked ${when(x.completedAt)}</div>
            </div>
            <div class="frow__dur ${x.elapsedMs ? '' : 'is-zero'}">${x.elapsedMs ? C.fmtDur(x.elapsedMs) : 'not timed'}</div>
          </div>`).join('') : emptyTpl('ph-flag-checkered', 'Nothing finished yet.', 'Tick a task on the widget and it shows here with its time.')}
      </section>

      <div class="sect">
        <h2>Timeline</h2>
        ${S.log.length ? `<button class="btn btn--sm ${clearArmed ? 'btn--armed' : 'btn--soft'}" data-act="clear-log">${clearArmed ? 'Click again to clear all' : 'Clear history'}</button>` : ''}
      </div>
      <section class="panel">
        ${timeline || emptyTpl('ph-clock', 'No activity yet.', 'Start the timer on a task and it shows up here.')}
        ${events.length > shown.length ? `<div class="more"><button class="btn btn--soft btn--sm" data-act="more">Show more</button></div>` : ''}
      </section>`;
  }

  /* ---------- Settings ---------- */
  function keysTpl(key) {
    if (capture === key) return `<button class="keys is-capturing" data-act="capture" data-setting="${key}">Press a shortcut. Esc cancels, Backspace clears.</button>`;
    const v = S.settings[key];
    const caps = v ? v.split('+').map((k) => `<span class="cap">${esc(KEY_NAMES[k] || k)}</span>`).join('') : '<span class="cap">None</span>';
    return `<button class="keys" data-act="capture" data-setting="${key}" aria-label="Change shortcut">${caps}</button>`;
  }

  function hotkeyRow(key, label) {
    const v = S.settings[key];
    const ok = (META.hotkeys || {})[key];
    let desc = 'Works from any app. Click the keys to change.';
    if (!v) desc = 'No shortcut set. Click to add one.';
    else if (ok === false) desc = 'Another app already uses this. Click the keys to pick another.';
    return row(label, desc, keysTpl(key), v && ok === false);
  }

  function settingsView() {
    return `
      <header class="head"><h1>Settings</h1></header>
      <div class="sect" style="margin-top:0"><h2>Window</h2></div>
      <section class="panel">
        ${row('Show widget', 'Hide it when you need the whole screen. The tray icon brings it back.', `<button class="switch" role="switch" aria-checked="${!!META.widgetVisible}" aria-label="Show widget" data-act="widget-visible"></button>`)}
        ${row('Always on top', 'Stay above every window, including Claude and your browser.', toggle('alwaysOnTop', 'Always on top'))}
        ${row('Start with Windows', 'Open Focus automatically when you sign in.', toggle('launchAtLogin', 'Start with Windows'))}
      </section>
      <div class="sect"><h2>Shortcuts</h2></div>
      <section class="panel">
        ${hotkeyRow('hotkey', 'Show or hide the widget')}
        ${hotkeyRow('timerHotkey', 'Start or pause the timer')}
      </section>
      <div class="sect"><h2>Clock</h2></div>
      <section class="panel">
        ${row('Time format', 'Used on the widget and in your logs.', seg('clock24', [['null', 'Auto'], ['false', '12-hour'], ['true', '24-hour']]))}
      </section>
      <div class="sect"><h2>Data</h2></div>
      <section class="panel">
        ${row('Your data', `Saved on this PC only, never uploaded.<br><span class="mono">${esc(META.dataPath || '')}</span>`, '<button class="btn btn--soft btn--sm" data-act="open-data"><i class="ph ph-folder-open"></i>Open folder</button>')}
        ${row('Version', META.updateReady
          ? `Focus ${esc(META.version || '')}. Version ${esc(META.updateReady)} is downloaded and ready.`
          : `Focus ${esc(META.version || '')}. Updates download on their own.`,
          META.updateReady ? '<button class="btn btn--ink btn--sm" data-act="install-update">Restart to update</button>' : '')}
      </section>`;
  }

  /* ---------- Render ---------- */
  function paintMedia() {
    const g = gradientCss();
    const p = photoUrl();
    app.querySelectorAll('[data-media]').forEach((el) => { el.style.backgroundImage = p || g; });
    app.querySelectorAll('[data-tint]').forEach((el) => { el.style.backgroundImage = g; });
    app.querySelectorAll('[data-grad]').forEach((el) => { el.style.background = (C.GRADIENTS[el.dataset.grad] || C.GRADIENTS.dusk).css; });
  }

  function render() {
    if (!S) return;
    if (hold || (document.activeElement && document.activeElement.matches && document.activeElement.matches('input[type=color]'))) { pending = true; return; }
    document.documentElement.dataset.theme = theme();
    const bc = C.buttonColors(S.settings);
    const rs = document.documentElement.style;
    rs.setProperty('--btn-idle', bc.idle); rs.setProperty('--btn-idle-fg', bc.idleFg);
    rs.setProperty('--btn-live', bc.live); rs.setProperty('--btn-live-fg', bc.liveFg);
    const ae = document.activeElement;
    const key = ae && ae.dataset ? ae.dataset.key : null;
    const val = key && typeof ae.value === 'string' ? ae.value : null;
    let sel = null;
    try { if (key && ae.selectionStart != null) sel = [ae.selectionStart, ae.selectionEnd]; } catch (_) { sel = null; }
    const main = app.querySelector('.main');
    const scroll = main && shownView === view ? main.scrollTop : 0;

    app.innerHTML = tpl();
    shownView = view;
    paintMedia();
    const m2 = app.querySelector('.main');
    if (m2) m2.scrollTop = scroll;
    if (key) {
      const el = app.querySelector(`[data-key="${key}"]`);
      if (el) {
        if (val !== null) el.value = val;
        el.focus({ preventScroll: true });
        if (sel) try { el.setSelectionRange(sel[0], sel[1]); } catch (_) { /* not a text field */ }
      }
    }
    tick();
  }

  function tick() {
    if (!S) return;
    const t = now();
    const a = C.active(S);
    const ms = C.elapsed(S, a, t);
    const clock = C.fmtClock(ms);
    app.querySelectorAll('[data-timer]').forEach((el) => {
      if (el.textContent !== clock) el.textContent = clock;
      el.classList.toggle('is-long', ms >= 3600000);
    });
    const meta = app.querySelector('[data-meta]');
    if (meta) { const m = metaText(a); if (meta.textContent !== m) meta.textContent = m; }
    app.querySelectorAll('[data-live]').forEach((el) => {
      const s = C.fmtClock(C.elapsed(S, C.find(S, el.dataset.live), t));
      if (el.textContent !== s) el.textContent = s;
    });
    const f = app.querySelector('[data-focused]');
    if (f) { const h = durHtml(focusedIn(rangeStart(), t)); if (f.innerHTML !== h) f.innerHTML = h; }
  }

  function arm(key, fn) {
    clearTimeout(armTimer);
    if (armed === key) { armed = null; fn(); render(); return; }
    armed = key;
    armTimer = setTimeout(() => { armed = null; render(); }, 3000);
    render();
  }

  /* ---------- Events ---------- */
  app.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (capture && (!el || el.dataset.act !== 'capture')) { capture = null; render(); }
    if (!el || el.disabled) return;
    const id = el.closest('[data-id]') ? el.closest('[data-id]').dataset.id : null;
    const subId = el.closest('[data-sub]') ? el.closest('[data-sub]').dataset.sub : null;
    switch (el.dataset.act) {
      case 'nav': view = el.dataset.val; render(); break;
      case 'timer': send('timer/toggle'); break;
      case 'start': send('timer/start', { id }); break;
      case 'pause': send('timer/stop'); break;
      case 'toggle': send('task/toggle', { id }); break;
      case 'expand': {
        const opening = !expanded.has(id);
        if (opening) expanded.add(id); else expanded.delete(id);
        render();
        const t = C.find(S, id);
        if (opening && t && !t.subtasks.length) { const inp = app.querySelector(`[data-key="as-${id}"]`); if (inp) inp.focus(); }
        break;
      }
      case 'delete': arm(`del-${id}`, () => send('task/delete', { id })); break;
      case 'sub-toggle': send('sub/toggle', { id, subId }); break;
      case 'sub-delete': send('sub/delete', { id, subId }); break;
      case 'clear-done': send('task/clearDone'); break;
      case 'pick-photo': api.pickPhoto(); break;
      case 'remove-photo': setSetting('photo', null); break;
      case 'gradient': setSetting('gradient', el.dataset.val); break;
      case 'color': {
        const k = el.dataset.setting;
        setSetting(k, el.dataset.val === C.BTN_DEFAULTS[k] ? null : el.dataset.val);
        break;
      }
      case 'color-reset': setSetting(el.dataset.setting, null); break;
      case 'switch': setSetting(el.dataset.setting, !S.settings[el.dataset.setting]); break;
      case 'seg': {
        let v = el.dataset.val;
        if (el.dataset.setting === 'clock24') v = JSON.parse(v);
        setSetting(el.dataset.setting, v);
        break;
      }
      case 'range': range = el.dataset.val; logLimit = 120; render(); break;
      case 'export': api.exportCsv(el.dataset.val); break;
      case 'clear-log': arm('clear-log', () => send('log/clear')); break;
      case 'more': logLimit += 200; render(); break;
      case 'capture': capture = capture === el.dataset.setting ? null : el.dataset.setting; render(); break;
      case 'open-data': api.openDataFolder(); break;
      case 'install-update': if (api.installUpdate) api.installUpdate(); break;
      case 'widget-visible': api.toggleWidget(); break;
      default: break;
    }
  });

  app.addEventListener('keydown', (e) => {
    const el = e.target;
    if (!el.dataset) return;
    if (el.dataset.enter && e.key === 'Enter') {
      e.preventDefault();
      const v = el.value.trim();
      if (!v) return;
      el.value = '';
      if (el.dataset.enter === 'add-task') send('task/add', { title: v });
      else send('sub/add', { id: el.closest('[data-id]').dataset.id, title: v });
      return;
    }
    if (el.dataset.edit) {
      if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
      if (e.key === 'Escape') { el.value = el.defaultValue; el.blur(); }
    }
  });

  app.addEventListener('change', (e) => {
    const el = e.target;
    if (el.matches && el.matches('[data-color]')) {
      el.blur();
      pending = false;
      render();
      return;
    }
    if (!el.dataset || !el.dataset.edit) return;
    const v = el.value.trim();
    if (!v) { el.value = el.defaultValue; return; }
    const id = el.closest('[data-id]').dataset.id;
    if (el.dataset.edit === 'task') send('task/edit', { id, title: v });
    else send('sub/edit', { id, subId: el.closest('[data-sub]').dataset.sub, title: v });
  });

  // Opacity slider: live, without re-rendering under the pointer
  app.addEventListener('pointerdown', (e) => { if (e.target.matches('[data-range]')) hold = true; });
  window.addEventListener('pointerup', () => {
    if (!hold || dragId) return;
    hold = false;
    if (pending) { pending = false; render(); }
  });
  app.addEventListener('input', (e) => {
    if (e.target.matches('[data-color]')) {
      const k = e.target.dataset.color;
      const v = e.target.value;
      const label = e.target.closest('.dot');
      if (label) { label.style.setProperty('--dot', v); label.classList.add('is-on'); }
      document.documentElement.style.setProperty(k === 'btnLive' ? '--btn-live' : '--btn-idle', v);
      setSetting(k, v);
      return;
    }
    if (!e.target.matches('[data-range]')) return;
    const v = Number(e.target.value);
    const out = app.querySelector(`[data-out="${e.target.dataset.range}"]`);
    if (out) out.textContent = `${v}%`;
    setSetting('opacity', v / 100);
  });

  // Drag to reorder
  const clearDrop = () => app.querySelectorAll('.drop-before, .drop-after').forEach((el) => el.classList.remove('drop-before', 'drop-after'));
  function endDrag() {
    clearDrop();
    app.querySelectorAll('.is-dragging').forEach((el) => el.classList.remove('is-dragging'));
    dragId = null;
    hold = false;
    if (pending) { pending = false; render(); }
  }
  app.addEventListener('dragstart', (e) => {
    const h = e.target.closest && e.target.closest('[data-handle]');
    if (!h) return;
    const rowEl = h.closest('.trow');
    dragId = rowEl.dataset.id;
    hold = true;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragId);
    try { e.dataTransfer.setDragImage(rowEl, 30, 25); } catch (_) { /* default image */ }
    requestAnimationFrame(() => rowEl.classList.add('is-dragging'));
  });
  app.addEventListener('dragover', (e) => {
    if (!dragId) return;
    const rowEl = e.target.closest('[data-list="open"] .trow');
    if (!rowEl) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    clearDrop();
    if (rowEl.dataset.id === dragId) return;
    const r = rowEl.getBoundingClientRect();
    rowEl.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-before' : 'drop-after');
  });
  app.addEventListener('drop', (e) => {
    if (!dragId) return;
    e.preventDefault();
    const target = app.querySelector('.drop-before, .drop-after');
    if (target) {
      const after = target.classList.contains('drop-after');
      const from = S.tasks.findIndex((t) => t.id === dragId);
      let to = S.tasks.findIndex((t) => t.id === target.dataset.id) + (after ? 1 : 0);
      if (from < to) to -= 1;
      if (to !== from) send('task/move', { id: dragId, to });
    }
    endDrag();
  });
  app.addEventListener('dragend', endDrag);

  // Shortcut capture
  function accel(e) {
    const mods = [];
    if (e.ctrlKey) mods.push('Control');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    if (e.metaKey) mods.push('Super');
    const code = e.code || '';
    let key = null;
    if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
    else if (/^Digit[0-9]$/.test(code)) key = code.slice(5);
    else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) key = code;
    else {
      key = ({
        Space: 'Space', Enter: 'Enter', Tab: 'Tab', Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
        Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', ArrowUp: 'Up', ArrowDown: 'Down',
        ArrowLeft: 'Left', ArrowRight: 'Right', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert', Delete: 'Delete',
      })[code] || null;
    }
    if (!key) return null;
    if (!mods.length && !/^F\d+$/.test(key)) return null;
    return [...mods, key].join('+');
  }
  window.addEventListener('keydown', (e) => {
    if (!capture) return;
    e.preventDefault();
    e.stopPropagation();
    const bare = !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey;
    if (e.key === 'Escape') { capture = null; render(); return; }
    if (bare && (e.key === 'Backspace' || e.key === 'Delete')) { setSetting(capture, ''); capture = null; render(); return; }
    const a = accel(e);
    if (!a) return;
    setSetting(capture, a);
    capture = null;
    render();
  }, true);

  /* ---------- Boot ---------- */
  api.onState((s) => { S = s; render(); });
  api.onMeta((m) => { META = m; if (view === 'settings' && S) render(); });
  if (api.onView) api.onView((v) => { if (VIEWS[v]) { view = v; render(); } });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', render);
  Promise.all([api.getState(), api.getMeta()]).then(([s, m]) => { S = s; META = m || META; render(); });
  setInterval(tick, 500);

  /* Browser preview fallback */
  function mockApi() {
    const s = C.demoState(Date.now());
    if (q.get('theme')) s.settings.theme = q.get('theme');
    const subs = [];
    return {
      getState: async () => s,
      getMeta: async () => ({ version: '1.0.0', dataPath: 'C:\\Users\\you\\AppData\\Roaming\\Focus', hotkeys: { hotkey: true, timerHotkey: true }, widgetVisible: true }),
      dispatch: async (a) => { C.apply(s, a, Date.now()); subs.forEach((f) => f(s)); },
      onState: (f) => subs.push(f),
      onMeta: () => {},
      openStudio: () => {}, toggleWidget: () => {}, pickPhoto: async () => null, exportCsv: async () => null, openDataFolder: async () => {},
    };
  }
})();
