# Changelog

所有对 FishbigAgent 的设计变更和修改记录。

---

## [2026-02-23] v0.3.0 — P1 Vision + P2 Feishu Rich Text + P3 Smart DOM

### 👁️ P1: Vision Pipeline
- `ChatMessage.images` — 多模态消息，支持 base64 图片传给 LLM
- `AntigravityAPI._call` — 构建 `inline_data` parts 调用 Vision API
- `BrowserTool._screenshot` — 截图返回 base64，自动传给 LLM "看"
- ACT 循环收集工具图片，附加到反馈消息

### 💬 P2: 飞书富文本
- **Markdown 卡片** — 检测含 Markdown 的回复自动用 `interactive` 卡片发送
- **图片收发** — `sendImage()` 上传 + 发送，`_downloadImage()` 接收下载
- **文件收发** — `sendFile()` 上传 + 发送（pdf/doc/xls/ppt/mp4 等）
- **富文本接收** — `_handle()` 支持 text/image/post/file 消息类型

### 🧠 P3: Smart DOM
- **analyze** — 结构化 DOM 快照，每个交互元素编号（`#1 [button] "登录"`）
- **elementId** — 用编号操作元素：`{"action":"click","elementId":"3"}`
- **自然语言** — 用描述操作：`{"action":"click","target":"登录按钮"}`
- **模糊匹配** — 按 text/ariaLabel/placeholder/name/关键词打分

### 🥷 P4: Stealth
- **反自动化检测** — `navigator.webdriver=false`, 伪造 plugins/languages/chrome.runtime/WebGL
- **随机指纹** — 5 个 UA 随机选取 + viewport 微调（±20px）
- **人类点击** — 鼠标平滑移动到元素内随机位置 + 微延迟
- **人类打字** — 逐字符输入，50-180ms 随机间隔，10% 概率更长停顿
- **人类滚动** — 分 2-3 步不规则滚动 + 随机偏移
- **Post 解析** — `_parsePostContent()` 提取富文本中的文字和图片

---

## [2026-02-23] v0.2.1 — 持久化消息去重

- **飞书消息去重改为文件持久化** — `seenIds` 从 60 秒内存 Set 改为 24 小时文件 Map（`data/seen-msg-ids.json`），重启/重连后不再重复处理旧消息

---

## [2026-02-23] v0.2.0 — Bug 修复 + PM2 + Git

### 🐛 Bug 修复

- **消息重复发送** — 移除 `feishu.ts` 中的 `history.append`，统一由 `reply-engine.ts` 的 `Conversation` 管理历史
- **Task 模式最终结果重复** — `_process()` 不再为 task intent 调用 `sendFn`（`_taskMode` 自己发送）
- **THINK 阶段输出冗长** — 限制为编号步骤列表，≤300 字，禁止过渡性文字

### ✨ 新功能

- **Browser 真实截图** — `screenshot` action 现在保存 PNG 文件到 `/tmp/`，返回文件路径（支持元素选择器）
- **PM2 进程管理** — `ecosystem.config.cjs` + `npm run pm2:start/stop/logs/restart`，关闭 IDE 不影响 Agent

### 🏗️ 基础设施

- Git 仓库初始化 + 首次提交
- `.gitignore` 完善（排除 runtime data、logs、credentials）
- 本文件 `CHANGELOG.md` 创建

---

## [2026-02-22] v0.1.0 — 初始版本

### 核心架构
- **ReplyEngine** — 意图分类 (Chat/Task) + 6 阶段 Life Cycle (THINK→ACT→REFLECT→EVOLVE)
- **FeishuBridge** — 飞书 WebSocket 消息收发
- **IPC** — 文件 inbox/outbox 进程间通信
- **AntigravityAPI** — Cloud Code Assist API 调用（独立 OAuth）
- **ToolExecutor** — shell, read_file, write_file, web_read, web_search, github, browser
- **BrowserTool** — Playwright 控制 Chromium 浏览器
- **MemoryManager** — P0/P1/P2 三层记忆 + shared-memory
- **SkillLoader** — 动态加载 skills/ 目录
- **Heartbeat** — 30 分钟定时心跳检查
- **Conversation** — 对话上下文管理 + 自动压缩

### 认证
- **GoogleAuth** — 独立 OAuth PKCE 登录，不依赖 IDE
- **login.ts** — CLI 登录脚本 (`npm run login`)

### 配置
- IDENTITY.md, AGENTS.md, USER.md — OpenClaw 风格
- soul.json, constitution.json — 灵魂和宪法
- MEMORY.md — 长期记忆
- HEARTBEAT.md — 心跳检查清单
