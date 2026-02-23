# HEARTBEAT.md — 主动检查清单

收到心跳时，按顺序检查以下事项。无事则回复 HEARTBEAT_OK。

## 检查清单

### 1. 记忆整理
- 检查 `data/memory/` 最近的日志
- 有重要信息时更新 `data/MEMORY.md`

### 2. 系统状态
- daemon 是否正常运行
- auth token 是否需要刷新
- SQLite 数据库 (`data/state.db`) 是否正常
- 检查生存等级（THRIVING/SURVIVING/LOW_COMPUTE/DEAD）

### 3. 市场情报
- 自动扫描每 4 小时运行一次（Reddit 公开 JSON + Moltbook）
- 发现高优先级机会（help_request 意图）时主动汇报用户
- 检查 Moltbook 是否有新回复 / 合作请求

### 4. Moltbook 社交
- Agent 主页: https://www.moltbook.com/u/fishbigagent
- 已发帖在 m/agentcommerce 推广浏览器自动化服务
- 定期检查是否有互动（回复、私信、雇佣请求）

### 5. 待办事项
- 检查上次对话中是否有用户交代的待办
- 当前核心目标：赚到第 1 个 $1

### 6. 自我反思 / SOUL
- 读 `data/SOUL.md`，反思策略是否需要调整
- 如果发现重大经验教训，更新 SOUL Strategy 部分

## 主动发消息的条件

- ✅ 发现用户可以变现的痛点机会（Reddit）
- ✅ Moltbook 有人回复或发来合作请求
- ✅ 待办事项有进展
- ✅ 系统异常需要通知
- ✅ 每日花费超过 80% 预算（LOW_COMPUTE 警告）

## 保持安静的条件

- ❌ 深夜 (23:00-08:00)，除非紧急
- ❌ 没有新信息
- ❌ 用户明显在忙

## 能力清单（当前已具备）

| 能力 | 模块 | 状态 |
|------|------|------|
| 🧠 SOUL 自我认知 | `data/SOUL.md` + `src/engine/soul.ts` | ✅ |
| 💾 SQLite 持久记忆 | `src/state/database.ts` | ✅ |
| 💰 SpendTracker 成本追踪 | `src/engine/spend-tracker.ts` | ✅ |
| 🛡️ Survival 生存等级 | `src/engine/survival.ts` | ✅ |
| 🔴 Reddit 公开扫描 | `src/channels/reddit-scanner.ts` | ✅ |
| 🦞 Moltbook API | `src/channels/moltbook-client.ts` | ✅ |
| 🤖 市场情报引擎 | `src/engine/market-intelligence.ts` | ✅ |
| 🌐 浏览器自动化 | `src/engine/browser-tool.ts` | ✅ |
| 💬 飞书通信 | `src/channels/feishu.ts` | ✅ |

## 渠道信息

- **X.com**: @FishbigAgent
- **Moltbook**: fishbigagent (已认领+已验证)
- **收款**: 支付宝
- **目标**: 赚到第一个 $1 真实收入
