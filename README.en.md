# Antigravity Thinking Translator

**English** · [简体中文](README.md)

In Google Antigravity 2.x, reasoning models emit their internal `Thinking` stream in English for optimal coding and logic performance. **Antigravity Thinking Translator** keeps the model's native English reasoning completely untouched—never injecting prompt rules that alter reasoning quality—while automatically translating thinking blocks on the client side into your chosen target language.

## Features

- **Zero impact on reasoning quality**: Prompts, rules, and backend calls are untouched. Models continue thinking in English while translations stream asynchronously paragraph by paragraph on the client.
- **Paragraph-level interleaved streaming & background pre-translation**:
  - Inserts translated paragraphs directly beneath each corresponding original paragraph (while preserving code blocks untouched).
  - Translates completed paragraphs immediately during live thinking and pre-translates collapsed/tool-grouped thinking blocks in the background so expanding them is instant.
  - Pooled persistent `agy` workers (up to 4 concurrent workers) translate paragraphs in parallel with jitter-free `requestAnimationFrame` token fade-in rendering.
- **Cascading model + thinking-level selector**: First choose the model family (e.g., `Gemini 4 Hydrogen`, `Gemini 3.8 Flash`, `Claude Sonnet 5.5`), then choose the effort level dynamically filtered for that model (defaults to `Gemini 4 Hydrogen` + `Medium`).
- **Two display modes**:
  - **Bilingual (`显示原文和译文`)**: Shows each translated paragraph inline below its English source paragraph.
  - **Translation Only (`只显示译文`)**: Swaps each English paragraph out cleanly once its translation begins streaming, with per-block buttons to toggle back to bilingual view, re-translate, or copy.
- **Configurable target language & canonical LRU cache**: Supports preset & custom target languages, and indexes cache entries with formatting-agnostic canonical keys so background pre-translations match DOM blocks seamlessly.
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
