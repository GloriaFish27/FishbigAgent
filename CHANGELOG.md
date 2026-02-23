# Changelog

所有对 FishbigAgent 的设计变更和修改记录。

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
