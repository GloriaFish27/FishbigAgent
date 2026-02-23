# Web Search Skill (v2 — 实测验证版)

## 可用搜索方案（2026-02-23 实测）

### 1. DuckDuckGo (`ddgs`) ⭐⭐⭐⭐⭐ 主力搜索
**状态：** ✅ 免费可用，无需 API key

```python
from ddgs import DDGS
with DDGS() as d:
    results = list(d.text('搜索关键词', max_results=5))
    for r in results:
        print(r['title'], r['href'])
```

**支持功能：**
- `d.text()` — 网页搜索
- `d.news()` — 新闻搜索
- `d.images()` — 图片搜索

**注意事项：**
- Python 3.9 有 SSL 兼容问题，中文搜索偶尔报错但英文稳定
- 有时需要重试
- Shell 调用方式：
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

### 2. Jina r.jina.ai ⭐⭐⭐⭐⭐ 读网页
**状态：** ✅ 免费可用

```bash
curl -s 'https://r.jina.ai/https://目标URL'
```

返回干净的 Markdown，适合 LLM 处理。

### 3. GitHub CLI ⭐⭐⭐⭐ 搜 GitHub
**状态：** ✅ 免费可用

```bash
gh search repos '关键词' --sort stars -L 10 --json name,url,stargazersCount,description
```

### 4. Tavily ⭐⭐⭐⭐⭐ 最佳付费搜索
**状态：** ⏳ 待申请 API key（1000次/月免费）
**注册：** https://app.tavily.com/sign-in （需要浏览器操作）

## 标准搜索流程

1. **搜索** — `ddgs` 搜索关键词，获取 5 条结果
2. **筛选** — 选出最相关的 2-3 个链接
3. **深读** — `r.jina.ai/URL` 逐个深度阅读
4. **综合** — 多来源交叉验证，输出结构化报告

## 搜索技巧

- 英文关键词结果更稳定
- 加年份过滤旧信息：`best AI tools 2024`
- 多次搜索用不同关键词覆盖更广
- GitHub 搜索用 `gh search repos`

## 失败方案（已测试不可用）

| 方案 | 问题 |
|------|------|
| Jina s.jina.ai | 需要付费 API key |
| LangSearch | 需要 API key |
| DuckDuckGo Instant API | 只返回即时答案 |
| SearXNG 公共实例 | JSON 接口被限制 |
