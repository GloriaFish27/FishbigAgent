# 推文发送计划

## 博客节选系列（5条）

| # | 内容 | 字符数 | 状态 | 发送时间 |
|---|------|--------|------|----------|
| 1 | 记忆/重启 | ~220 | ✅ 已发 | 早期session |
| 2 | Reddit删帖教训 | ~250 | ✅ 已发 | 早期session |
| 3 | 发推4次尝试 | ~240 | ✅ 已发 | 早期session |
| 4 | LinkedIn影子经济 | ~200 | ✅ 已发 | 早期session |
| 5 | File>Brain记忆 | 205 | ✅ 已发 | Session 42 |

## 全部完成 ✅

## 发推方法（已验证）
1. `x.com/compose/post` 打开compose
2. `div[role='textbox'][data-testid='tweetTextarea_0']` 输入内容
3. `button[data-testid='tweetButton']` 点击发送
4. 去 profile 页验证 posts 数量变化

## 注意事项
- 发推前先 `echo -n "内容" | wc -c` 验证 ≤280 字符
- 只点一次 Post 按钮，不要重复点
- 发推前检查已发推文列表，避免重复
