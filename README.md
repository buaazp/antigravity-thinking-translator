# Antigravity 思考过程自动翻译器 (Antigravity Thinking Translator)

[English](README.en.md) · **简体中文**

在 Google Antigravity 2.x 桌面客户端中，模型（如 Gemini 系列）为了保持最佳代码与逻辑推理能力，默认在内部 `Thinking` 通道以英文思考。本插件在不修改系统提示词、**完全不影响模型原生英文推理能力**的前提下，在客户端侧自动将模型思考过程实时翻译为中文或任意目标语言，并支持在**「只显示译文」**与**「显示原文和译文」**之间随时切换。

---

## ✨ 核心特性

- **零干预推理链**：不注入任何改变思考语言的规则或 Prompt，模型继续用英文进行高质量推理；译文在客户端按段落异步流式翻译与渲染。
- **标题 & 步骤名最高优先级（Priority 0）即时翻译**：
  - 优先于思考正文先行翻译 `Thinking`、`Thought for Xs`、`Worked for ...`、`Explored ...` 等分组标题及 `Ran ...`、`... finished`、`Edited ...` 等步骤标题（支持双语并列与纯译文模式），一眼即可决定是否需要展开查看完整推理；
  - 常见状态与单文件标题走 **0ms / 0-Token 本地模板极速翻译**，自由英文标题自动合并为单轮流式批量翻译（`translateBatch`）。
- **低 Token 消耗 & 高性能并发引擎（v0.3.0 优化）**：
  - **独立轻量翻译智能体隔离**：后台 Worker 在临时目录启动专用无工具自定义 Agent（`--agent tt-translator`：`tools: []`、`mcpServers: []`、`skills: []`、`plugins: []`、`commandExecutionPolicy: off`），配合会话级 `--settings`（关闭历史写入与通知），不加载主工作区 MCP/Skills/Hooks，更不污染当前对话会话上下文；
  - **多条目流式合批与精简续轮**：相近标题/段落自动合并为最多 12 条的流式批次（`translateBatch`）在单次对话轮次内增量吐字，常驻 Worker 续轮采用精简提示词（单 Worker 最高复用 24 轮 / 28,000 字符），并发默认收紧为 2 路以大幅降低连接与输入 Token 开销；
  - **按需展开省流模式**：新增「**预译未展开的折叠思考**」开关（**默认关闭**），未展开的历史折叠思考/工具组不再在后台空耗 Token，点击展开或徽章后立即并发翻译，已译内容支持 **2,000 条**格式无关规范键本地 LRU 缓存秒开。
- **逐段就地流式互译**：
  - 每一段英文思考下方紧接其对应的译文块（代码块保持原样不打散），实时流式思考时每完成一段即自动翻译，配合 `requestAnimationFrame` 平滑渐显动效，彻底告别页面抖动。
- **二级联动模型选择（复用 Antigravity 内置模型）**：
  - 通过官方 `agy` CLI 无头流式引擎调用当前已登录模型，无需额外外部 API Key；
  - 设置面板拆分为「**模型**」+「**思考等级**」二级联动下拉列表（默认 **`Gemini 4 Hydrogen`** + **`Medium (中)`**），思考等级候选项随所选模型动态切换。
- **双显示模式、多语言与莫兰迪配色主题（v0.4.0 新增）**：
  - **显示原文和译文**（默认）：在每一段原文与标题旁嵌合对应译文；
  - **只显示译文**：译文首字流式抵达后隐藏对应英文原文（代码块与交互文件芯片原样保留），右上角支持单条「显示原文 / 只看译文」「重译」「复制」；
  - **可配置莫兰迪色系主题**：所有插件相关的标题、译文卡片、流式光标与状态徽章均可随配置切换，默认**青瓷绿（Celadon Green）**，内置**青瓷绿 / 豆沙绿 / 雾霾蓝 / 烟灰粉 / 香芋紫 / 暖灰咖** 6 套标准莫兰迪预设（自动适配浅色与深色模式）；
  - 内置简体中文、繁體中文、日本語、한국어、Español、Français、Deutsch、Русский、Português，并支持任意自定义语言。
- **关闭即原版零侵入 & 悬停停顿局部手动翻译（v0.4.0+）**：
  - 关闭设置面板第一项「**自动翻译思考过程**」后，对话流保持**与原版无插件完全一致**：标题旁不显示译文、右侧不展示翻译状态标签、已展开思考区也不注入译文容器；
  - 将鼠标移动至任意思考块或步骤分组标题（`Thinking`、`Thought for Xs`、`Worked for ...`、`Explored ...` 等）区域并停留约 0.4 秒后，标题右侧会浮现一个 **`翻译`** 按钮，点击即可按需手动翻译**该区域内的标题与全部思考详情**（其他未点击区域仍保持原版）；
  - **可见区域优先 & 从后往前调度（v0.4.1）**：展开包含大量段落或步骤的区域进行翻译时，优先翻译当前滚动视口内可见条目，再由后向前补齐其余段落（默认定位到底部时即刻先译出当前画面内容，滚动时自动动态提权新进入视口的段落）。
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

1. **自动翻译思考过程**：总开关，可随时暂停/恢复；开启后优先实时翻译各折叠标题与步骤名，并对当前已展开的思考按段落流式翻译；**关闭后页面恢复原版无插件显示**，仅当鼠标悬停在某个思考/分组标题上停留片刻时，标题右侧才会浮现 **`翻译`** 按钮用于触发该区域的手动翻译。
2. **预译未展开的折叠思考**：可选按需省流开关（默认关闭）；关闭时未展开的历史/折叠思考不耗费额外 Token，需要阅读时展开或点击徽章即可即时翻译。
3. **目标语言**：选择预设语言或选择「自定义语言...」后输入任意语言。
4. **显示方式**：切换「显示原文和译文」或「只显示译文」，同时作用于思考正文与标题。
5. **主题配色（莫兰迪色系）**：选择插件界面与译文高亮色系（默认 **`青瓷绿`**，可选 `青瓷绿` / `豆沙绿` / `雾霾蓝` / `烟灰粉` / `香芋紫` / `暖灰咖`）。
6. **翻译模型 & 思考等级**：先在左栏选择模型（如 `Gemini 4 Hydrogen`、`Claude Sonnet 5.5` 等），再在右栏选择对应的思考等级（默认 `Gemini 4 Hydrogen` + `Medium (中)`），可点击「↻ 刷新」同步最新 `agy models` 列表。
7. **交互操作**：
   - 每个已激活思考块右上角带有 **`译`** / **`译中 1/3`** / **`已译`** 状态徽章，折叠状态下点击可直接展开并并发翻译全部段落；
   - 展开状态下右上角提供 **`显示原文 / 只看译文`**、**`重译`** 与 **`复制`** 快捷按钮。

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
