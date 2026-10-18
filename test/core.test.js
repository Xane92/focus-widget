// Timer and task logic tests. Run: npm test
const assert = require('node:assert/strict');
const C = require('../src/shared/core.js');

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('ok  ' + name); };
const fresh = (n = 3) => {
  const s = C.defaultState();
  for (let i = 1; i <= n; i++) C.apply(s, { type: 'task/add', payload: { title: 'Task ' + i } }, 1000);
  return s;
};
const T0 = 1_700_000_000_000;

test('first added task becomes active', () => {
  const s = fresh();
  assert.equal(s.activeId, s.tasks[0].id);
});

test('start and stop records exact elapsed time and one session', () => {
  const s = fresh();
  C.apply(s, { type: 'timer/start' }, T0);
  assert.equal(C.elapsed(s, s.tasks[0], T0 + 4200), 4200);
  C.apply(s, { type: 'timer/stop' }, T0 + 5000);
  assert.equal(s.tasks[0].elapsedMs, 5000);
  assert.equal(s.sessions.length, 1);
  assert.deepEqual([s.sessions[0].start, s.sessions[0].end], [T0, T0 + 5000]);
  assert.equal(s.tasks[0].firstStartedAt, T0);
  assert.equal(s.tasks[0].lastStoppedAt, T0 + 5000);
});

test('toggle accumulates across sessions', () => {
  const s = fresh();
  C.apply(s, { type: 'timer/toggle' }, T0);
  C.apply(s, { type: 'timer/toggle' }, T0 + 3000);
  C.apply(s, { type: 'timer/toggle' }, T0 + 10000);
  C.apply(s, { type: 'timer/toggle' }, T0 + 12000);
  assert.equal(s.tasks[0].elapsedMs, 5000);
  assert.equal(s.tasks[0].firstStartedAt, T0);
});

test('switching tasks while running moves the timer', () => {
  const s = fresh();
  const [a, b] = s.tasks;
  C.apply(s, { type: 'timer/start' }, T0);
  C.apply(s, { type: 'task/activate', payload: { id: b.id } }, T0 + 7000);
  assert.equal(a.elapsedMs, 7000);
  assert.equal(s.running.taskId, b.id);
  assert.equal(s.activeId, b.id);
});

test('switching tasks while paused does not start the timer', () => {
  const s = fresh();
  C.apply(s, { type: 'task/activate', payload: { id: s.tasks[2].id } }, T0);
  assert.equal(s.running, null);
  assert.equal(s.activeId, s.tasks[2].id);
});

test('checking off the running task stops it, logs it, moves to next', () => {
  const s = fresh();
  const [a, b] = s.tasks;
  C.apply(s, { type: 'timer/start' }, T0);
  C.apply(s, { type: 'task/toggle', payload: { id: a.id } }, T0 + 60000);
  assert.equal(a.done, true);
  assert.equal(a.completedAt, T0 + 60000);
  assert.equal(a.elapsedMs, 60000);
  assert.equal(s.running, null);
  assert.equal(s.activeId, b.id);
  const done = s.log.find((e) => e.type === 'done');
  assert.equal(done.totalMs, 60000);
  assert.equal(done.startedAt, T0);
});

test('reset zeroes the active task and stops it', () => {
  const s = fresh();
  C.apply(s, { type: 'timer/start' }, T0);
  C.apply(s, { type: 'timer/reset' }, T0 + 9000);
  assert.equal(s.tasks[0].elapsedMs, 0);
  assert.equal(s.running, null);
  assert.equal(s.log.at(-1).type, 'reset');
  assert.equal(s.log.at(-1).totalMs, 9000);
});

test('stop note is kept (sleep, recovery)', () => {
  const s = fresh();
  C.apply(s, { type: 'timer/start' }, T0);
  C.apply(s, { type: 'timer/stop', payload: { note: 'recovered' } }, T0 + 30000);
  assert.equal(s.log.at(-1).note, 'recovered');
  assert.equal(s.tasks[0].elapsedMs, 30000);
});

test('stop time earlier than start never goes negative', () => {
  const s = fresh();
  C.apply(s, { type: 'timer/start' }, T0);
  C.apply(s, { type: 'timer/stop' }, T0 - 5000);
  assert.equal(s.tasks[0].elapsedMs, 0);
});

test('deleting the running task stops the timer', () => {
  const s = fresh();
  const id = s.tasks[0].id;
  C.apply(s, { type: 'timer/start' }, T0);
  C.apply(s, { type: 'task/delete', payload: { id } }, T0 + 1000);
  assert.equal(s.running, null);
  assert.equal(s.tasks.length, 2);
  assert.equal(s.activeId, s.tasks[0].id);
});

test('subtasks toggle and log', () => {
  const s = fresh();
  const t = s.tasks[0];
  C.apply(s, { type: 'sub/add', payload: { id: t.id, title: 'Sub A' } }, T0);
  const sub = t.subtasks[0];
  C.apply(s, { type: 'sub/toggle', payload: { id: t.id, subId: sub.id } }, T0 + 500);
  assert.equal(sub.done, true);
  assert.equal(sub.completedAt, T0 + 500);
  assert.equal(s.log.at(-1).type, 'subdone');
});

test('move reorders tasks', () => {
  const s = fresh();
  const ids = s.tasks.map((t) => t.id);
  C.apply(s, { type: 'task/move', payload: { id: ids[2], to: 0 } }, T0);
  assert.deepEqual(s.tasks.map((t) => t.id), [ids[2], ids[0], ids[1]]);
});

test('clear done archives finished tasks', () => {
  const s = fresh();
  C.apply(s, { type: 'task/toggle', payload: { id: s.tasks[1].id } }, T0);
  C.apply(s, { type: 'task/clearDone' }, T0 + 1);
  assert.equal(s.tasks.length, 2);
  assert.equal(s.archive.length, 1);
});

test('formatting', () => {
  assert.equal(C.fmtClock(0), '00:00');
  assert.equal(C.fmtClock(65000), '01:05');
  assert.equal(C.fmtClock(3661000), '1:01:01');
  assert.equal(C.fmtDur(45000), '45s');
  assert.equal(C.fmtDur(46 * 60000), '46m');
  assert.equal(C.fmtDur(134 * 60000), '2h 14m');
});

test('starter state teaches the widget', () => {
  const s = C.starterState(T0);
  assert.equal(s.tasks.length, 4);
  assert.equal(s.tasks[3].subtasks.length, 3);
});

test('play button colours: defaults, custom, readable icon', () => {
  const d = C.buttonColors(C.defaultSettings());
  assert.deepEqual(d, { idle: '#FBF8F4', idleFg: '#141010', live: '#F0783A', liveFg: '#FBF8F4' });
  const c = C.buttonColors(Object.assign(C.defaultSettings(), { btnIdle: '#3E63DD', btnLive: '#F5D90A' }));
  assert.equal(c.idleFg, '#FBF8F4');
  assert.equal(c.liveFg, '#141010');
  const bad = C.buttonColors(Object.assign(C.defaultSettings(), { btnIdle: 'red' }));
  assert.equal(bad.idle, '#FBF8F4');
});

console.log(`\n${passed} tests passed`);
