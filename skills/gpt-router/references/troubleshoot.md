# 排障

先跑 `gpt-router doctor`。它逐项检查 Node 版本、配置、自启注册、服务响应、路由凭证、`ANTHROPIC_BASE_URL`，哪项 ✗ 就从那里入手。

看日志：`gpt-router logs -n 50`，跟随加 `-f`。每条请求日志含模型名、命中的路由、上游、状态码、耗时，重试会有单独的 `RETRY` 行。

## 症状对照

### 所有 API 请求都失败

代理没在跑，或 `ANTHROPIC_BASE_URL` 指错了。

```bash
gpt-router status
curl http://127.0.0.1:8402/healthz
```

`healthz` 返回 JSON 说明服务活着。这时检查环境变量的端口跟 `config.json` 的 `listen.port` 是否一致，以及用户有没有重开终端。

应急回退：临时去掉 `ANTHROPIC_BASE_URL` 重开终端，Claude Code 会直连官方。

### WebFetch 报 "Unable to verify if domain is safe to fetch"

这句报错看起来像网络故障或企业策略拦截，**实际是路由错投**。

Claude Code 抓网页前会 `GET /api/web/domain_info`，这个端点只存在于 `api.anthropic.com` 且不需要鉴权。如果它跟着请求转发给了别的上游，通常拿到 200 加空 body，CC 解析不到 `can_fetch` 就报这句话。

检查 `config.json`：

```jsonc
"builtins": { "domainInfo": { "enabled": true, "host": "api.anthropic.com" } }
```

`enabled` 必须是 `true`。日志里能看到这个请求有没有走对上游。

### 某个模型固定返回 503

那条路由的凭证取不到，被标记为 degraded。

```bash
gpt-router status    # 看哪条路由带 degraded
```

报错信息会说清是缺环境变量还是 `secrets.json` 里没那个键。补上之后 `gpt-router restart`——凭证在启动时读取，改完 `secrets.json` 不重启不生效。

这是有意设计：拿空 key 去打上游会换回一个看不懂的 401，不如本地明确报 503。

### 流式回答内容完整但 CC 一直不收尾

上游没发 `response.completed` 事件，流直接断了。`synthesizeStreamBoundaries`（默认开）会合成一个正常收尾；如果被关了就会卡住。

仅 `responses` 适配器相关。

### 模型名带 `[1m]` 被上游拒绝

`builtins.stripModelSuffix` 被关了。Claude Code 用 `claude-sonnet-5[1m]` 这种写法在界面上表达 1M 上下文，但上游只认裸名——真正让 1M 生效的是 `anthropic-beta` 请求头。默认开启，别关。

### 上下文占用显示得离谱

`responses` 路由的 `count_tokens` 是本地粗估（字节数除以 4），因为 Responses 协议没这个端点。中文会偏低。这个数字只用于界面显示，不参与计费或截断，属预期行为。

可以调 `estimateBytesPerToken`，但改不出准确值。

### 装了但重启后不自启

```bash
gpt-router status    # 看「注册」那一行
```

Windows 上常见原因是安全软件拦了 Startup 目录的 `.lnk` 创建（同目录普通文件反而能写）。代理会自动降级到注册表 `HKCU\...\Run`，`status` 显示实际用的哪种。两种都失败的话 `install` 会明确报错而不是假装成功。

Linux 上如果 `status` 显示已启用但重启后没起来，大概率是没开 linger——用户登出后 systemd user unit 会被杀。让用户自己跑 `loginctl enable-linger $USER`。

macOS 和 Linux 的自启**未在实机验证过**，遇到问题这是首要怀疑对象。

### `install` 说端口被别的服务占用

端口上有东西应答但 `/healthz` 认不出是自己，或者是另一个 `configPath` 不同的 gpt-router 实例。

改 `listen.port` 换端口，或先停掉那个服务。多个实例不能共用端口。

### 日志里每几秒一条启动记录

这是崩溃循环。看 `~/.gpt-router/supervisor.err.log`，keepalive 会记录退出码。

连续快速失败 5 次后会自动停止重试并留一行说明，不会无限刷。先 `gpt-router check` 排配置问题。

注意：服务在端口被占用时退出码是 0，表示"已有实例在跑，我主动退出"——这**不是**崩溃，三个平台的监督层都不会因此重启它。

### 请求很慢或偶发失败

日志里找 `RETRY` 行。默认对 429/502/503/504 和连接错误重试 5 次，退避到 6.4 秒，所以一次请求最坏会等十几秒。

重试只发生在还没向客户端写出任何字节时。一旦上游回了 200 就立即透传，此后不重试——重发会让内容出现两遍。

### 想确认某个请求走了哪条路由

```bash
gpt-router logs -f
```

然后在 CC 里发一轮。日志形如：

```
POST /v1/messages model=xxx route=myprovider up=api.example.com key=…ab12 status=200 dur=1234ms
```

`responses` 适配器的日志会显示 `model=公开名→上游真名(effort)`。

## 收集诊断信息

要用户提供信息时，这三样最有用：

```bash
gpt-router doctor
gpt-router status --json
gpt-router logs -n 50
```

日志只含模型名、状态码、耗时和凭证末 4 位，不含 prompt 内容（除非用户开了 `log.logBodies`，那种情况下要提醒他们日志里有对话内容，分享前先看一眼）。
