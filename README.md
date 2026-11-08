# gpt-router

一个跑在本机的反向代理，让 Claude Code 用它自带的 `/model` 切换器就能用上非 Anthropic 的模型。

Claude Code 只会说 Anthropic Messages 协议。把 `ANTHROPIC_BASE_URL` 指向这个代理之后，它会按请求里的模型名分流到你配置的上游，需要的话还会做协议翻译（Messages ↔ OpenAI Responses）。切换模型的动作还是 CC 界面里那个 `/model`，不用改任何客户端设置。

零运行期依赖，只用 Node 内置模块。

```
Claude Code ──► 127.0.0.1:8402 ──┬──► 你配的上游 A（透传）
   /model 切换        gpt-router  ├──► 你配的上游 B（协议翻译）
                                 └──► api.anthropic.com（兜底）
```

## 安装

需要 Node 18 以上。

```bash
npx gpt-router install
```

或者克隆下来：

```bash
git clone https://github.com/<owner>/gpt-router
cd gpt-router
node bin/gpt-router.js install
```

`install` 会在 `~/.gpt-router/` 生成 `config.json` 和 `secrets.json`、注册登录自启、启动服务，最后打印你需要设的环境变量：

```
ANTHROPIC_BASE_URL=http://127.0.0.1:8402
```

这一步要你自己设——代理不会去改 Claude Code 的配置文件。

```bash
# Windows
setx ANTHROPIC_BASE_URL "http://127.0.0.1:8402"

# macOS / Linux：写进 ~/.zshrc 或 ~/.bashrc
export ANTHROPIC_BASE_URL="http://127.0.0.1:8402"
```

设完重开终端，然后 `gpt-router doctor` 确认。

## 命令

```
install [--port N] [--no-autostart]   生成配置、注册自启、启动
uninstall [--purge]                   停服并移除自启；--purge 连配置一起删
start | stop | restart                控制服务
status [--json]                       注册状态 + 运行状态
logs [-n N] [-f]                      看日志，-f 跟随
check [--config PATH]                 只校验配置（配置有问题时退出码 78）
doctor                                体检：Node、配置、注册、服务、环境变量
run                                   前台运行，调试用
```

`status` 把注册状态和运行状态分开报告，因为"装了但没在跑"是最常见的故障，两者一致与否本身就是诊断信息。

## 配置

`~/.gpt-router/config.json` 可以分享（不含凭证），`~/.gpt-router/secrets.json` 永不外传。

仓库里的 `config.example.json` 只带两个官方端点做示例：Anthropic 官方（兜底路由）和 DeepSeek 官方。**不预置任何第三方中转服务**——要接就自己填。

一条路由长这样：

```jsonc
{
  "name": "deepseek",
  "match": { "model": ["deepseek*"] },   // 模型名前缀，数组顺序即优先级
  "adapter": "passthrough",              // passthrough | responses
  "upstream": "deepseek",                // 引用 upstreams 里的条目
  "auth": {
    "mode": "secrets",                   // client | env | secrets | none
    "secretKey": "DEEPSEEK_KEY",         // 对应 secrets.json 里的键
    "header": "authorization"
  },
  "allowModels": ["deepseek-chat", "deepseek-reasoner"]
}
```

`auth.mode` 没有默认值，必须显式写。这是有意的：鉴权方式决定了你的凭证会不会被转发给第三方上游，隐式默认会让人在不知情的情况下泄露凭证。

- `client` —— 复用 Claude Code 请求里带的凭证，原样转发给上游
- `env` / `secrets` —— 用你为这个上游单独准备的凭证，同时**剥掉**客户端凭证
- `none` —— 不带鉴权

改完配置先 `gpt-router check` 再重启。校验在监听之前全部跑完，一次列出所有问题：

```
gpt-router: 配置校验失败，2 个问题（~/.gpt-router/config.json）

  /routes/0/auth/secretKey  mode="secrets" 缺少 secretKey
                            → 填 secrets.json 里的键名，例如 "DEEPSEEK_KEY"。
  /routes/1/allowedModels   未知字段
                            → 你是不是想写 "allowModels"？
```

未知字段是错误而不是被忽略——拼错字段名如果被静默跳过，故障会推迟到运行时才暴露。

### 接一个 OpenAI Responses 协议的上游

有些提供方把某些模型只挂在 Responses 协议上（`/v1/responses`），Messages 协议拿不到。这种用 `responses` 适配器：

```jsonc
{
  "name": "openai-responses",
  "match": { "model": ["gpt*"] },
  "adapter": "responses",
  "upstream": "openai",
  "requestPath": "/v1/responses",
  "auth": { "mode": "client", "header": "authorization" },
  "modelMap": {
    "gpt-5.1-codex-max": { "model": "gpt-5.1-codex-max", "effort": "high" }
  }
}
```

`modelMap` 把界面上看到的名字映射到上游真名，还能钉住推理档位。回给客户端的始终是你在 `/model` 里选的那个名字。

## 已知边界

**上下文估算会偏。** `responses` 适配器下 `count_tokens` 只能本地粗估（Responses 协议没这个端点），所以 CC 显示的上下文占用不准。这个数字不参与计费或截断。

**思考文本可能看不见。** 取决于上游是否返回 reasoning summary。签名会正确往返，所以多轮对话不受影响。

**某些工具可能不可用。** 走 `responses` 适配器时，依赖 Anthropic 特有端点的功能（比如 WebSearch）没有对应实现。

**macOS 和 Linux 的自启已实现但未在实机验证。** 代码写好了，测试只检查了生成的 `plist` / systemd unit 内容是否正确。Windows 的路径经过实机验证。如果你在 mac 或 Linux 上跑通了或者踩了坑，欢迎开 issue。

## 安全边界

请读完再用。

gpt-router 只监听 `127.0.0.1`，不接受来自网络的连接。但它是一个**无鉴权的本地端点**：

- ✅ 外部网络访问不到它。
- ✅ 浏览器里的网页访问不到它。默认开启的 Host/Origin 守卫会拒掉带 `Origin`、跨站 `Sec-Fetch-Site`、或 `Host` 头不是回环地址的请求，也永不返回 CORS 放行头。这挡住了网页 JS 打本地端口和 DNS rebinding。
- ⚠️ **同一台机器上以你的身份运行的任何程序都能向它发请求**，从而花掉你配置的上游额度。这跟你把 API key 直接放在环境变量或 `settings.json` 里的暴露面**基本相同**——能发请求的进程通常也能读到那些文件。gpt-router 没有扩大这个面，但也没有缩小它。
- ⚠️ 日志（默认 `~/.gpt-router/router.log`）记录模型名、状态码、耗时和凭证的**末 4 位**。不记录 prompt 内容，除非你显式打开 `log.logBodies`（不建议）。
- ⚠️ `secrets.json` 是明文。它不是密钥保险库，只保证"不进 git、不进日志"。POSIX 上 `install` 会以 0600 创建，请保持。

### 需要更强隔离时

设 `listen.requireToken: true`，在 `secrets.json` 里放 `ROUTER_TOKEN`，客户端请求带 `x-gpt-router-token` 头。这能挡住"能发本地请求但读不到你 home 目录"的进程，比如沙箱化的构建脚本或受限的 CI runner。对能读你文件的攻击者无效。

默认关闭，因为开启后要在 Claude Code 侧多配一个自定义头，而单用户桌面场景换来的边际安全很小。

### 关于第三方上游

本仓库不预置任何第三方中转服务，示例只有官方端点。如果你把 `upstreams` 指向第三方：

- `auth.mode: "client"` 意味着**把你的 Claude Code 凭证原样转发给那台主机**。
- `auth.mode: "env"` / `"secrets"` 时客户端凭证会被剥离（`stripClientAuth` 默认 true）。
- 你的 prompt 会明文经过那台主机。

风险自负。本项目不对第三方上游的行为负责。

## 排障

先跑 `gpt-router doctor`，它会逐项检查 Node 版本、配置、自启注册、服务响应、路由凭证和 `ANTHROPIC_BASE_URL`。

| 症状 | 大概率原因 |
|---|---|
| 所有 API 请求都失败 | 代理没在跑。`gpt-router status` |
| WebFetch 报 "Unable to verify if domain is safe to fetch" | `domain_info` 预检被转发到了不实现该端点的上游。检查 `builtins.domainInfo.enabled` |
| 流式回答内容完整但 CC 一直不收尾 | 上游没发 `response.completed`。开 `synthesizeStreamBoundaries`（默认已开） |
| 模型名带 `[1m]` 被上游拒绝 | `builtins.stripModelSuffix` 被关了 |
| 某条路由固定返回 503 | 该路由的凭证取不到。`gpt-router status` 看 degraded 标记 |
| 上下文占用显示离谱 | `responses` 路由的 `count_tokens` 是本地粗估，属预期 |
| `install` 说端口被别的服务占用 | 换 `listen.port`，或先停掉那个服务 |
| 装了但重启后不自启 | `gpt-router status` 看注册状态；Windows 上安全软件可能拦 Startup 目录写入，此时会自动降级到注册表 Run 键 |

日志：`gpt-router logs -f`。

## 开发

```bash
npm test                          # 165 个测试，不需要网络
node scripts/verify-no-deps.js    # 零依赖断言
node scripts/scan-secrets.js --all
```

跟你这台机器有关的词（本机用户名、内网域名）写进 `scripts/.scan-secrets.local`，一行一个正则，这个文件不进仓库，扫描时会一起用上。

克隆后建议启用 pre-commit 钩子，它会在提交前扫一遍凭证：

```bash
git config core.hooksPath .githooks
```

协议翻译层（`src/adapters/responses/`）是纯函数，可以脱离网络测试。端到端测试起一个假上游，不碰真实服务。

## 许可

MIT
