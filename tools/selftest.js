// End-to-end self test. Drives the real windows through their UI, checks state and disk, saves screenshots.
// Run (Linux CI / dev): FOCUS_SELFTEST=1 FOCUS_USER_DATA=/tmp/focus-test npx electron .
const fs = require('fs');
const path = require('path');

module.exports = async function selftest(ctx) {
  const out = process.env.FOCUS_SELFTEST_OUT || path.join(process.cwd(), 'selftest-out');
  fs.mkdirSync(out, { recursive: true });
  const results = [];
  const ok = (name, cond, info) => {
    results.push({ name, pass: !!cond, info });
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${info !== undefined ? `  ::  ${JSON.stringify(info)}` : ''}`);
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (win, code) => win.webContents.executeJavaScript(code);
  const shot = async (win, name) => {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(out, `${name}.png`), img.toPNG());
  };
  const loaded = (win) => new Promise((r) => (win.webContents.isLoading() ? win.webContents.once('did-finish-load', r) : r()));
  const click = (win, sel) => js(win, `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`);
  const S = () => ctx.S;

  try {
    const w = ctx.widget();
    await loaded(w);
    await js(w, 'document.fonts.ready.then(() => true)');
    await wait(900);

    ok('first launch seeds 4 starter tasks', S().tasks.length === 4, S().tasks.map((t) => t.title));
    ok('widget window is always on top', w.isAlwaysOnTop());
    ok('widget is visible', w.isVisible());
    ok('no Windows drag regions anywhere in the widget', await js(w, `[...document.querySelectorAll('*')].every((el) => getComputedStyle(el).webkitAppRegion !== 'drag')`));
    {
      // Real mouse click (not a script click) on the play button starts and stops the timer
      const r = await js(w, `(() => { const b = document.querySelector('.hero [data-act=timer]').getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`);
      const press = (cc) => { w.webContents.sendInputEvent({ type: 'mouseDown', x: r.x, y: r.y, button: 'left', clickCount: cc }); w.webContents.sendInputEvent({ type: 'mouseUp', x: r.x, y: r.y, button: 'left', clickCount: cc }); };
      w.webContents.sendInputEvent({ type: 'mouseMove', x: r.x, y: r.y });
      await js(w, `window.__renders = 0; new MutationObserver(() => window.__renders++).observe(document.getElementById('app'), { childList: true });`);
      press(1);
      await wait(1300);
      const startedByMouse = !!S().running;
      const faceAfter = await js(w, `document.querySelector('[data-timer]').textContent`);
      await wait(400);
      press(1);
      await wait(200);
      ok('a real mouse click on play starts the timer and it counts', startedByMouse && faceAfter !== '00:00', faceAfter);
      ok('a second click pauses it', !S().running);
      // Hovering play floats the reset button out; a real click on it zeroes the timer
      w.webContents.sendInputEvent({ type: 'mouseMove', x: r.x, y: r.y });
      await wait(450);
      const rr = await js(w, `(() => { const b = document.querySelector('[data-act=reset]'); const q = b.getBoundingClientRect(); return { o: getComputedStyle(b).opacity, x: Math.round(q.left + q.width / 2), y: Math.round(q.top + q.height / 2) }; })()`);
      ok('hovering play reveals reset beside it', rr.o === '1' && rr.x < r.x, rr);
      await shot(w, '07-reset-hover');
      w.webContents.sendInputEvent({ type: 'mouseMove', x: rr.x, y: rr.y });
      await wait(150);
      w.webContents.sendInputEvent({ type: 'mouseDown', x: rr.x, y: rr.y, button: 'left', clickCount: 1 });
      w.webContents.sendInputEvent({ type: 'mouseUp', x: rr.x, y: rr.y, button: 'left', clickCount: 1 });
      await wait(250);
      const act0 = S().tasks.find((t) => t.id === S().activeId);
      ok('a real click on the floating reset zeroes the timer', act0 && act0.elapsedMs === 0 && S().log.at(-1).type === 'reset', act0 && act0.elapsedMs);
      w.webContents.sendInputEvent({ type: 'mouseMove', x: 5, y: 5 });
      await wait(400);
      ok('reset hides again when the cursor leaves', await js(w, `getComputedStyle(document.querySelector('[data-act=reset]')).opacity === '0'`));
      // Pressing on the card (not a control) starts an app-driven move of the full widget
      await js(w, `(() => { const h = document.querySelector('.hero__task'); const b = h.getBoundingClientRect(); h.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 9, screenX: 50, screenY: 50, clientX: b.left + 2, clientY: b.top + 2 })); })()`);
      await wait(100);
      const fullMoving = ctx.isMoving();
      await js(w, `document.querySelector('.hero__task').dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 9 }))`);
      await wait(100);
      ok('pressing the card moves the full widget, release stops', fullMoving && !ctx.isMoving());
      ctx.dispatch({ type: 'timer/reset' });
      await wait(100);
    }
    ok('top bar with progress, clock and Studio arrow; reset hidden until hover', await js(w, `!!document.querySelector('.bar .progress') && !!document.querySelector('.bar [data-act=studio]') && getComputedStyle(document.querySelector('[data-act=reset]')).opacity === '0'`));
    await shot(w, '01-widget-first-launch');

    // Add a task inline on the widget
    ok('add button exists', await click(w, '[data-act=add]'));
    await wait(120);
    await js(w, `(() => { const i = document.querySelector('[data-input]'); i.value = 'Ship the focus widget'; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
    await wait(250);
    const task = S().tasks.find((t) => t.title === 'Ship the focus widget');
    ok('task added from the widget', !!task);

    await click(w, `[data-id="${task.id}"] [data-act=activate]`);
    await wait(150);
    ok('clicking a task makes it the focus', S().activeId === task.id);

    await click(w, '[data-act=timer]');
    await wait(2300);
    ok('play starts the timer on that task', S().running && S().running.taskId === task.id);
    const face = await js(w, `document.querySelector('[data-timer]').textContent`);
    ok('timer face counts real seconds', face === '00:02', face);
    const metaLine = await js(w, `document.querySelector('[data-meta]').textContent`);
    ok('widget shows real start time', /^since \d/.test(metaLine), metaLine);

    await click(w, '[data-act=timer]');
    await wait(150);
    ok('pause stops and banks the time', !S().running && task.elapsedMs >= 2000 && task.elapsedMs < 3500, task.elapsedMs);

    await click(w, '[data-act=timer]');
    await wait(1100);
    await shot(w, '02-widget-running');
    await click(w, `[data-id="${task.id}"] [data-act=toggle]`);
    await wait(200);
    ok('ticking the running task stops the timer', !S().running);
    ok('ticked task is done with a completion time', task.done && task.completedAt > 0);
    ok('total time is kept', task.elapsedMs >= 3000 && task.elapsedMs < 5000, task.elapsedMs);
    ok('next task becomes the focus', S().activeId && S().activeId !== task.id);
    const kinds = S().log.filter((e) => e.taskId === task.id).map((e) => e.type).join(',');
    ok('log records add, start, stop, start, stop, done', kinds === 'add,start,stop,start,stop,done', kinds);

    // Subtasks dropdown
    const parent = S().tasks.find((t) => t.subtasks.length);
    await click(w, `[data-id="${parent.id}"] [data-act=open]`);
    await wait(400);
    await click(w, `[data-id="${parent.id}"] [data-sub="${parent.subtasks[0].id}"] [data-act=sub]`);
    await wait(150);
    ok('subtask dropdown opens and ticks', parent.open && parent.subtasks[0].done);
    await shot(w, '03-widget-subtasks');

    // Reset
    await click(w, '[data-act=timer]');
    await wait(1100);
    ctx.dispatch({ type: 'timer/reset' });
    await wait(150);
    const act = S().tasks.find((t) => t.id === S().activeId);
    ok('reset zeroes the active task and stops', act.elapsedMs === 0 && !S().running);

    // Persistence
    ctx.saveNow();
    const disk = JSON.parse(fs.readFileSync(ctx.dataFile(), 'utf8'));
    ok('state is saved to disk', disk.tasks.length === S().tasks.length && disk.log.length === S().log.length);

    // Resize
    const b0 = w.getBounds();
    ctx.resizeTo(b0.width + 60, b0.height + 80);
    await wait(300);
    const b1 = w.getBounds();
    ok('widget resizes', b1.width === b0.width + 60 && b1.height === b0.height + 80, b1);
    ctx.resizeTo(10, 10);
    await wait(200);
    const b2 = w.getBounds();
    ok('resize respects the minimum size', b2.width === ctx.MIN.w && b2.height === ctx.MIN.h, b2);
    const cardOnly = await js(w, `getComputedStyle(document.querySelector('.list')).display === 'none' && document.querySelector('.hero').getBoundingClientRect().height > 40`);
    ok('at the smallest size the card fills the window', cardOnly);
    const sizes = await js(w, `({ timer: parseFloat(getComputedStyle(document.querySelector('.timer')).fontSize), btn: document.querySelector('[data-act=timer]').getBoundingClientRect().width })`);
    ok('timer and play button scale down', sizes.timer < 45 && sizes.btn < 45, sizes);
    const bar = await js(w, `({ h: document.querySelector('.bar').getBoundingClientRect().height, font: parseFloat(getComputedStyle(document.querySelector('.pill--dim')).fontSize), arrow: document.querySelector('.pill--light').getBoundingClientRect().width })`);
    ok('top bar shrinks with the window', bar.h <= 32 && bar.font <= 12 && bar.arrow <= 42, bar);
    const fits = await js(w, `(() => { const h = document.querySelector('.hero').getBoundingClientRect(); const t = document.querySelector('.timer').getBoundingClientRect(); const b = document.querySelector('.hero [data-act=timer]').getBoundingClientRect(); return t.bottom <= h.bottom && b.bottom <= h.bottom && t.right <= b.left; })()`);
    ok('at the smallest size nothing overflows the card', fits);
    ok('at the smallest size the task title hides; bar, timer and play stay', await js(w, `getComputedStyle(document.querySelector('.hero__task')).display === 'none' && getComputedStyle(document.querySelector('.bar')).display !== 'none' && !!document.querySelector('.hero [data-act=timer]')`));
    ctx.resizeTo(220, 220);
    await wait(250);
    ok('a bit bigger and the task title is back', await js(w, `getComputedStyle(document.querySelector('.hero__task')).display !== 'none'`));
    ctx.resizeTo(ctx.MIN.w, ctx.MIN.h);
    await wait(250);
    ctx.resizeTo(b0.width, b0.height);
    await wait(200);

    // Mini mode via double-click on the timer
    await js(w, `document.querySelector('[data-timer]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
    await wait(500);
    const mb = w.getBounds();
    ok('double-click timer switches to mini mode', S().settings.compact && mb.width === ctx.MINI.w && mb.height === ctx.MINI.h, mb);
    await click(w, '.mini [data-act=timer]');
    await wait(1300);
    ok('mini play starts the timer', !!S().running);
    ok('mini is one card, no separate dial', await js(w, `!document.querySelector('.dial') && !!document.querySelector('.mini .mini__timer')`));
    await shot(w, '04-mini-running');
    ctx.resizeTo(20, 20);
    await wait(250);
    const mm = w.getBounds();
    ok('mini shrinks from the corner to its minimum', mm.width === ctx.MINI_MIN.w && mm.height === ctx.MINI_MIN.h, mm);
    ctx.resizeTo(230, 62);
    await wait(250);
    const ms = w.getBounds();

    // Moving the mini is done by the app (no OS drag region), so test the move path directly
    ok('mini card is not an OS drag region', await js(w, `getComputedStyle(document.querySelector('.mini')).webkitAppRegion !== 'drag'`));
    await js(w, `(() => { const c = document.querySelector('.mini__in'); const r = c.getBoundingClientRect(); c.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 7, screenX: 100, screenY: 100, clientX: r.left + 4, clientY: r.top + 10 })); })()`);
    await wait(100);
    ok('pressing on the mini starts a move', ctx.isMoving());
    await js(w, `document.querySelector('.mini__in').dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 7 }))`);
    await wait(100);
    ok('releasing ends the move', !ctx.isMoving());
    ctx.moveStart({ x: 500, y: 500 });
    ctx.moveTo({ x: 440, y: 560 });
    await wait(200);
    const mv = w.getBounds();
    ok('mini follows the cursor and keeps its size', mv.x === ms.x - 60 && mv.y === ms.y + 60 && mv.width === ms.width && mv.height === ms.height, mv);
    ctx.moveTo({ x: 500, y: 500 });
    ctx.moveEnd();
    await wait(200);

    // Real mouse double-click on the card body (not the timer) expands it
    const send = (type, x, y, clickCount) => w.webContents.sendInputEvent({ type, x, y, button: 'left', clickCount });
    const px = 16, py = Math.round(ms.height / 2);
    send('mouseMove', px, py, 0);
    send('mouseDown', px, py, 1); send('mouseUp', px, py, 1);
    send('mouseDown', px, py, 2); send('mouseUp', px, py, 2);
    await wait(500);
    const fb = w.getBounds();
    ok('expand restores the full size', !S().settings.compact && fb.width === b0.width && fb.height === b0.height, fb);
    ctx.dispatch({ type: 'settings/set', payload: { key: 'compact', value: true } });
    await wait(400);
    const mb2 = w.getBounds();
    ok('mini remembers its own size', mb2.width === ms.width && mb2.height === ms.height, mb2);
    ctx.dispatch({ type: 'settings/set', payload: { key: 'compact', value: false } });
    await wait(400);

    // Size gallery with a photo (test image only)
    if (process.env.FOCUS_TEST_PHOTO) {
      ctx.dispatch({ type: 'settings/set', payload: { key: 'photo', value: process.env.FOCUS_TEST_PHOTO } });
      ctx.dispatch({ type: 'timer/start' });
      await wait(1200);
      const gallery = [['20-full', 378, 608], ['21-small', 250, 330], ['22-card', 240, 170], ['23-tiny', 200, 150], ['23b-tiniest', 178, 118]];
      for (const [name, gw, gh] of gallery) { ctx.resizeTo(gw, gh); await wait(450); await shot(w, name); }
      ctx.resizeTo(b0.width, b0.height);
      ctx.dispatch({ type: 'settings/set', payload: { key: 'compact', value: true } });
      await wait(400);
      for (const [name, gw, gh] of [['24-mini', 308, 84], ['25-mini-min', 158, 62], ['26-mini-wide', 420, 110]]) { ctx.resizeTo(gw, gh); await wait(450); await shot(w, name); }
      ctx.resizeTo(ms.width, ms.height);
      await wait(200);
      ctx.dispatch({ type: 'settings/set', payload: { key: 'compact', value: false } });
      await wait(400);
      ctx.dispatch({ type: 'settings/set', payload: { key: 'photo', value: null } });
      ctx.dispatch({ type: 'timer/stop' });
    }

    // Tuck into a screen edge
    const { screen } = require('electron');
    const wa = screen.getPrimaryDisplay().workArea;
    const before = w.getBounds();
    w.setBounds({ x: wa.x - Math.round(before.width * 0.6), y: 300, width: before.width, height: before.height });
    await wait(200);
    ok('pushed past the left edge, it tucks in', ctx.dockIfAtEdge({ x: wa.x + 200, y: 400 }) && !!S().window.dock);
    await wait(300);
    const tb = w.getBounds();
    ok('only a small tab stays, flush with the edge', tb.x === wa.x && tb.width === ctx.TAB.w && tb.height === ctx.TAB.h, tb);
    ok('tab shows an arrow pointing back in', await js(w, `!!document.querySelector('.tab--left .ph-caret-right')`));
    await shot(w, '30-tab-left');
    await click(w, '[data-act=undock]');
    await wait(400);
    const ub = w.getBounds();
    ok('clicking the tab brings it back, same size, fully on screen', !S().window.dock && ub.width === before.width && ub.height === before.height && ub.x >= wa.x, ub);
    w.setBounds({ x: wa.x + wa.width - 40, y: 200, width: before.width, height: before.height });
    await wait(200);
    ok('pushed past the right edge, it tucks in', ctx.dockIfAtEdge({ x: wa.x + wa.width - 300, y: 300 }) && S().window.dock.side === 'right');
    await wait(200);
    ok('right tab sits flush right', w.getBounds().x === wa.x + wa.width - ctx.TAB.w);
    ctx.toggleWidget();
    await wait(400);
    ok('the show/hide hotkey pulls a tucked widget back out', !S().window.dock && w.isVisible() && w.getBounds().width === before.width);
    ok('a normal drop near the middle does not tuck', !ctx.dockIfAtEdge({ x: wa.x + 600, y: 400 }));
    // mini tucks too, and comes back as the mini
    ctx.dispatch({ type: 'settings/set', payload: { key: 'compact', value: true } });
    await wait(400);
    ctx.moveStart({ x: 600, y: 400 });
    ctx.moveTo({ x: 600 - (w.getBounds().x - wa.x) - 200, y: 400 });
    ctx.moveEnd({ x: wa.x, y: 400 });
    await wait(300);
    ok('dragging the mini off the edge tucks it', !!S().window.dock && w.getBounds().width === ctx.TAB.w);
    await click(w, '[data-act=undock]');
    await wait(400);
    ok('the mini comes back as the mini', S().settings.compact && !S().window.dock && w.getBounds().height === ms.height, w.getBounds());
    ctx.dispatch({ type: 'settings/set', payload: { key: 'compact', value: false } });
    await wait(400);
    ctx.resizeTo(before.width, before.height);

    // Hotkey toggle
    ctx.toggleWidget();
    await wait(200);
    ok('hide works', !w.isVisible());
    ctx.toggleWidget();
    await wait(200);
    ok('show works', w.isVisible());

    // Play button colours
    ctx.dispatch({ type: 'timer/stop' });
    ctx.dispatch({ type: 'settings/set', payload: { key: 'btnIdle', value: '#3E63DD' } });
    await wait(600);
    const col = await js(w, `({ bg: getComputedStyle(document.querySelector('[data-act=timer]')).backgroundColor, fg: getComputedStyle(document.querySelector('[data-act=timer]')).color })`);
    ok('custom paused colour reaches the widget with a readable icon', col.bg === 'rgb(62, 99, 221)' && col.fg === 'rgb(251, 248, 244)', col);
    await shot(w, '06-custom-colour');
    ctx.dispatch({ type: 'settings/set', payload: { key: 'btnIdle', value: null } });
    await wait(150);

    // Studio, opened from the widget's arrow
    await click(w, '[data-act=studio]');
    await wait(800);
    const st = ctx.studio();
    await loaded(st);
    await js(st, 'document.fonts.ready.then(() => true)');
    await wait(700);
    ok('studio opens', !!st && st.isVisible());

    // Add a task + subtask in the Studio
    await js(st, `(() => { const i = document.querySelector('[data-key="add-task"]'); i.value = 'Record the demo video'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
    await wait(250);
    const t2 = S().tasks.find((t) => t.title === 'Record the demo video');
    ok('studio adds tasks', !!t2);
    await click(st, `[data-id="${t2.id}"] [data-act=expand]`);
    await wait(200);
    await js(st, `(() => { const i = document.querySelector('[data-key="as-${t2.id}"]'); i.value = 'Write the script'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
    await wait(250);
    ok('studio adds subtasks', t2.subtasks.length === 1 && t2.subtasks[0].title === 'Write the script');
    await js(st, `(() => { const i = document.querySelector('[data-key="t-${t2.id}"]'); i.focus(); i.value = 'Record the launch video'; i.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await wait(250);
    ok('studio edits titles', t2.title === 'Record the launch video');
    const widgetSees = await js(w, `document.body.textContent.includes('Record the launch video')`);
    ok('widget updates live from the studio', widgetSees);

    // Two-click delete
    const victim = S().tasks.find((t) => t.title.startsWith('Double-click'));
    await click(st, `[data-id="${victim.id}"] [data-act=delete]`);
    await wait(100);
    ok('first delete click only arms', !!S().tasks.find((t) => t.id === victim.id));
    await click(st, `[data-id="${victim.id}"] [data-act=delete]`);
    await wait(200);
    ok('second click deletes', !S().tasks.find((t) => t.id === victim.id));

    // Reorder
    const ids = S().tasks.map((t) => t.id);
    ctx.dispatch({ type: 'task/move', payload: { id: ids[ids.length - 1], to: 0 } });
    ok('reorder works', S().tasks[0].id === ids[ids.length - 1]);

    // Settings round trip
    await js(st, `document.querySelector('[data-act=nav][data-val=appearance]').click()`);
    await wait(200);
    await click(st, '[data-act=gradient][data-val=night]');
    await wait(200);
    ok('gradient change applies', S().settings.gradient === 'night');
    await click(st, '[data-act=color][data-setting=btnLive][data-val="#3E63DD"]');
    await wait(200);
    ok('studio sets the running colour', S().settings.btnLive === '#3E63DD');
    const liveCol = await js(w, `getComputedStyle(document.documentElement).getPropertyValue('--btn-live').trim()`);
    ok('widget picks up the running colour', liveCol === '#3E63DD', liveCol);
    await click(st, '[data-act=color-reset][data-setting=btnLive]');
    await wait(200);
    ok('Default restores the running colour', S().settings.btnLive === null);
    await click(st, '[data-act=gradient][data-val=dusk]');
    await wait(150);

    // Screens: studio views, light then dark
    ctx.dispatch({ type: 'timer/start' });
    await wait(1200);
    for (const theme of ['light', 'dark']) {
      ctx.dispatch({ type: 'settings/set', payload: { key: 'theme', value: theme } });
      await wait(500);
      for (const v of ['tasks', 'appearance', 'logs', 'settings']) {
        st.webContents.send('studio:view', v);
        await wait(450);
        await shot(st, `10-studio-${v}-${theme}`);
        if (v === 'appearance') {
          await js(st, `document.querySelector('.main').scrollTop = 430`);
          await wait(250);
          await shot(st, `11-studio-buttons-${theme}`);
        }
      }
      await shot(w, `05-widget-${theme}`);
    }
    ctx.dispatch({ type: 'settings/set', payload: { key: 'theme', value: 'auto' } });

    // CSV
    const csvEvents = ctx.buildCsv('events');
    const csvTasks = ctx.buildCsv('tasks');
    fs.writeFileSync(path.join(out, 'activity.csv'), csvEvents);
    fs.writeFileSync(path.join(out, 'tasks.csv'), csvTasks);
    ok('activity CSV has a row per log entry', csvEvents.trim().split('\r\n').length === S().log.length + 1);
    ok('tasks CSV lists every task', csvTasks.trim().split('\r\n').length === S().tasks.length + S().archive.length + 1);

    // Console errors in either window
    const errs = await js(w, 'window.__errors || []');
    ok('no renderer errors', errs.length === 0, errs);
  } catch (e) {
    ok('selftest crashed', false, String((e && e.stack) || e));
  }

  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\nSELFTEST: ${results.length - failed}/${results.length} passed`);
  ctx.quit(failed ? 1 : 0);
};
