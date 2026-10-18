# Focus

An always-on-top task widget for Windows. Your next task and a bold timer sit on every screen; the Studio app holds the settings and the logs.

## Use it

- **Move:** drag the top bar, the card or the frame. **Resize:** drag the bottom-right corner; everything scales down with it. Make it short and the card fills the window on its own.
- **Focus a task:** click it. **Start / pause:** the play button (or `Ctrl+Alt+P` from any app).
- **Tick it off:** the round checkbox. The timer stops, the finish time is logged, the next task moves up.
- **Subtasks:** the small arrow at the right of a task.
- **Mini mode:** double-click the timer. It keeps your photo and resizes from its own corner. Double-click anywhere on the mini to expand (or untick Mini mode in the tray menu).
- **Tuck it away:** drag the widget or the mini off the left or right edge of the screen and let go. A small tab with an arrow stays on the edge; click it (or press `Ctrl+Alt+Space`) to pull the widget back out.
- **Smallest size:** drag the corner all the way in; the task name drops out and the bar, timer and play button stay.
- **Show / hide:** `Ctrl+Alt+Space`, the tray icon, or right-click the widget.
- **Studio:** the arrow at the top right, the right-click menu, or the tray. **Reset the timer:** right-click the widget or the tray.
- **Play button colours:** Studio > Appearance > Play button. Pick a preset or any colour; the icon switches to dark or light to stay readable.

## Timer rules

- One timer. It follows the task you focus; switching tasks while it runs moves it to the new task.
- Every start, pause, reset and check-off is logged with the real clock time.
- The PC going to sleep or shutting down pauses the timer and notes why.
- If the app is killed or the power dies, the session is closed at the last moment the app was alive (heartbeat every 30s), so you never get phantom hours.

## Data

Everything is in `%APPDATA%\Focus\focus-data.json` (Studio > Settings > Open folder). A backup copy is written on every launch. Reinstalling or updating keeps your data.

## Download

https://xane92.github.io/focus-widget (or straight from the latest release: `Focus-Setup.exe` for Windows, `Focus-mac.dmg` for Mac).

## Ship an update

Make the change, then `npm run release`. GitHub Actions builds both installers and publishes a release; installed copies update themselves.

## Develop

```bash
npm install
npm start            # run the app
npm test             # timer logic tests
npm run dist         # Windows installer into dist/ (run on Windows)
```

End-to-end check (Linux, headless): `FOCUS_SELFTEST=1 FOCUS_USER_DATA=/tmp/focus-test xvfb-run npx electron . --no-sandbox`

## Files

- `main.js`: windows, tray, hotkeys, storage, crash recovery, CSV export
- `preload.js`: the narrow bridge the pages use
- `src/shared/core.js`: task and timer logic (pure, tested)
- `src/widget/`: the on-screen widget
- `src/studio/`: the Studio app
- `src/shared/tokens.css`: colours, radii, fonts
