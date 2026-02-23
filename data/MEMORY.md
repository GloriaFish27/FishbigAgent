# MEMORY.md — FishbigAgent 长期记忆

> 策划过的精炼记忆。定期从日志中整理更新。

## 用户

- 于艺，跨境电商创业者
- 使用飞书沟通
- GitHub: GloriaFish27

## 核心战略 (2026-02-23 更新)

- **聚焦定位**: LinkedIn 数据采集 + 浏览器自动化服务
- **差异化**: 不是框架，是交钥匙服务（3小时交付）
- **赛道验证**: browser-use 42,000⭐ 证明方向正确
- **变现路径**: Reddit 回帖展示专业度 → DM 咨询 → 报价 $50-100

## 渠道状态

| 渠道 | 状态 | 下一步 |
|------|------|--------|
| Moltbook | ✅ 已注册+认领+验证 | 发干货帖（LinkedIn反爬实战）|
| Reddit | ✅ 3条回帖草稿已备好 | 等用户发帖 |
| X.com | ✅ 浏览器可登录 | 互动+搜索商机 |
| 支付宝 | ✅ 收款方式 | — |

## 架构知识

- Cloud Code API 需要 User-Agent: `antigravity/VERSION darwin/arm64`
- companionProject 通过 loadCodeAssist 获取
- 独立 OAuth 登录: `npm run login` → `data/auth.json`
- OpenClaw 官方仓库: `openclaw/openclaw`

## Web Search 最佳实践

| 方案 | 用途 | 状态 |
|------|------|------|
| **Tavily** | 高质量搜索 | ✅ 已配置 |
| **ddgs** | 免费搜索 | ✅ 免费 |
| **r.jina.ai** | 读网页 | ✅ 免费 |
| **gh search** | GitHub | ✅ 免费 |

## Moltbook API

- 正确 key: `moltbook_sk_jiIhp64VnDBqHMIhupe742PIgv_WPltu`
- Header: `X-API-Key` 或 `Authorization: Bearer`
- 发帖字段: `title`/`content`/`submolt_name`（不是 body/community）
- 发帖后需要验证（数学题）: POST `/api/v1/verify`
- 容易 429 限流，间隔至少 2 分钟

## X.com

- @FishbigAgent 浏览器已可登录
- 已发3条推文（Moltbook认领 + Day1介绍 + 销售自动化干货）
- 发推三步法: compose/post → div[role=textbox] → button[data-testid=tweetButton]
- 搜索用直接 URL: `x.com/search?q=...&f=top`
- 不要点 UI 元素，直接 URL 导航更可靠

## 竞品/学习

- **browser-use** (42,000⭐) — AI 浏览器框架，我们的定位是服务不是框架
- **Shruti @heyshrutimishra** — OpenClaw 深度研究者
- **Aakash 指南**: https://www.news.aakashg.com/p/openclaw-guide
- **awesome-openclaw-usecases**: 1200⭐，社区精选案例集

## 教训

- 没有工具就别假装能执行 — 诚实报告限制
- 工具调用要直接，不要反复试错
- 工具要实测不要假设
- 文件 > 大脑 — 写下来才算记住
- 验证码能识别，不要一开始就说做不到
- 遇到密码输入立刻喊人，这是合理边界
- 成功 Agent 极度聚焦一个垂直场景
- 先给免费价值，建立信任再接单
