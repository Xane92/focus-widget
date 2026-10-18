'use strict';
/* Focus: main process. Owns the state, the always-on-top widget, the Studio, the tray and the hotkeys. */
const {
  app, BrowserWindow, ipcMain, Tray, Menu, globalShortcut, screen, dialog, shell, nativeTheme, nativeImage, powerMonitor,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL, fileURLToPath } = require('url');
const Core = require('./src/shared/core.js');

if (process.env.FOCUS_USER_DATA) app.setPath('userData', process.env.FOCUS_USER_DATA);
const SELFTEST = !!process.env.FOCUS_SELFTEST;

const FULL = { w: 370, h: 600 };
const MIN = { w: 170, h: 110 };
const TAB = { w: 26, h: 76 }; // the pull-out tab when tucked into a screen edge
const MAX = { w: 680, h: 1200 };
const MINI = { w: 300, h: 76 };
const MINI_MIN = { w: 150, h: 54 };
const MINI_MAX = { w: 560, h: 130 };
const MARGIN = 24;
const ASSETS = path.join(__dirname, 'src', 'assets');
const ICON = path.join(ASSETS, 'icon.png');

let S = null;
let widget = null;
let studio = null;
let tray = null;
let quitting = false;
let resizing = null;
let saveTimer = null;
const hotkeyStatus = { hotkey: false, timerHotkey: false };

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));
const alive = (w) => w && !w.isDestroyed();

/* ---------- Storage ---------- */
const dataFile = () => path.join(app.getPath('userData'), 'focus-data.json');
const photoDir = () => path.join(app.getPath('userData'), 'photos');

function migrate(raw) {
  const s = Object.assign(Core.defaultState(), raw);
  s.settings = Object.assign(Core.defaultSettings(), raw.settings || {});
  for (const k of ['tasks', 'archive', 'sessions', 'log']) if (!Array.isArray(s[k])) s[k] = [];
  for (const t of s.tasks) if (!Array.isArray(t.subtasks)) t.subtasks = [];
  return s;
}

function load() {
  const f = dataFile();
  try {
    const s = migrate(JSON.parse(fs.readFileSync(f, 'utf8')));
    try { fs.copyFileSync(f, f.replace(/\.json$/, '.backup.json')); } catch (_) { /* best effort */ }
    return s;
  } catch (e) {
    if (e.code !== 'ENOENT') {
      try { fs.renameSync(f, f.replace(/\.json$/, `.broken-${Date.now()}.json`)); } catch (_) { /* ignore */ }
    }
    return Core.starterState(Date.now());
  }
}

function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const f = dataFile();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const json = JSON.stringify(S);
  const tmp = f + '.tmp';
  try {
    fs.writeFileSync(tmp, json);
    fs.renameSync(tmp, f);
  } catch (_) {
    fs.writeFileSync(f, json); // antivirus or a locked file can block rename on Windows
  }
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { try { saveNow(); } catch (e) { console.error('save failed', e); } }, 250);
}

/* ---------- State ---------- */
function slim(s) { return Object.assign({}, s, { log: [], sessions: [], archive: [] }); }

function broadcast() {
  if (alive(widget)) widget.webContents.send('state', slim(S));
  if (alive(studio)) studio.webContents.send('state', S);
}

function dispatch(action) {
  if (!action || typeof action.type !== 'string') return false;
  const prev = Object.assign({}, S.settings);
  Core.apply(S, action, Date.now());
  if (S.running) S.heartbeat = Date.now();
  sideEffects(prev, S.settings);
  save();
  broadcast();
  updateTray();
  return true;
}

function sideEffects(p, n) {
  if (p.compact !== n.compact) setCompact(!!n.compact);
  if (p.opacity !== n.opacity && alive(widget)) widget.setOpacity(clamp(Number(n.opacity) || 1, 0.35, 1));
  if (p.alwaysOnTop !== n.alwaysOnTop && alive(widget)) widget.setAlwaysOnTop(!!n.alwaysOnTop, 'screen-saver');
  if (p.launchAtLogin !== n.launchAtLogin) applyLoginItem();
  if (p.hotkey !== n.hotkey || p.timerHotkey !== n.timerHotkey) registerHotkeys();
  if (p.theme !== n.theme) nativeTheme.themeSource = themeSource(n.theme);
  if (p.photo && p.photo !== n.photo) removeOwnedPhoto(p.photo);
}

const themeSource = (t) => (t === 'light' || t === 'dark' ? t : 'system');

// Close a timer session that was left running by a crash or power loss at the last moment the app was alive.
function recover() {
  if (!S.running) return;
  const last = Math.max(S.heartbeat || S.running.since, S.running.since);
  if (Date.now() - last > 120000) {
    Core.apply(S, { type: 'timer/stop', payload: { note: 'recovered' } }, last);
    saveNow();
  }
}

function heartbeat() {
  if (!S.running) return;
  S.heartbeat = Date.now();
  save();
}

function pauseFor(note) {
  if (S && S.running) dispatch({ type: 'timer/stop', payload: { note } });
}

/* ---------- Widget window ---------- */
function defaultPos(w) {
  const wa = screen.getPrimaryDisplay().workArea;
  return { x: wa.x + wa.width - w - MARGIN, y: wa.y + MARGIN };
}

function fit(b) {
  const wa = screen.getDisplayMatching(b).workArea;
  const visible = b.x < wa.x + wa.width - 40 && b.x + b.width > wa.x + 40 && b.y < wa.y + wa.height - 40 && b.y + b.height > wa.y;
  let { x, y } = b;
  if (!visible) ({ x, y } = defaultPos(b.width));
  const area = visible ? wa : screen.getPrimaryDisplay().workArea;
  x = clamp(x, area.x, area.x + area.width - b.width);
  y = clamp(y, area.y, area.y + area.height - b.height);
  return { x: Math.round(x), y: Math.round(y), width: Math.round(b.width), height: Math.round(b.height) };
}

function fullSize() {
  const w = S.window || {};
  return { w: clamp(w.w || FULL.w, MIN.w, MAX.w), h: clamp(w.h || FULL.h, MIN.h, MAX.h) };
}
function miniSize() {
  const w = S.window || {};
  return { w: clamp(w.mw || MINI.w, MINI_MIN.w, MINI_MAX.w), h: clamp(w.mh || MINI.h, MINI_MIN.h, MINI_MAX.h) };
}
const limits = () => (S.settings.compact ? [MINI_MIN, MINI_MAX] : [MIN, MAX]);

function initialBounds() {
  if (S.window && S.window.dock) return dockBounds(S.window.dock);
  const size = S.settings.compact ? miniSize() : fullSize();
  const w = S.window || {};
  const pos = Number.isFinite(w.x) && Number.isFinite(w.y) ? { x: w.x, y: w.y } : defaultPos(size.w);
  return fit({ x: pos.x, y: pos.y, width: size.w, height: size.h });
}

function saveBounds() {
  if (!alive(widget)) return;
  if (S.window && S.window.dock) { save(); return; } // the tab's size is not the widget's size
  const b = widget.getBounds();
  S.window = Object.assign({}, S.window, { x: b.x, y: b.y });
  if (S.settings.compact) Object.assign(S.window, { mw: b.width, mh: b.height });
  else Object.assign(S.window, { w: b.width, h: b.height });
  save();
}

function setCompact(on) {
  if (!alive(widget)) return;
  if (S.window && S.window.dock) undock();
  const b = widget.getBounds();
  if (on) {
    S.window = Object.assign({}, S.window, { x: b.x, y: b.y, w: b.width, h: b.height });
    const m = miniSize();
    widget.setBounds(fit({ x: b.x, y: b.y, width: m.w, height: m.h }));
  } else {
    S.window = Object.assign({}, S.window, { x: b.x, y: b.y, mw: b.width, mh: b.height });
    const f = fullSize();
    widget.setBounds(fit({ x: b.x, y: b.y, width: f.w, height: f.h }));
  }
  saveBounds();
}

function createWidget() {
  const b = initialBounds();
  widget = new BrowserWindow({
    x: b.x, y: b.y, width: b.width, height: b.height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: !!S.settings.alwaysOnTop,
    show: false,
    title: 'Focus',
    icon: ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  if (S.settings.alwaysOnTop) widget.setAlwaysOnTop(true, 'screen-saver');
  widget.setOpacity(clamp(Number(S.settings.opacity) || 1, 0.35, 1));
  widget.loadFile(path.join(__dirname, 'src', 'widget', 'index.html'));
  widget.once('ready-to-show', () => showWidget());

  let moveTimer = null;
  widget.on('move', () => { clearTimeout(moveTimer); moveTimer = setTimeout(saveBounds, 300); });
  widget.on('blur', () => { if (S.settings.alwaysOnTop && alive(widget)) widget.setAlwaysOnTop(true, 'screen-saver'); });
  widget.on('close', (e) => { if (!quitting) { e.preventDefault(); hideWidget(); } });
  widget.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  widget.webContents.on('will-navigate', (e) => e.preventDefault());
}

function showWidget() {
  if (!alive(widget)) return;
  widget.showInactive();
  if (S.settings.alwaysOnTop) widget.setAlwaysOnTop(true, 'screen-saver');
  sendMeta();
  updateTray();
}
function hideWidget() {
  if (!alive(widget)) return;
  widget.hide();
  sendMeta();
  updateTray();
}
function toggleWidget() {
  if (!alive(widget)) return;
  if (widget.isVisible() && S.window && S.window.dock) { undock(); return; } // the hotkey pulls a tucked widget back out
  if (widget.isVisible()) hideWidget(); else showWidget();
}
function ensureVisible() {
  if (!alive(widget)) return;
  if (S.window && S.window.dock) widget.setBounds(dockBounds(S.window.dock));
  else widget.setBounds(fit(widget.getBounds()));
}

/* ---------- Tuck into a screen edge (like a picture-in-picture video) ---------- */
// Is there a screen past this edge? A shared edge between two monitors is not a place to tuck into.
function outerEdge(side, x, y) {
  const probe = { x: side === 'left' ? x - 2 : x + 2, y };
  return !screen.getAllDisplays().some((d) => probe.x >= d.bounds.x && probe.x < d.bounds.x + d.bounds.width && probe.y >= d.bounds.y && probe.y < d.bounds.y + d.bounds.height);
}

function dockBounds(dock) {
  const disp = screen.getDisplayNearestPoint({ x: dock.side === 'left' ? dock.edgeX + 1 : dock.edgeX - 1, y: dock.y });
  const wa = disp.workArea;
  const x = dock.side === 'left' ? wa.x : wa.x + wa.width - TAB.w;
  const y = Math.round(clamp(dock.y - TAB.h / 2, wa.y, wa.y + wa.height - TAB.h));
  return { x, y, width: TAB.w, height: TAB.h };
}

// After a move ends: if the widget was pushed a quarter past the left or right screen edge,
// or let go with the cursor at the edge, tuck it in and leave a small tab.
function dockIfAtEdge(cursor) {
  if (!alive(widget) || (S.window && S.window.dock)) return false;
  const b = widget.getBounds();
  const wa = screen.getDisplayMatching(b).workArea;
  const p = cursor || screen.getCursorScreenPoint();
  const midY = b.y + b.height / 2;
  let side = null;
  if (b.x < wa.x - b.width * 0.25 || p.x <= wa.x + 1) side = 'left';
  else if (b.x + b.width > wa.x + wa.width + b.width * 0.25 || p.x >= wa.x + wa.width - 2) side = 'right';
  if (!side) return false;
  const edgeX = side === 'left' ? wa.x : wa.x + wa.width;
  if (!outerEdge(side, edgeX, clamp(midY, wa.y, wa.y + wa.height - 1))) return false;
  const back = fit(b); // where it comes back to, fully on screen
  S.window = Object.assign({}, S.window, { x: back.x, y: back.y, dock: { side, edgeX, y: Math.round(midY) } });
  widget.setBounds(dockBounds(S.window.dock));
  save();
  broadcast();
  return true;
}

function undock() {
  if (!alive(widget) || !S.window || !S.window.dock) return;
  const size = S.settings.compact ? miniSize() : fullSize();
  S.window = Object.assign({}, S.window, { dock: null });
  widget.setBounds(fit({ x: S.window.x, y: S.window.y, width: size.w, height: size.h }));
  saveBounds();
  broadcast();
}

function resizeTo(w, h) {
  if (!alive(widget) || (S.window && S.window.dock)) return;
  const [lo, hi] = limits();
  const b = widget.getBounds();
  widget.setBounds({ x: b.x, y: b.y, width: Math.round(clamp(w, lo.w, hi.w)), height: Math.round(clamp(h, lo.h, hi.h)) });
}

// Moving the mini: follow the cursor from where the drag started, keeping the size fixed.
let moving = null;
function moveStart(p) {
  if (!alive(widget)) return;
  p = p || screen.getCursorScreenPoint();
  const b = widget.getBounds();
  moving = { px: p.x, py: p.y, x: b.x, y: b.y, width: b.width, height: b.height };
}
function moveTo(p) {
  if (!moving || !alive(widget)) return;
  p = p || screen.getCursorScreenPoint();
  widget.setBounds({ x: Math.round(moving.x + p.x - moving.px), y: Math.round(moving.y + p.y - moving.py), width: moving.width, height: moving.height });
}
function moveEnd(cursor) {
  if (!moving) return;
  moving = null;
  if (!dockIfAtEdge(cursor)) saveBounds();
}

/* ---------- Studio window ---------- */
function overlay() {
  const dark = nativeTheme.shouldUseDarkColors;
  return { color: dark ? '#1E1D1F' : '#E7E8EB', symbolColor: dark ? '#EDEAE5' : '#141010', height: 44 };
}

function openStudio(view) {
  if (alive(studio)) {
    if (studio.isMinimized()) studio.restore();
    studio.show();
    studio.focus();
    if (view) studio.webContents.send('studio:view', view);
    return;
  }
  studio = new BrowserWindow({
    width: 1080,
    height: 740,
    minWidth: 860,
    minHeight: 580,
    show: false,
    title: 'Focus Studio',
    icon: ICON,
    backgroundColor: overlay().color,
    titleBarStyle: 'hidden',
    titleBarOverlay: overlay(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  studio.loadFile(path.join(__dirname, 'src', 'studio', 'index.html'), view ? { query: { view } } : undefined);
  studio.once('ready-to-show', () => { studio.show(); });
  studio.on('closed', () => { studio = null; });
  studio.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  studio.webContents.on('will-navigate', (e) => e.preventDefault());
}

/* ---------- Tray ---------- */
function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(ASSETS, 'tray.png')));
  tray.on('click', toggleWidget);
  updateTray();
}

function updateTray() {
  if (!tray) return;
  const a = Core.active(S);
  const live = !!(a && S.running && S.running.taskId === a.id);
  tray.setToolTip(a ? `Focus: ${a.title}` : 'Focus');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: alive(widget) && widget.isVisible() ? 'Hide widget' : 'Show widget', click: toggleWidget },
    { label: 'Open Studio', click: () => openStudio() },
    { type: 'separator' },
    { label: live ? 'Pause timer' : 'Start timer', enabled: !!a, click: () => dispatch({ type: 'timer/toggle' }) },
    { label: 'Reset timer', enabled: !!(a && Core.elapsed(S, a, Date.now()) > 0), click: () => dispatch({ type: 'timer/reset' }) },
    { label: 'Mini mode', type: 'checkbox', checked: !!S.settings.compact, click: (m) => dispatch({ type: 'settings/set', payload: { key: 'compact', value: m.checked } }) },
    { label: 'Always on top', type: 'checkbox', checked: !!S.settings.alwaysOnTop, click: (m) => dispatch({ type: 'settings/set', payload: { key: 'alwaysOnTop', value: m.checked } }) },
    { type: 'separator' },
    ...(updateReady ? [{ label: `Restart to update (v${updateReady})`, click: installUpdate }, { type: 'separator' }] : []),
    { label: 'Quit Focus', click: () => app.quit() },
  ]));
}

/* ---------- Auto-update (GitHub Releases) ---------- */
// Installed copies check for a newer release on launch and every 4 hours, download it quietly,
// and install it on the next restart. "Restart to update" in the tray or Studio applies it now.
let updateReady = null;
let updater = null;
function setupUpdates() {
  if (!app.isPackaged || SELFTEST) return;
  try {
    ({ autoUpdater: updater } = require('electron-updater'));
  } catch (_) { return; }
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.on('update-downloaded', (info) => { updateReady = info && info.version; sendMeta(); updateTray(); });
  updater.on('error', () => { /* offline, or no release yet: try again later */ });
  const check = () => { try { updater.checkForUpdates().catch(() => {}); } catch (_) { /* ignore */ } };
  setTimeout(check, 8000);
  setInterval(check, 4 * 60 * 60 * 1000);
}
function installUpdate() {
  if (!updater || !updateReady) return;
  quitting = true;
  try { saveNow(); } catch (_) { /* ignore */ }
  updater.quitAndInstall(true, true);
}

/* ---------- Hotkeys, login item, meta ---------- */
function tryRegister(accel, fn) {
  if (!accel) return false;
  try { return globalShortcut.register(accel, fn); } catch (_) { return false; }
}

function registerHotkeys() {
  globalShortcut.unregisterAll();
  hotkeyStatus.hotkey = tryRegister(S.settings.hotkey, toggleWidget);
  hotkeyStatus.timerHotkey = tryRegister(S.settings.timerHotkey, () => dispatch({ type: 'timer/toggle' }));
  sendMeta();
}

function applyLoginItem() {
  if (SELFTEST) return;
  const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  try {
    app.setLoginItemSettings({
      openAtLogin: !!S.settings.launchAtLogin,
      path: exe,
      args: app.isPackaged ? [] : [path.resolve(app.getAppPath())],
    });
  } catch (_) { /* unsupported platform */ }
}

function meta() {
  return {
    version: app.getVersion(),
    dataPath: app.getPath('userData'),
    hotkeys: Object.assign({}, hotkeyStatus),
    widgetVisible: alive(widget) && widget.isVisible(),
    updateReady,
    platform: process.platform,
  };
}
function sendMeta() {
  const m = meta();
  if (alive(widget)) widget.webContents.send('meta', m);
  if (alive(studio)) studio.webContents.send('meta', m);
}

/* ---------- Photos ---------- */
function isOwnedPhoto(url) {
  try {
    const p = fileURLToPath(url);
    return path.dirname(p) === photoDir();
  } catch (_) { return false; }
}
function removeOwnedPhoto(url) {
  if (isOwnedPhoto(url)) fs.rm(fileURLToPath(url), { force: true }, () => {});
}

async function pickPhoto() {
  const r = await dialog.showOpenDialog(alive(studio) ? studio : widget, {
    title: 'Choose a photo',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'bmp'] }],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  const src = r.filePaths[0];
  fs.mkdirSync(photoDir(), { recursive: true });
  const dest = path.join(photoDir(), `photo-${Date.now()}${path.extname(src).toLowerCase() || '.jpg'}`);
  fs.copyFileSync(src, dest);
  const url = pathToFileURL(dest).href;
  dispatch({ type: 'settings/set', payload: { key: 'photo', value: url } });
  dispatch({ type: 'settings/set', payload: { key: 'showPhoto', value: true } });
  return url;
}

/* ---------- CSV export ---------- */
const csvCell = (v) => { const s = v == null ? '' : String(v); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const csv = (rows) => '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
const dPart = (ts) => (ts ? new Date(ts).toLocaleDateString('en-CA') : '');
const tPart = (ts) => (ts ? new Date(ts).toLocaleTimeString('en-GB', { hour12: false }) : '');
const stamp = (ts) => (ts ? `${dPart(ts)} ${tPart(ts)}` : '');
const mins = (ms) => (ms == null ? '' : (ms / 60000).toFixed(1));

function buildCsv(kind) {
  const now = Date.now();
  if (kind === 'tasks') {
    const rows = [['Task', 'Status', 'Subtasks done', 'Created', 'First started', 'Completed', 'Focused minutes', 'Sessions']];
    for (const t of [...S.tasks, ...S.archive]) {
      const live = S.running && S.running.taskId === t.id ? now - S.running.since : 0;
      rows.push([
        t.title, t.done ? 'Done' : 'Open', `${t.subtasks.filter((x) => x.done).length}/${t.subtasks.length}`,
        stamp(t.createdAt), stamp(t.firstStartedAt), stamp(t.completedAt), mins(t.elapsedMs + live),
        S.sessions.filter((x) => x.taskId === t.id).length + (live ? 1 : 0),
      ]);
    }
    return csv(rows);
  }
  const rows = [['Date', 'Time', 'Event', 'Task', 'Subtask', 'Session minutes', 'Task total minutes', 'Started at', 'Note']];
  for (const e of S.log) {
    rows.push([
      dPart(e.at), tPart(e.at), Core.LOG_LABELS[e.type] || e.type, e.title, e.subTitle || '',
      mins(e.durationMs), mins(e.totalMs), stamp(e.startedAt), e.note ? Core.STOP_NOTES[e.note] || e.note : '',
    ]);
  }
  return csv(rows);
}

async function exportCsv(kind) {
  const name = `focus-${kind === 'tasks' ? 'tasks' : 'activity'}-${new Date().toLocaleDateString('en-CA')}.csv`;
  const r = await dialog.showSaveDialog(alive(studio) ? studio : widget, {
    title: 'Export CSV',
    defaultPath: path.join(app.getPath('documents'), name),
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, buildCsv(kind));
  return r.filePath;
}

/* ---------- IPC ---------- */
function wireIpc() {
  ipcMain.handle('state:get', (e) => (alive(widget) && e.sender === widget.webContents ? slim(S) : S));
  ipcMain.handle('state:dispatch', (_e, action) => dispatch(action));
  ipcMain.handle('meta:get', () => meta());
  ipcMain.handle('photo:pick', () => pickPhoto());
  ipcMain.handle('export:csv', (_e, kind) => exportCsv(kind));
  ipcMain.handle('data:open', () => shell.openPath(app.getPath('userData')));
  ipcMain.on('studio:open', (_e, view) => openStudio(view));
  ipcMain.on('widget:toggle', () => toggleWidget());

  ipcMain.on('resize:start', () => {
    if (!alive(widget)) return;
    const b = widget.getBounds();
    const p = screen.getCursorScreenPoint();
    resizing = { px: p.x, py: p.y, w: b.width, h: b.height };
  });
  ipcMain.on('resize:move', () => {
    if (!resizing) return;
    const p = screen.getCursorScreenPoint();
    resizeTo(resizing.w + p.x - resizing.px, resizing.h + p.y - resizing.py);
  });
  ipcMain.on('resize:end', () => { resizing = null; saveBounds(); });
  ipcMain.on('move:start', () => moveStart());
  ipcMain.on('move:move', () => moveTo());
  ipcMain.on('move:end', () => moveEnd());
  ipcMain.on('dock:release', () => undock());
  ipcMain.on('update:install', () => installUpdate());

  ipcMain.on('widget:menu', () => {
    if (!alive(widget)) return;
    const a = Core.active(S);
    Menu.buildFromTemplate([
      { label: 'Open Studio', click: () => openStudio() },
      { label: 'Reset timer', enabled: !!(a && Core.elapsed(S, a, Date.now()) > 0), click: () => dispatch({ type: 'timer/reset' }) },
      { type: 'separator' },
      { label: 'Mini mode', type: 'checkbox', checked: !!S.settings.compact, click: (m) => dispatch({ type: 'settings/set', payload: { key: 'compact', value: m.checked } }) },
      { label: 'Hide widget', click: hideWidget },
      { type: 'separator' },
      { label: 'Quit Focus', click: () => app.quit() },
    ]).popup({ window: widget });
  });
}

/* ---------- Boot ---------- */
function ready() {
  Menu.setApplicationMenu(null);
  S = load();
  recover();
  nativeTheme.themeSource = themeSource(S.settings.theme);
  wireIpc();
  createWidget();
  createTray();
  registerHotkeys();
  if (app.isPackaged) applyLoginItem();
  setInterval(heartbeat, 30000);
  setupUpdates();

  powerMonitor.on('suspend', () => pauseFor('sleep'));
  powerMonitor.on('shutdown', () => { pauseFor('shutdown'); try { saveNow(); } catch (_) { /* ignore */ } });
  nativeTheme.on('updated', () => {
    if (!alive(studio)) return;
    try { studio.setTitleBarOverlay(overlay()); studio.setBackgroundColor(overlay().color); } catch (_) { /* unsupported */ }
  });
  screen.on('display-removed', ensureVisible);
  screen.on('display-metrics-changed', ensureVisible);

  if (SELFTEST) {
    require('./tools/selftest.js')({
      get S() { return S; },
      dispatch, saveNow, dataFile, buildCsv, openStudio, resizeTo, toggleWidget, MINI, MINI_MIN, MIN, FULL,
      moveStart, moveTo, moveEnd, isMoving: () => !!moving, dockIfAtEdge, undock, TAB,
      widget: () => widget,
      studio: () => studio,
      quit: (code) => { quitting = true; try { saveNow(); } catch (_) { /* ignore */ } app.exit(code); },
    });
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAppUserModelId('com.lesleyjumbo.focus');
  app.on('second-instance', () => { showWidget(); openStudio(); });
  app.on('window-all-closed', () => { /* keep running in the tray */ });
  app.on('before-quit', () => { quitting = true; try { if (S) saveNow(); } catch (_) { /* ignore */ } });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.whenReady().then(ready);
}
