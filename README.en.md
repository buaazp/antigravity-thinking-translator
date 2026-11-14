# Antigravity Thinking Translator

**English** · [简体中文](README.md)

In Google Antigravity 2.x, reasoning models emit their internal `Thinking` stream in English for optimal coding and logic performance. **Antigravity Thinking Translator** keeps the model's native English reasoning completely untouched—never injecting prompt rules that alter reasoning quality—while automatically translating thinking blocks on the client side into your chosen target language.

## Features

- **Zero impact on reasoning quality**: Prompts, rules, and backend calls are untouched. Models continue thinking in English while translations stream asynchronously paragraph by paragraph on the client.
- **Priority-0 thinking header & step title translation**:
  - Translates collapsible group headers (`Thinking`, `Thought for Xs`, `Worked for ...`, `Explored ...`) and step titles (`Ran ...`, `... finished`, `Edited ...`, etc.) **first** ahead of body paragraphs, so you can decide at a glance whether a step needs expanding.
  - Standard status headers and single-file actions use **0ms / 0-token local boilerplate translation**, while free-form English titles are coalesced into streaming batches (`translateBatch`).
- **Low-token & high-performance worker engine (v0.3.0)**:
  - **Isolated tool-free translator agent**: Spawns workers in temporary isolated directories with a dedicated custom agent (`--agent tt-translator` with `tools: []`, `mcpServers: []`, `skills: []`, `plugins: []`, `commandExecutionPolicy: off`) plus session-only `--settings` (`historySize: 0`, `notifications: false`, `showTips: false`, `showFeedbackSurvey: false`, `disableSlashCommands: true`), avoiding workspace MCP servers, skills loading, or session context bloat.
  - **Streaming batching & compact warm turns**: Coalesces up to 12 items into a single streaming `translateBatch` turn, uses compact continuation prompts across up to 24 turns (28,000 chars) per warm worker, caps default concurrency at `2` workers, and stores up to `2,000` formatting-agnostic canonical LRU cache entries.
  - **On-demand collapsed block saving**: `pretranslateCollapsed` (**`预译未展开的折叠思考`**) defaults to `false` so unread collapsed blocks do not consume tokens in the background unless explicitly enabled or opened.
- **Paragraph-level interleaved streaming**: Inserts translated paragraphs directly beneath each corresponding original paragraph (while preserving code blocks untouched) with jitter-free `requestAnimationFrame` token fade-in rendering.
- **Cascading model + thinking-level selector**: First choose the model family (e.g., `Gemini 4 Hydrogen`, `Gemini 3.8 Flash`, `Claude Sonnet 5.5`), then choose the effort level dynamically filtered for that model (defaults to `Gemini 4 Hydrogen` + `Medium`).
- **Zero-footprint disabled mode & hover-dwell regional manual translate (v0.4.0)**:
  - Turning off the primary **`自动翻译思考过程`** toggle restores the chat UI to **100% vanilla Antigravity**: no translated titles, no right-side translation status pills, and no translation boxes injected into expanded thinking details.
  - Hovering and dwelling (`~0.4s`) over any collapsible thinking/group header (`Thinking`, `Thought for Xs`, `Worked for ...`, `Explored ...`) reveals a subtle floating **`翻译`** button on the right; clicking it manually translates **both the titles and thinking details inside that region** while leaving all other regions untouched.
  - **Viewport-first & back-to-front ordering (v0.4.1)**: When translating multi-step or multi-paragraph blocks (which open scrolled to the bottom), currently visible items in the viewport are translated first, followed by remaining items in reverse order (and scrolling up dynamically promotes newly visible queued items).
- **Customizable Morandi color themes (v0.4.0+)**:
  - Replaces fixed accents with configurable Morandi palettes (Light & Dark tuned) across titles, translation blocks, streaming carets, badges, and settings controls — defaulting to **Celadon Green (`青瓷绿`)** alongside **Sage Green (`豆沙绿`)**, **Foggy Blue (`雾霾蓝`)**, **Dusty Rose (`烟灰粉`)**, **Dusty Mauve (`香芋紫`)**, and **Warm Taupe (`暖灰咖`)**.
- **Two display modes & multi-language support**:
  - **Bilingual (`显示原文和译文`)**: Shows each translated paragraph and title inline alongside its English source.
  - **Translation Only (`只显示译文`)**: Swaps each English paragraph (and non-interactive title) out cleanly once its translation begins streaming, with per-block buttons to toggle back to bilingual view, re-translate, or copy.
  - Supports preset & custom target languages.
- **Coexists with `antigravity-context-viewer`**: Uses isolated `tt-*` files and paired injection markers so both plugins can be installed, updated, and restored independently.

## Quick Start

```bash
# 1. Check environment (Node.js, Antigravity app.asar, agy CLI, CDP port)
node cli.js check

# 2. Build renderer (if needed), patch app.asar, and hot-inject into running window
node cli.js install

# 3. Verify disk patch and live window status
node cli.js status
```

Other commands:

- `node cli.js live`: Hot-inject via CDP without modifying `app.asar`.
- `node cli.js restore`: Surgically remove Thinking Translator from `app.asar` while preserving other plugins.
- `npm test`: Build `tt-renderer.js` and run the full test suite.
