# MEMORY.md — FishbigAgent 长期记忆

> 策划过的精炼记忆。定期从日志中整理更新。

## 用户

- 于艺，跨境电商创业者
- 使用飞书沟通
- GitHub: GloriaFish27

## 架构知识

- Cloud Code API 需要 User-Agent: `antigravity/VERSION darwin/arm64`
- companionProject 通过 loadCodeAssist 获取
- 独立 OAuth 登录: `npm run login` → `data/auth.json`
- OpenClaw 官方仓库: `openclaw/openclaw`

## Web Search 最佳实践（2026-02-23 实测更新）

### 🏆 可用方案（按推荐度排序）

| 方案 | 用途 | 调用方式 | 状态 |
|------|------|---------|------|
| **ddgs** | 搜索互联网 | `python3 ddgs.text()` | ✅ 免费 |
| **r.jina.ai** | 读网页内容 | `curl r.jina.ai/URL` | ✅ 免费 |
| **gh search** | 搜GitHub | `gh search repos` | ✅ 免费 |
| **Tavily** | 搜索(高质量) | API调用 | ⏳ 待申请key |

### 标准搜索流程
1. `ddgs` 搜索 → 获取 URL 列表
2. `r.jina.ai` 读取 → 获取页面内容
3. 综合多来源 → 输出报告

### 已验证不可用的方案
- `s.jina.ai` — 已需付费
- LangSearch — 需要 API key
- DuckDuckGo Instant API — 只返回即时答案
- SearXNG 公共实例 — JSON 接口被限制

### 注意事项
- ddgs 在 Python 3.9 有 SSL 问题，中文搜索偶尔报错
- 英文搜索比中文稳定
- r.jina.ai 有速率限制，别短时间大量请求

## 小红书爬虫知识

- **MediaCrawler** (NanmiCoder) — 多平台重量级，7个平台
- **xhs** (ReaJason) — 轻量SDK，pip install 即用
- 两者都用签名注入破解反爬，都不可商用

## 教训

- 没有工具就别假装能执行 — 诚实报告限制
- 工具调用要直接，不要反复试错
- 工具超时就用 shell + curl，不要死等
- 工具要实测，不要假设能用
- 文件 > 大脑 — 写下来才算记住
