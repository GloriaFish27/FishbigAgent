# 共享记忆 — 通用教训

## 技术教训

- Cloud Code API 需要 `User-Agent: antigravity/VERSION darwin/arm64`
- `gh` CLI 的 search 命令用 `-L` 而非 `--limit`
- Feishu 消息有长度限制，长结果需要截断
- THINK 阶段不能执行工具，只做规划

## Web Search 教训（2026-02-23 实测更新）

### ✅ 可用方案
- **DuckDuckGo `ddgs` 包** — 免费、无需API key、支持text/news/images搜索
- **Jina `r.jina.ai`** — 读取网页为Markdown，免费可用
- **GitHub CLI `gh search`** — 搜索GitHub仓库/代码，免费

### ❌ 不可用方案
- `s.jina.ai` 搜索已需要付费 API key
- LangSearch API 需要 API key
- DuckDuckGo Instant Answer API 不返回搜索结果列表
- SearXNG 公共实例的 JSON 接口经常被限制

### ⏳ 待配置
- **Tavily** — 1000次/月免费，需要浏览器注册获取API key
- **Serper.dev** — 2500次一次性免费额度

### 技术细节
- ddgs 在 Python 3.9 有 SSL 兼容问题（TLSv1.3），中文搜索偶尔报错但英文稳定
- 用 `shell` + `curl` 调 Jina 比 `web_read` 工具更可靠
- ddgs 调用方式：`python3 -c "from ddgs import DDGS; ..."`

## 行为教训

- 诚实 > 一切 — 不夸大、不编造
- 工具调用要直接 — 一开始就用正确的工具，不反复试错
- 工具要实测不要假设 — 测一下就知道能不能用
- 工具超时换方式 — shell + curl 比内置工具更可靠
- 监控 ≠ 行动 — 发现任务要立即执行
- 主动沟通 > 被动提及 — 需要澄清就直接问
- 文件 > 大脑 — 写下来才算记住
