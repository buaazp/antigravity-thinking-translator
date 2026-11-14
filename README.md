# Antigravity 思考过程自动翻译器 (Antigravity Thinking Translator)

[English](README.en.md) · **简体中文**

在 Google Antigravity 2.x 桌面客户端中，模型（如 Gemini 系列）为了保持最佳代码与逻辑推理能力，默认在内部 `Thinking` 通道以英文思考。本插件在不修改系统提示词、**完全不影响模型原生英文推理能力**的前提下，在客户端侧自动将模型思考过程实时翻译为中文或任意目标语言，并支持在**「只显示译文」**与**「显示原文和译文」**之间随时切换。

---

## ✨ 核心特性

- **零干预推理链**：不注入任何改变思考语言的规则或 Prompt，模型继续用英文进行高质量推理；译文在思考片段生成或展开时于客户端异步渲染。
- **直接复用 Antigravity 内置模型**：通过官方 `agy` CLI 无头流式引擎调用你当前已登录的 Antigravity 内置模型进行翻译，无需额外配置外部 API Key。
  - 默认翻译模型：**`Gemini 4 Hydrogen (Medium)`** (`gemini-4-hydrogen-medium`)
  - 可在顶栏设置面板随时切换 `agy models` 中的任意可用模型（如 Gemini 4 Carbon / Argon / Hydrogen、Gemini 3.8 Flash、Claude 等）。
- **双显示模式自由切换**：
  - **显示原文和译文**（默认）：在思考折叠块内部原文下方紧接展示排版后的译文卡片。
  - **只显示译文**：隐藏原始英文内容，仅展示译文卡片（每个思考块角落仍保留「显示原文 / 只看译文」单条快捷切换按钮）。
- **自定义目标语言**：内置简体中文、繁體中文、日本語、한국어、Español、Français、Deutsch、Русский、Português，并支持任意自定义目标语言名称。
- **流式增量翻译 + 本地持久化缓存**：
  - 支持长思考分块流式输出译文预览；
  - 相同内容、语言与模型自动命中本地缓存（LRU 500 条），重开对话或历史思考秒开；
  - 支持一键重新翻译或清空缓存。
- **安全兼容 `antigravity-context-viewer`**：使用独立的 `tt-*` 注入文件与成对注释标记，不触碰宿主核心结构，支持与上下文查看器同时安装、独立更新及无损外科卸载。

---

## 🤖 给 AI 智能体的一键安装指令

你可以直接把本仓库交给 Antigravity 内的 AI 助手，对它说：**“读取 `AGENTS.md` 或 `README.md`，帮我安装这个思考过程自动翻译插件”**。

```bash
# 1. 环境预检（检查 Node.js、Antigravity app.asar、agy CLI 与 CDP 状态）
node cli.js check

# 2. 持久化注入 ASAR + 自动热注入当前运行中的 Antigravity 窗口（无需强杀进程）
node cli.js install

# 3. 验证安装与运行窗口状态
node cli.js status
```

---

## 🚀 快速开始

### 要求

- Node.js `>= 22.4`（`package.json` 声明 `>= 22.4`）
- 已安装 Google Antigravity 2.x 桌面客户端与 `agy` CLI（并已在交互式会话中登录一次）

### 一键脚本

- **macOS / Linux**：
  - 安装 / 更新：`./install.sh`
  - 卸载 / 还原：`./uninstall.sh`
- **Windows**：
  - 安装 / 更新：双击 [`install.bat`](install.bat)
  - 卸载 / 还原：双击 [`uninstall.bat`](uninstall.bat)

### CLI 命令一览

```bash
node cli.js check     # 检查 Node.js、app.asar、agy CLI 与 CDP 端口
node cli.js install   # 构建检查 + ASAR 持久化注入 + 运行窗口 CDP 热挂载
node cli.js live      # 仅通过 CDP 热挂载当前运行窗口（不修改 app.asar）
node cli.js status    # 输出 JSON 格式的磁盘注入与实时窗口状态
node cli.js restore   # 原位无损卸载 Thinking Translator（保留其他已安装插件）
```

> 所有命令均支持 `--path "<path-to-app.asar>"` 指定自定义安装路径。

---

## ⚙️ 使用方式

安装或热挂载后，Antigravity 顶栏右上角会出现 **`译 · 简体中文`** 胶囊按钮，点击即可打开设置面板：

1. **自动翻译思考过程**：总开关，可随时暂停/恢复。
2. **目标语言**：选择预设语言或选择「自定义语言...」后输入任意语言。
3. **显示方式**：切换「显示原文和译文」或「只显示译文」，即时生效。
4. **翻译模型**：默认 `Gemini 4 Hydrogen (Medium)`，可从下拉列表切换并点击「刷新」同步最新模型列表。
5. **交互操作**：
   - 每个思考块右侧带有 **`译`** / **`译中...`** / **`已译`** 状态徽章，折叠状态下点击也可直接展开并翻译。
   - 译文卡片右上角支持单条切换 **`显示原文 / 只看译文`**、**`重译`** 与 **`复制`**。

---

## 🧪 测试与开发

```bash
npm run build:renderer   # 将 src/renderer/ 构建为 tt-renderer.js
npm test                 # 运行完整单元测试与双插件共存测试
```

---

## 📁 目录结构

```text
antigravity-thinking-translator/
├── cli.js                  # 统一命令行入口 (check / install / live / status / restore)
├── install.js              # ASAR 安全注入器（校验所有未修改原文件 SHA-256）
├── restore.js              # 原位无损卸载器（支持保留 antigravity-context-viewer）
├── modular-patcher.js      # 成对标记代码注入与语法/结构自检器
├── tt-asar.js              # 零依赖原生 Node.js ASAR 打包/解包引擎与跨平台路径探测
├── tt-core.js              # UMD 核心模块（设置、缓存键、语言过滤、Prompt 构造、安全 Markdown 渲染）
├── tt-backend.js           # agy 常驻 stream-json 翻译 Worker、模型发现与持久化缓存
├── tt-main.js              # Electron 主进程 IPC 桥与窗口自动注入钩子
├── tt-live-host.js         # 免重启 CDP 模式本地 HTTP NDJSON 流式桥接服务
├── tt-live-client.js       # CDP 查询、热注入与桥接进程管理
├── tt-renderer.js          # 渲染层构建产物
├── src/renderer/           # 渲染层源码 (styles.css / template.html / main.js)
├── scripts/                # 渲染层构建脚本
├── test/                   # 自动化测试套件
├── AGENTS.md               # AI 智能体开发与安装规范
└── README.md / README.en.md
```
