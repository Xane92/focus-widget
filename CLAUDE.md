# Focus: notes for Claude Code

Always-on-top task widget for Windows and Mac. Electron, plain HTML/CSS/JS, no framework.

## Layout
- `main.js`: windows, tray, hotkeys, storage (JSON in userData), crash recovery, edge tuck, CSV export, auto-update.
- `preload.js`: the only bridge between pages and the main process. Add a method here for any new IPC.
- `src/shared/core.js`: pure task/timer reducer, shared by main and both pages. All state changes go through `apply()`.
- `src/widget/`: the on-screen widget (full card, mini, edge tab).
- `src/studio/`: the Studio window (tasks, appearance, logs, settings).
- Download page: lives in the portfolio repo (Xane92/portfolio, folder `focus/`), served at https://lesleyjohnjumbo.com/focus

## Rules
- No `-webkit-app-region: drag` anywhere in the widget. Windows swallows clicks inside drag regions; the app moves the window itself (`move:start/move/end` IPC).
- Everything in the widget scales with container query units; check the smallest sizes after layout changes.
- No em dashes in UI copy.

## Check before shipping
```bash
npm test
FOCUS_SELFTEST=1 FOCUS_USER_DATA=/tmp/focus-test xvfb-run -a npx electron . --no-sandbox   # Linux only
```

## Ship an update
```bash
npm run release
```
That bumps the patch version, commits and pushes. A push that changes the version in package.json is what triggers a release. GitHub Actions builds the Windows and Mac installers and publishes a Release. Installed copies download it on their own and offer "Restart to update" in the tray and Studio.
