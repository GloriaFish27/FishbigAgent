# 🐟 FishbigAgent 保姆级部署指南

> 完全零基础也能部署！跟着步骤走，30 分钟搞定。

---

## 📋 前置要求

| 工具 | 版本 | 安装方式 |
|------|------|---------|
| Node.js | >= 18 | [nodejs.org](https://nodejs.org) 下载安装 |
| npm | >= 9 | 随 Node.js 自带 |
| Git | 任意 | `brew install git` (Mac) |
| PM2 | >= 5 | `npm install -g pm2` |

**检查是否已安装**：
```bash
node -v    # 应该显示 v18.x 或更高
npm -v     # 应该显示 9.x 或更高
git -v     # 应该显示 git version 2.x
```

---

## Step 1: 克隆项目

```bash
git clone https://github.com/YOUR_USERNAME/FishbigAgent.git
cd FishbigAgent
npm install
```

---

## Step 2: 创建飞书自建应用

> 飞书是消息通道，必须配置。如果你用其他 IM，可以替换 `src/channels/feishu.ts`。

1. 打开 [飞书开放平台](https://open.feishu.cn/app)
2. 点击 **「创建企业自建应用」**
3. 名称随意填（如 FishbigAgent）
4. 进入应用 → **凭证与基础信息** → 复制 `App ID` 和 `App Secret`
5. 进入 **应用功能** → 开启 **机器人**
6. 进入 **事件与回调** → 添加 **接收消息事件** (`im.message.receive_v1`)
7. 配置 **请求地址**：
   - 如果你有公网服务器：`https://你的域名/webhook/event`
   - 如果本地开发：用 [ngrok](https://ngrok.com) 做内网穿透

### 飞书权限配置
在 **权限管理** 中开通以下权限：
- `im:message` — 获取与发送消息
- `im:chat` — 获取群聊信息
- `docx:document` — 创建文档
- `drive:drive` — 上传文件

8. 发布应用 → 管理员审批通过
9. 在飞书群里 **添加机器人** → 搜索你的应用名

---

## Step 3: 创建 Notion Integration

1. 打开 [notion.so/my-integrations](https://www.notion.so/my-integrations)
2. 点 **「+ New integration」**
3. Type 选 **Internal**
4. 名称填 `FishbigAgent`
5. 权限勾选：✅ Read ✅ Update ✅ Insert
6. 复制 **Integration Token**（以 `ntn_` 开头）

### 创建 Notion 数据库

在 Notion 中创建一个 Page，然后运行以下脚本自动创建 3 个数据库：

```bash
# 替换下面的值
export NOTION_TOKEN="ntn_你的token"
export NOTION_PAGE_ID="你的page的ID"

node scripts/setup-notion.mjs
```

> 📝 **Page ID 获取方式**：打开 Notion 页面 → URL 中最后的 32 位字符
> 
> 例如 `https://notion.so/My-Page-abc123def456` → ID 是 `abc123def456`

别忘了在这个 Page 上添加 Connection → FishbigAgent！

---

## Step 4: 配置 Google Cloud ADC（LLM 调用）

> FishbigAgent 使用 Google Cloud 的 Vertex AI / Gemini API。

1. 安装 Google Cloud CLI：
```bash
# Mac
brew install google-cloud-sdk

# 或下载安装
# https://cloud.google.com/sdk/docs/install
```

2. 登录并配置：
```bash
gcloud auth login
gcloud auth application-default login
gcloud config set project 你的项目ID
```

3. 确保已启用 Vertex AI API：
```bash
gcloud services enable aiplatform.googleapis.com
```

---

## Step 5: 配置文件

```bash
# 从模板创建配置文件
cp config/config.example.json config/config.json
```

编辑 `config/config.json`：

```json
{
    "feishu": {
        "appId": "你的飞书App ID",
        "appSecret": "你的飞书App Secret"
    },
    "notion": {
        "token": "ntn_你的Notion Token",
        "briefingDbId": "每日简报数据库ID",
        "topicDbId": "选题库数据库ID",
        "materialDbId": "素材库数据库ID"
    },
    "gcpProjectId": "你的GCP项目ID",
    "workspacePath": "./workspace",
    "defaultModel": "gemini-2.0-flash",
    "heartbeatMinutes": 120,
    "cron": {
        "morningSchedule": "0 8 * * *"
    }
}
```

### 信息源配置（可选自定义）

编辑 `config/sources.json` — 修改你关注的 Reddit 板块和关键词：

```json
{
    "reddit": {
        "core_subreddits": ["AI_Agents", "LLMDevs", "LocalLLaMA", "MachineLearning", "SaaS", "ecommerce"]
    }
}
```

### 内容策略配置（可选自定义）

编辑 `config/content-strategy.json` — 修改你的人设和受众：

```json
{
    "persona": {
        "account_name": "你的账号名",
        "identity": "你的身份描述",
        "positioning": "你的内容定位"
    }
}
```

---

## Step 6: X.com 推文获取（可选）

> X.com 没有官方 API 给普通用户，我们通过 Cookie 模拟登录获取。

1. 用 Chrome 登录 x.com
2. 打开 DevTools (F12) → Application → Cookies
3. 找到 `auth_token` 和 `ct0` 的值
4. 创建 `data/x-cookies.json`：

```json
{
    "auth_token": "你的auth_token值",
    "ct0": "你的ct0值"
}
```

> ⚠️ Cookie 会过期，需要定期更新。如果不需要 X.com 数据，可以跳过此步。

---

## Step 7: 编译和启动

```bash
# 编译 TypeScript
npx tsc

# 用 PM2 启动（后台运行 + 自动重启）
pm2 start ecosystem.config.cjs

# 查看日志
pm2 logs fishbig

# 查看状态
pm2 status
```

### 手动触发测试

```bash
# 手动触发一次每日简报（替换为你的飞书群聊 ID）
node -e '
import("./dist/engine/daily-briefing.js").then(m => {
    m.generateDailyBriefing("你的飞书群聊ID").then(console.log);
});
'
```

> 📝 **群聊 ID 获取方式**：飞书群设置 → 群号

---

## Step 8: 设置开机自启（可选）

```bash
pm2 save
pm2 startup
# 按提示执行生成的命令
```

---

## 🔧 常见问题

### Q: Reddit 扫描报 429 Too Many Requests
A: Reddit 限流，等几分钟再试。默认每天只跑一次（08:00），不会触发限流。

### Q: LLM 分析返回空结果
A: 检查 Google Cloud ADC 是否过期：`gcloud auth application-default print-access-token`

### Q: Notion 写入报 `object_not_found`
A: 确保数据库页面已添加 FishbigAgent Integration 的 Connection。

### Q: 飞书消息收不到
A: 检查 Webhook URL 是否正确配置，应用是否已发布审批。

### Q: X.com 获取失败
A: Cookie 可能过期了，重新从浏览器复制。

---

## 📁 数据目录说明

```
data/
├── auth.json          # Google Cloud ADC 凭证（自动生成）
├── x-cookies.json     # X.com Cookie（手动创建）
├── inbox/             # 收到的消息
├── outbox/            # 发出的消息
├── history/           # 对话历史
└── memory/            # Agent 记忆
```

---

## 🔄 日常维护

| 操作 | 命令 |
|------|------|
| 查看日志 | `pm2 logs fishbig` |
| 重启 | `pm2 restart fishbig` |
| 停止 | `pm2 stop fishbig` |
| 更新代码 | `git pull && npx tsc && pm2 restart fishbig` |

---

**有问题？提 Issue 或联系作者 🐟**
