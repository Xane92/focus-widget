/* Focus core: pure state + reducer, shared by the main process, the widget and the Studio. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Core = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  // Hero gradients. Dusk is measured from the "Hey, Annie" reference (slate #979AA2 into ember #CA7456 / #974221).
  const GRADIENTS = {
    dusk: {
      name: 'Dusk',
      css: 'radial-gradient(120% 85% at 92% 115%, #F0783A 0%, rgba(240,120,58,0) 58%), radial-gradient(95% 75% at 0% 120%, #974221 0%, rgba(151,66,33,0) 62%), linear-gradient(172deg, #979AA2 0%, #4A5262 48%, #1C1A1B 100%)',
    },
    ember: {
      name: 'Ember',
      css: 'radial-gradient(110% 80% at 85% -10%, #E9C9A6 0%, rgba(233,201,166,0) 55%), linear-gradient(165deg, #CA7456 0%, #974221 52%, #2A1A14 100%)',
    },
    night: {
      name: 'Night',
      css: 'radial-gradient(75% 60% at 88% 108%, rgba(240,120,58,.78) 0%, rgba(240,120,58,0) 70%), linear-gradient(175deg, #3A4558 0%, #1A1E27 55%, #0B0B0D 100%)',
    },
    graphite: {
      name: 'Graphite',
      css: 'radial-gradient(100% 70% at 12% -5%, #5E5E63 0%, rgba(94,94,99,0) 60%), linear-gradient(180deg, #2B2A2C 0%, #121112 100%)',
    },
  };

  const LOG_LABELS = {
    start: 'Started', stop: 'Paused', reset: 'Reset timer', done: 'Checked off', undone: 'Unchecked',
    subdone: 'Subtask checked', subundone: 'Subtask unchecked', add: 'Added', delete: 'Deleted',
  };
  const STOP_NOTES = { sleep: 'PC went to sleep', shutdown: 'PC shut down', recovered: 'App closed unexpectedly' };

  function defaultSettings() {
    return {
      theme: 'auto',              // auto | light | dark
      photo: null,                // file:// URL of the app's own copy, or data URL
      showPhoto: true,
      gradient: 'dusk',
      opacity: 1,
      compact: false,
      alwaysOnTop: true,
      launchAtLogin: false,
      hotkey: 'Control+Alt+Space',
      timerHotkey: 'Control+Alt+P',
      clock24: null,              // null = follow Windows
      btnIdle: null,              // play button colour when paused (null = default paper)
      btnLive: null,              // play button colour when running (null = default ember)
    };
  }

  function defaultState() {
    return {
      version: 1,
      tasks: [],
      archive: [],     // cleared done tasks, kept for history
      activeId: null,
      running: null,   // { taskId, since }
      heartbeat: null, // last moment the app was alive while the timer ran
      sessions: [],    // { id, taskId, start, end }
      log: [],         // { id, at, type, taskId, title, subId?, subTitle?, durationMs?, totalMs?, startedAt?, note? }
      window: null,    // { x, y, w, h }
      settings: defaultSettings(),
    };
  }

  function newTask(title, now) {
    return {
      id: uid(), title: String(title).trim(), done: false, createdAt: now, completedAt: null,
      firstStartedAt: null, lastStoppedAt: null, elapsedMs: 0, open: false, subtasks: [],
    };
  }
  function newSub(title, now) {
    return { id: uid(), title: String(title).trim(), done: false, createdAt: now, completedAt: null };
  }

  const find = (s, id) => (id ? s.tasks.find((t) => t.id === id) || null : null);
  const firstOpen = (s) => s.tasks.find((t) => !t.done) || null;

  function active(s) {
    const t = find(s, s.activeId);
    return t && !t.done ? t : firstOpen(s);
  }

  function elapsed(s, task, now) {
    if (!task) return 0;
    let ms = task.elapsedMs || 0;
    if (s.running && s.running.taskId === task.id) ms += Math.max(0, now - s.running.since);
    return ms;
  }

  function log(s, now, type, task, extra) {
    s.log.push(Object.assign({ id: uid(), at: now, type, taskId: task ? task.id : null, title: task ? task.title : '' }, extra || {}));
  }

  function stopTimer(s, now, note) {
    if (!s.running) return;
    const t = find(s, s.running.taskId);
    const end = Math.max(now, s.running.since);
    const dur = end - s.running.since;
    if (t) { t.elapsedMs += dur; t.lastStoppedAt = end; }
    s.sessions.push({ id: uid(), taskId: s.running.taskId, start: s.running.since, end });
    const extra = { durationMs: dur, startedAt: s.running.since, totalMs: t ? t.elapsedMs : dur };
    if (note) extra.note = note;
    log(s, end, 'stop', t, extra);
    s.running = null;
  }

  function startTimer(s, now, task) {
    task = task || active(s);
    if (!task || task.done) return;
    if (s.running && s.running.taskId === task.id) return;
    stopTimer(s, now);
    s.activeId = task.id;
    if (!task.firstStartedAt) task.firstStartedAt = now;
    s.running = { taskId: task.id, since: now };
    s.heartbeat = now;
    log(s, now, 'start', task);
  }

  function apply(s, action, now) {
    now = now || Date.now();
    const p = action.payload || {};
    const t = find(s, p.id);
    switch (action.type) {
      case 'timer/toggle':
        if (s.running) stopTimer(s, now); else startTimer(s, now);
        break;
      case 'timer/start':
        startTimer(s, now, t);
        break;
      case 'timer/stop':
        stopTimer(s, now, p.note);
        break;
      case 'timer/reset': {
        const a = active(s);
        if (!a) break;
        if (s.running && s.running.taskId === a.id) stopTimer(s, now);
        log(s, now, 'reset', a, { totalMs: a.elapsedMs });
        a.elapsedMs = 0;
        a.lastStoppedAt = null;
        break;
      }
      case 'task/activate': {
        if (!t || t.done) break;
        if (s.activeId === t.id) break;
        const wasRunning = !!s.running;
        s.activeId = t.id;
        if (wasRunning) startTimer(s, now, t); // the timer follows you to the new task
        break;
      }
      case 'task/toggle': {
        if (!t) break;
        if (!t.done) {
          if (s.running && s.running.taskId === t.id) stopTimer(s, now);
          t.done = true; t.completedAt = now;
          log(s, now, 'done', t, { totalMs: t.elapsedMs, startedAt: t.firstStartedAt });
          if (s.activeId === t.id) { const n = firstOpen(s); s.activeId = n ? n.id : null; }
        } else {
          t.done = false; t.completedAt = null;
          log(s, now, 'undone', t);
        }
        break;
      }
      case 'task/open':
        if (t) t.open = !t.open;
        break;
      case 'task/add': {
        const title = String(p.title || '').trim();
        if (!title) break;
        const n = newTask(title, now);
        s.tasks.push(n);
        const cur = find(s, s.activeId);
        if (!cur || cur.done) s.activeId = active(s).id;
        log(s, now, 'add', n);
        break;
      }
      case 'task/edit':
        if (t && String(p.title || '').trim()) t.title = String(p.title).trim().slice(0, 140);
        break;
      case 'task/delete': {
        if (!t) break;
        if (s.running && s.running.taskId === t.id) stopTimer(s, now);
        log(s, now, 'delete', t, { totalMs: t.elapsedMs });
        s.tasks = s.tasks.filter((x) => x.id !== t.id);
        if (s.activeId === t.id) { const n = firstOpen(s); s.activeId = n ? n.id : null; }
        break;
      }
      case 'task/move': { // { id, to } index in the tasks array
        const i = s.tasks.findIndex((x) => x.id === p.id);
        if (i < 0) break;
        const [m] = s.tasks.splice(i, 1);
        s.tasks.splice(Math.max(0, Math.min(s.tasks.length, p.to)), 0, m);
        break;
      }
      case 'task/clearDone': {
        const done = s.tasks.filter((x) => x.done);
        done.forEach((x) => { x.archivedAt = now; });
        s.archive.push(...done);
        s.tasks = s.tasks.filter((x) => !x.done);
        break;
      }
      case 'sub/add': {
        const title = String(p.title || '').trim();
        if (!t || !title) break;
        t.subtasks.push(newSub(title.slice(0, 140), now));
        t.open = true;
        break;
      }
      case 'sub/toggle': {
        const sub = t && t.subtasks.find((x) => x.id === p.subId);
        if (!sub) break;
        sub.done = !sub.done;
        sub.completedAt = sub.done ? now : null;
        log(s, now, sub.done ? 'subdone' : 'subundone', t, { subId: sub.id, subTitle: sub.title });
        break;
      }
      case 'sub/edit': {
        const sub = t && t.subtasks.find((x) => x.id === p.subId);
        if (sub && String(p.title || '').trim()) sub.title = String(p.title).trim().slice(0, 140);
        break;
      }
      case 'sub/delete':
        if (t) t.subtasks = t.subtasks.filter((x) => x.id !== p.subId);
        break;
      case 'settings/set':
        if (p.key in s.settings) s.settings[p.key] = p.value;
        break;
      case 'log/clear':
        s.log = []; s.sessions = []; s.archive = [];
        break;
      default:
        break;
    }
    return s;
  }

  // Play button colours. Defaults keep the approved look; custom colours get an icon colour that stays readable.
  const HEX = /^#[0-9a-f]{6}$/i;
  const BTN_DEFAULTS = { btnIdle: '#FBF8F4', btnLive: '#F0783A' };
  const BTN_PRESETS = [
    ['#FBF8F4', 'Paper'], ['#141010', 'Ink'], ['#F0783A', 'Ember'],
    ['#E5484D', 'Rose'], ['#3E63DD', 'Cobalt'], ['#2F7D5B', 'Forest'],
  ];
  function luminance(hex) {
    const n = parseInt(hex.slice(1), 16);
    const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  }
  const iconOn = (hex) => (luminance(hex) > 0.42 ? '#141010' : '#FBF8F4');
  function buttonColors(st) {
    const idle = HEX.test(st.btnIdle || '') ? st.btnIdle : BTN_DEFAULTS.btnIdle;
    const live = HEX.test(st.btnLive || '') ? st.btnLive : BTN_DEFAULTS.btnLive;
    return { idle, idleFg: iconOn(idle), live, liveFg: iconOn(live) };
  }

  // Formatting
  const pad = (n) => String(n).padStart(2, '0');
  function fmtClock(ms) {
    const sec = Math.floor(Math.max(0, ms) / 1000);
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), x = sec % 60;
    return h > 0 ? `${h}:${pad(m)}:${pad(x)}` : `${pad(m)}:${pad(x)}`;
  }
  function fmtDur(ms) {
    const sec = Math.floor(Math.max(0, ms) / 1000);
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
    if (h > 0) return m ? `${h}h ${m}m` : `${h}h`;
    if (m > 0) return `${m}m`;
    return `${sec}s`;
  }
  function fmtTime(ts, clock24) {
    if (!ts) return '';
    const o = { hour: 'numeric', minute: '2-digit' };
    if (clock24 === true) o.hourCycle = 'h23';
    if (clock24 === false) o.hour12 = true;
    return new Date(ts).toLocaleTimeString([], o);
  }

  // First launch: a few tasks that teach the widget by using it.
  function starterState(now) {
    const s = defaultState();
    const mk = (title, subs) => {
      const t = newTask(title, now);
      t.subtasks = (subs || []).map((x) => newSub(x, now));
      return t;
    };
    s.tasks = [
      mk('Click a task to focus it'),
      mk('Press play to time this task'),
      mk('Double-click timer to shrink'),
      mk('Open Studio with the arrow', ['Pick your photo', 'Try a gradient', 'Delete these starter tasks']),
    ];
    s.activeId = s.tasks[0].id;
    return s;
  }

  // Demo data for design previews
  function demoState(now) {
    const s = defaultState();
    const min = 60000;
    const mk = (title, subs, extra) => {
      const t = Object.assign(newTask(title, now - 5 * 60 * min), extra || {});
      t.subtasks = (subs || []).map(([st, d]) => Object.assign(newSub(st, now), { done: !!d, completedAt: d ? now - 30 * min : null }));
      return t;
    };
    const deck = mk('Finalize investor deck', [['Rewrite traction slide', 1], ['Tighten the ask'], ['Export PDF']], {
      open: true, elapsedMs: 38 * min + 5000, firstStartedAt: now - 72 * min,
    });
    s.tasks = [
      deck,
      mk('Reply to partner emails', [['Send revised quote'], ['Confirm Friday call']]),
      mk('Edit Friday TikTok cut'),
      mk('Call the supplier back'),
      mk('Morning planning', [], { done: true, completedAt: now - 140 * min, elapsedMs: 12 * min }),
      mk('Review contract draft', [], { done: true, completedAt: now - 95 * min, elapsedMs: 26 * min }),
    ];
    s.activeId = deck.id;
    s.running = { taskId: deck.id, since: now - (4 * 60 + 12) * 1000 };
    return s;
  }

  return {
    GRADIENTS, LOG_LABELS, STOP_NOTES, BTN_DEFAULTS, BTN_PRESETS, buttonColors, HEX,
    defaultState, defaultSettings, starterState, demoState,
    apply, active, elapsed, find, fmtClock, fmtDur, fmtTime, uid,
  };
});
