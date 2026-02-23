# Web Search Skill (v3 — Tavily 已集成)

## 首选：Tavily API ⭐⭐⭐⭐⭐
**状态：** ✅ 已配置，key 在 `config/tavily.json`

```bash
# 基本搜索
curl -s -X POST 'https://api.tavily.com/search' \
  -H 'Content-Type: application/json' \
  -d '{"api_key": "'$(python3 -c "import json;print(json.load(open('config/tavily.json'))['api_key'])")', "query": "搜索关键词", "max_results": 5}'

# 高级搜索（带AI摘要）
curl -s -X POST 'https://api.tavily.com/search' \
  -H 'Content-Type: application/json' \
  -d '{"api_key": "KEY", "query": "关键词", "max_results": 5, "search_depth": "advanced", "include_answer": true}'
```

**注意：** 每月 1000 credits，简单搜索用 ddgs 省额度。

## 备选：DuckDuckGo (`ddgs`) ⭐⭐⭐⭐
**状态：** ✅ 免费可用，无需 API key

```bash
python3 -c "
from ddgs import DDGS
with DDGS() as d:
    for r in d.text('query', max_results=5):
        print(r['title'])
        print(r['href'])
        print('---')
"
```

## 读取网页：Jina r.jina.ai ⭐⭐⭐⭐⭐
**状态：** ✅ 免费可用

```bash
curl -s 'https://r.jina.ai/https://目标URL'
```

## 标准搜索流程

1. **Tavily** 搜索 → 高质量结果（复杂研究用）
2. **ddgs** 搜索 → 免费备选（简单查询用）
3. **r.jina.ai** 读取 → 深度阅读页面
4. 综合多来源 → 输出报告

## 搜索策略
- 简单查询 → ddgs（省 Tavily credits）
- 重要研究 → Tavily（质量更高）
- 深度阅读 → r.jina.ai
- GitHub 专题 → `gh search repos`
