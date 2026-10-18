/* Widget renderer. In the desktop app, window.api comes from preload.js; in a plain browser it falls back to demo data. */
window.__errors = []; window.addEventListener('error', (e) => window.__errors.push(String(e.message))); window.addEventListener('unhandledrejection', (e) => window.__errors.push(String(e.reason)));
(() => {
  'use strict';
  const C = window.Core;
  const api = window.api || mockApi();
  const root = document.getElementById('app');

  let S = null;
  let lastKey = '';
  let adding = null; // null | { kind: 'task' } | { kind: 'sub', id }
  let draft = '';

  const now = () => Date.now();
  const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const send = (type, payload) => api.dispatch({ type, payload });

  function theme() {
    const t = S.settings.theme;
    if (t === 'light' || t === 'dark') return t;
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  function gradient() { return (C.GRADIENTS[S.settings.gradient] || C.GRADIENTS.dusk).css; }
  function photoUrl() {
    const p = S.settings.photo;
    if (!S.settings.showPhoto || !p) return null;
    const url = /^(data:|file:|https?:)/.test(p) ? p : 'file:///' + p.replace(/\\/g, '/').replace(/^\/+/, '');
    return `url("${url.replace(/"/g, '%22')}")`;
  }
  const isLive = (a) => !!(a && S.running && S.running.taskId === a.id);
  const playBtn = (a) => {
    const live = isLive(a);
    return `<button class="ctl ${live ? 'is-running' : ''}" data-act="timer" aria-label="${live ? 'Pause' : 'Start'}" ${a ? '' : 'disabled'}><i class="ph-fill ${live ? 'ph-pause' : 'ph-play'}"></i></button>`;
  };
  const media = (prefix) => `<div class="${prefix}__media" data-media></div><div class="${prefix}__tint" data-tint></div><div class="${prefix}__shade"></div>`;

  /* Full widget: photo card + task list */
  function heroTpl(a) {
    const cls = [photoUrl() ? 'has-photo' : '', a ? '' : 'is-empty'].join(' ');
    return `
      <section class="hero ${cls}">
        ${media('hero')}
        <div class="hero__body">
          <p class="hero__task">${a ? esc(a.title) : 'Nothing queued.'}</p>
          <div class="hero__foot">
            <div class="hero__clock">
              <div class="timer" data-timer title="Double-click for mini mode">00:00</div>
              <div class="meta" data-meta></div>
            </div>
            ${playBtn(a)}
          </div>
        </div>
      </section>`;
  }

  function subTpl(s) {
    return `
      <div class="sub ${s.done ? 'is-done' : ''}" data-sub="${s.id}">
        <button class="check" role="checkbox" aria-checked="${s.done}" aria-label="${esc(s.title)}" data-act="sub"><i class="ph-bold ph-check"></i></button>
        <span class="sub__title" title="${esc(s.title)}">${esc(s.title)}</span>
      </div>`;
  }

  function addTpl(kind, id) {
    const on = adding && adding.kind === kind && (kind === 'task' || adding.id === id);
    const cls = kind === 'sub' ? 'add add--sub' : 'add';
    const label = kind === 'sub' ? 'Add subtask' : 'Add task';
    if (on) {
      return `<div class="${cls}"><span class="add__plus"><i class="ph-bold ph-plus"></i></span><input data-input maxlength="140" placeholder="${label}" value="${esc(draft)}"></div>`;
    }
    return `<button class="${cls}" data-act="${kind === 'sub' ? 'add-sub' : 'add'}"><span class="add__plus"><i class="ph-bold ph-plus"></i></span>${label}</button>`;
  }

  function taskTpl(t, a) {
    const isActive = !t.done && a && a.id === t.id;
    const live = isLive(t);
    const ms = C.elapsed(S, t, now());
    const time = live
      ? `<span class="task__time is-live" data-live="${t.id}">${C.fmtDur(ms)}</span>`
      : ms >= 60000 ? `<span class="task__time">${C.fmtDur(ms)}</span>` : '';
    const hasSubs = t.subtasks.length > 0;
    const caret = hasSubs
      ? `<button class="caret" data-act="open" aria-expanded="${!!t.open}" aria-label="Subtasks"><i class="ph-bold ph-caret-down"></i></button>`
      : '<span class="caret-slot"></span>';
    const subs = hasSubs
      ? `<div class="subs" ${t.open ? 'data-open' : ''}><div class="subs__inner">${t.subtasks.map(subTpl).join('')}${t.done ? '' : addTpl('sub', t.id)}</div></div>`
      : '';
    return `
      <div class="task ${isActive ? 'is-active' : ''} ${t.done ? 'is-done' : ''}" data-id="${t.id}">
        <div class="task__row">
          <button class="check" role="checkbox" aria-checked="${t.done}" aria-label="${esc(t.title)}" data-act="toggle"><i class="ph-bold ph-check"></i></button>
          <button class="task__title" data-act="activate" title="${esc(t.title)}">${esc(t.title)}</button>
          ${time}${caret}
        </div>
        ${subs}
      </div>`;
  }

  function fullTpl(a) {
    const open = S.tasks.filter((t) => !t.done);
    const done = S.tasks.filter((t) => t.done);
    const progress = S.tasks.length ? `<b>${done.length}</b> of ${S.tasks.length} done` : 'No tasks yet';
    return `
      <div class="shell">
        <header class="bar">
          <div class="pill pill--dim"><span class="progress">${progress}</span><span class="clock" data-clock></span></div>
          <button class="pill pill--light" data-act="studio" aria-label="Open Studio" title="Open Studio"><i class="ph ph-arrow-up-right"></i></button>
        </header>
        ${heroTpl(a)}
        <section class="list" aria-label="Tasks">
          ${open.map((t) => taskTpl(t, a)).join('')}
          ${addTpl('task')}
          ${done.length ? `<div class="sep" role="separator"></div>${done.map((t) => taskTpl(t, a)).join('')}` : ''}
        </section>
        <div class="grip" data-grip aria-hidden="true"></div>
      </div>`;
  }

  /* Mini: one slim card with the same photo or gradient, the task, the timer and play */
  function compactTpl(a) {
    return `
      <div class="mini ${photoUrl() ? 'has-photo' : ''}" title="Double-click to expand">
        ${media('mini')}
        <div class="mini__in">
          <div class="mini__text">
            <span class="mini__title">${a ? esc(a.title) : 'Nothing queued.'}</span>
            <span class="mini__timer" data-timer>00:00</span>
          </div>
          ${playBtn(a)}
        </div>
        <div class="grip" data-grip aria-hidden="true"></div>
      </div>`;
  }

  /* Tucked into a screen edge: just a tab with an arrow pointing back in */
  function tabTpl(side, a) {
    return `
      <button class="tab tab--${side} ${isLive(a) ? 'is-running' : ''}" data-act="undock" aria-label="Bring Focus back" title="Bring Focus back">
        <span class="tab__media" data-media></span>
        <i class="ph-bold ${side === 'left' ? 'ph-caret-right' : 'ph-caret-left'}"></i>
      </button>`;
  }

  /* Render */
  function render() {
    if (!S) return;
    document.documentElement.dataset.theme = theme();
    const bc = C.buttonColors(S.settings);
    const rs = document.documentElement.style;
    rs.setProperty('--btn-idle', bc.idle); rs.setProperty('--btn-idle-fg', bc.idleFg);
    rs.setProperty('--btn-live', bc.live); rs.setProperty('--btn-live-fg', bc.liveFg);
    const a = C.active(S);
    const scroll = root.querySelector('.list')?.scrollTop || 0;
    const dock = S.window && S.window.dock;
    document.documentElement.classList.toggle('is-docked', !!dock);
    const html = dock ? tabTpl(dock.side, a) : S.settings.compact ? compactTpl(a) : fullTpl(a);
    const g = gradient();
    const photo = photoUrl();
    // Skip redraws that change nothing, so a button is never swapped out from under a click.
    const key = html + g + photo;
    if (key === lastKey && root.firstElementChild) { tick(); return; }
    lastKey = key;
    root.innerHTML = html;

    root.querySelectorAll('[data-media]').forEach((el) => { el.style.backgroundImage = photo || g; });
    root.querySelectorAll('[data-tint]').forEach((el) => { el.style.backgroundImage = g; });
    const list = root.querySelector('.list');
    if (list) list.scrollTop = scroll;

    const input = root.querySelector('[data-input]');
    if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
    tick();
  }

  function metaText(a) {
    if (!a) return 'Add a task to start';
    const c24 = S.settings.clock24;
    if (isLive(a)) return `since ${C.fmtTime(S.running.since, c24)}`;
    if (a.elapsedMs > 0 && a.lastStoppedAt) return `paused at ${C.fmtTime(a.lastStoppedAt, c24)}`;
    return 'not started';
  }

  function tick() {
    if (!S) return;
    const t = now();
    const a = C.active(S);
    const ms = C.elapsed(S, a, t);
    const timer = root.querySelector('[data-timer]');
    if (timer) {
      const txt = C.fmtClock(ms);
      if (timer.textContent !== txt) timer.textContent = txt;
      timer.classList.toggle('is-long', ms >= 3600000);
    }
    const meta = root.querySelector('[data-meta]');
    if (meta) { const m = metaText(a); if (meta.textContent !== m) meta.textContent = m; }
    root.querySelectorAll('[data-live]').forEach((el) => {
      const txt = C.fmtDur(C.elapsed(S, C.find(S, el.dataset.live), t));
      if (el.textContent !== txt) el.textContent = txt;
    });
    const clock = root.querySelector('[data-clock]');
    if (clock) { const c = C.fmtTime(t, S.settings.clock24); if (clock.textContent !== c) clock.textContent = c; }
  }

  /* Adding */
  function commitAdd() {
    const title = draft.trim();
    const target = adding;
    adding = null; draft = '';
    if (title && target) {
      if (target.kind === 'task') send('task/add', { title });
      else send('sub/add', { id: target.id, title });
    } else render();
  }

  /* Events */
  root.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || el.disabled) return;
    const id = el.closest('[data-id]')?.dataset.id;
    const subId = el.closest('[data-sub]')?.dataset.sub;
    switch (el.dataset.act) {
      case 'studio': if (api.openStudio) api.openStudio(); break;
      case 'undock': if (api.undock) api.undock(); break;
      case 'timer': if (e.detail === 0) send('timer/toggle'); break; // keyboard; mouse and touch go through pointerup below
      case 'toggle': send('task/toggle', { id }); break;
      case 'activate': send('task/activate', { id }); break;
      case 'open': send('task/open', { id }); break;
      case 'sub': send('sub/toggle', { id, subId }); break;
      case 'add': adding = { kind: 'task' }; draft = ''; render(); break;
      case 'add-sub': adding = { kind: 'sub', id }; draft = ''; render(); break;
      default: break;
    }
  });

  // Play / pause fires on release over the button, even if the widget redrew between press and release.
  let downOnPlay = false;
  root.addEventListener('pointerdown', (e) => {
    const b = e.target.closest('[data-act="timer"]');
    downOnPlay = !!(b && !b.disabled && e.button === 0);
  }, true);
  root.addEventListener('pointerup', (e) => {
    if (!downOnPlay) return;
    downOnPlay = false;
    const b = e.target.closest('[data-act="timer"]');
    if (b && !b.disabled) send('timer/toggle');
  }, true);

  // Full widget: double-click the timer to go mini. Mini: double-click anywhere (except play) to expand.
  root.addEventListener('dblclick', (e) => {
    if (!S) return;
    if (S.settings.compact) {
      if (e.target.closest('[data-act], [data-grip]')) return;
      send('settings/set', { key: 'compact', value: false });
    } else if (e.target.closest('[data-timer]')) {
      send('settings/set', { key: 'compact', value: true });
    }
  });

  // The window is moved by the app, never by a Windows drag region, so every click and double-click
  // (play, timer, tasks) reaches the page. Press anywhere that is not a control and drag.
  let drag = null;
  function endDrag(e) {
    if (!drag || (e && e.pointerId !== undefined && e.pointerId !== drag.id)) return;
    if (api.moveEnd) api.moveEnd();
    drag = null;
  }
  root.addEventListener('pointerdown', (e) => {
    if (!S || (S.window && S.window.dock) || e.button !== 0 || !api.moveStart) return;
    if (e.target.closest('[data-act], [data-grip], input, .list')) return;
    const card = e.target.closest(S.settings.compact ? '.mini' : '.shell');
    if (!card) return;
    drag = { x: e.screenX, y: e.screenY, id: e.pointerId, moved: false, queued: false };
    try { card.setPointerCapture(e.pointerId); } catch (_) { /* moving still follows the cursor */ }
    api.moveStart();
  });
  root.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.moved && Math.hypot(e.screenX - drag.x, e.screenY - drag.y) < 3) return;
    drag.moved = true;
    if (drag.queued) return;
    drag.queued = true;
    requestAnimationFrame(() => { if (drag) { drag.queued = false; api.moveMove(); } });
  });
  root.addEventListener('pointerup', endDrag);
  root.addEventListener('pointercancel', endDrag);
  window.addEventListener('blur', () => endDrag());

  root.addEventListener('input', (e) => { if (e.target.matches('[data-input]')) draft = e.target.value; });
  root.addEventListener('keydown', (e) => {
    if (!e.target.matches('[data-input]')) return;
    if (e.key === 'Enter') { e.preventDefault(); commitAdd(); }
    if (e.key === 'Escape') { adding = null; draft = ''; render(); }
  });
  root.addEventListener('focusout', (e) => {
    const el = e.target;
    if (el.matches('[data-input]') && adding) setTimeout(() => { if (adding && root.contains(el) && document.activeElement !== el) commitAdd(); }, 0);
  });

  // Corner grip: the desktop shell resizes the window; works in full and mini mode.
  root.addEventListener('pointerdown', (e) => {
    const grip = e.target.closest('[data-grip]');
    if (!grip || !api.resizeStart) return;
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    api.resizeStart();
    let queued = false;
    const move = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; api.resizeMove(); });
    };
    const up = () => {
      api.resizeEnd();
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      grip.removeEventListener('pointercancel', up);
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
    grip.addEventListener('pointercancel', up);
  });

  // Right-click: Studio, reset, mini mode, hide, quit (lives in the main process menu)
  root.addEventListener('contextmenu', (e) => {
    if (e.target.closest('input')) return;
    e.preventDefault();
    if (api.widgetMenu) api.widgetMenu();
  });

  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', render);

  api.onState((next) => { S = next; render(); });
  api.getState().then((s) => { S = s; render(); });
  setInterval(tick, 250);

  /* Browser preview fallback */
  function mockApi() {
    const q = new URLSearchParams(location.search);
    let s = q.get('empty') ? C.defaultState() : C.demoState(Date.now());
    if (q.get('theme')) s.settings.theme = q.get('theme');
    if (q.get('photo')) s.settings.photo = q.get('photo');
    if (q.get('gradient')) s.settings.gradient = q.get('gradient');
    if (q.get('compact')) s.settings.compact = true;
    if (q.get('paused')) C.apply(s, { type: 'timer/stop' }, Date.now());
    const subs = [];
    return {
      getState: async () => s,
      dispatch: async (a) => { C.apply(s, a, Date.now()); subs.forEach((f) => f(s)); },
      onState: (f) => subs.push(f),
    };
  }
})();
