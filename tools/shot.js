// Renders a page offscreen and saves a PNG. Usage: electron tools/shot.js <url> <out.png> <width> <height> [scale]
const { app, BrowserWindow } = require('electron');
const fs = require('fs');

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const [url, out, w = '1400', h = '900', scale = '2'] = args;

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const z = Number(scale);
  const win = new BrowserWindow({
    width: Number(w) * z, height: Number(h) * z, show: false, useContentSize: true, transparent: !!process.env.SHOT_TRANSPARENT, backgroundColor: process.env.SHOT_TRANSPARENT ? '#00000000' : '#FFFFFF', frame: !process.env.SHOT_TRANSPARENT,
    webPreferences: { offscreen: true, zoomFactor: z },
  });
  const errors = [];
  win.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) errors.push(msg); });
  await win.loadURL(url);
  await win.webContents.executeJavaScript('document.fonts.ready.then(() => new Promise(r => setTimeout(r, 1500)))');
  if (process.env.SHOT_JS) { await win.webContents.executeJavaScript(process.env.SHOT_JS); await new Promise((r) => setTimeout(r, 400)); }
  const img = await win.webContents.capturePage();
  fs.writeFileSync(out, img.toPNG());
  if (errors.length) console.log('CONSOLE ERRORS:\n' + errors.join('\n'));
  console.log('saved', out, img.getSize());
  app.quit();
});
