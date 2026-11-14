# Antigravity Thinking Translator

**English** · [简体中文](README.md)

In Google Antigravity 2.x, reasoning models emit their internal `Thinking` stream in English for optimal coding and logic performance. **Antigravity Thinking Translator** keeps the model's native English reasoning completely untouched—never injecting prompt rules that alter reasoning quality—while automatically translating thinking blocks on the client side into your chosen target language.

## Features

- **Zero impact on reasoning quality**: Prompts, rules, and backend calls are untouched. Translation runs asynchronously on the client after/as thinking text appears.
- **Reuses built-in Antigravity models**: Invokes your authenticated `agy` CLI (`stream-json` persistent worker with one-shot JSON fallback), defaulting to **`Gemini 4 Hydrogen (Medium)`** (`gemini-4-hydrogen-medium`), and lets you switch to any model from `agy models`.
- **Two display modes**:
  - **Bilingual (`显示原文和译文`)**: Keeps the original English thinking visible and appends a formatted translation card beneath it.
  - **Translation Only (`只显示译文`)**: Hides the original English block via React-safe CSS once translation is available, with per-block toggle buttons to peek at the original text anytime.
- **Configurable target language**: Built-in presets (Simplified Chinese, Traditional Chinese, Japanese, Korean, Spanish, French, German, Russian, Portuguese) plus free-form custom language input.
- **Persistent LRU cache & live streaming preview**: Caches up to 500 translations locally and streams partial output live for long thinking traces.
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
