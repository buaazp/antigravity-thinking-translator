# Development and Installation Guide (`AGENTS.md`)

## Source Changes

- Edit renderer UI/logic in `src/renderer/` (`styles.css`, `template.html`, `main.js`), then run `npm run build:renderer` to regenerate `tt-renderer.js`.
- Run `npm test` after any source change. Tests run in isolated temporary directories (`AG_TT_STATE_DIR`, `AG_TT_TEST_MODE=1`) and use a mock `agy` executable.
- Runtime uses Node.js built-ins only; no `npm install` is required.

## Installation

Requires Node.js 22.4+ and the `agy` CLI (authenticated once).

```sh
node cli.js check
node cli.js install
node cli.js status
```

Pass `--path "<path-to-app.asar>"` to target a custom Antigravity installation.

- Check both `asarPatched` (disk persistence) and `liveWindow.active` (running window injection) in `node cli.js status`.
- **Never terminate or restart the Antigravity host process from an agent session inside Antigravity.** `node cli.js install` automatically starts `tt-live-host.js` (when IPC bridge is not yet loaded) and hot-injects via `DevToolsActivePort`.
- If writing `app.asar` fails with `EBUSY` or `EPERM`, report the file lock error and ask the user to close Antigravity before retrying.

Other commands:

- `node cli.js live`: CDP hot-injection only without modifying `app.asar`.
- `node cli.js restore`: Surgical uninstall that preserves `antigravity-context-viewer` and other host modifications.

## Coexistence Rules

- Always keep paired `// --- Antigravity Thinking Translator ... Start/End ---` markers intact in `modular-patcher.js`.
- Preserve `'    void win.loadURL(url);'` (exact 4-space indentation, single occurrence) and `'function setupNodeWrapper(env) {'` in `dist/utils.js`.
- Never remove or mutate React DOM nodes inside `button[data-testid="thinking-collapsible-trigger"]` or `[role="group"] > div:first-child`.
