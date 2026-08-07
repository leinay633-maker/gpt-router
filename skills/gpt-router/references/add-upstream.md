# 加上游、加路由

改 `~/.gpt-router/config.json`。展示改动、确认、写入、`gpt-router check`、`gpt-router restart`。

## 两步

**第一步：在 `upstreams` 里定义主机。**

```jsonc
"upstreams": {
  "myprovider": {
    "protocol": "https",        // http | https，默认 https
    "host": "api.example.com",  // 裸主机名，不带协议不带路径
    "port": 443,                // 省略则按 protocol 取 443/80
    "pathPrefix": ""            // 上游要求的路径前缀，如 "/anthropic"
  }
}
```

`host` 填成 `https://api.example.com` 是最常见的错误，校验器会专门检出并告诉你改成什么。

**第二步：在 `routes` 里加一条规则。** 数组顺序即优先级，第一个命中的生效。带 `default: true` 的那条必须恰好有一条，永远兜底。

```jsonc
{
  "name": "myprovider",                  // 小写字母数字连字符，唯一
  "match": { "model": ["mymodel*"] },    // 模型名前缀
  "adapter": "passthrough",              // passthrough | responses
  "upstream": "myprovider",
  "auth": {
    "mode": "secrets",
    "secretKey": "MYPROVIDER_KEY",
    "header": "authorization"            // authorization | x-api-key
  },
  "allowModels": ["mymodel-pro", "mymodel-lite"]
}
```

凭证放 `~/.gpt-router/secrets.json`：

```json
{ "MYPROVIDER_KEY": "..." }
```

## 选 adapter

**`passthrough`** —— 上游说 Anthropic Messages 协议。请求原样转发，只换鉴权头和路径前缀。

**`responses`** —— 上游说 OpenAI Responses 协议（`/v1/responses`）。代理做双向翻译。用这个的场景是某些模型只挂在 Responses 线上，Messages 线拿不到。

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
  },
  "synthesizeStreamBoundaries": true     // 上游不发 completed 事件时合成收尾
}
```

两个适配器的专属字段不能混用，混了是硬报错（配了不生效属于静默陷阱）：

- 只能给 `responses`：`requestPath`、`modelMap`、`reasoningSummary`、`synthesizeStreamBoundaries`
- 只能给 `passthrough`：`bodyOverrides`、`bodyOverridePaths`

## 选 auth.mode

必须显式写，没有默认值。**这个选择决定用户的 Claude Code 凭证会不会被转发出去。**

| mode | 用哪个凭证 | 客户端凭证 | 什么时候用 |
|---|---|---|---|
| `client` | 请求里带的那个 | 原样转发 | 上游就是官方端点，或用户确实想用同一个 key |
| `secrets` | `secrets.json` 里的 | 默认剥离 | 第三方上游、独立账号 |
| `env` | 环境变量里的 | 默认剥离 | 同上，但凭证由外部注入（CI、容器） |
| `none` | 不带 | 剥离 | 本地自建的无鉴权上游 |

`mode: "env"` 或 `"secrets"` 时不能配 `header: "inherit"`——拿了自己的 key 却不说放哪个头是无意义的，校验器会报错。

**给第三方上游配 `client` 之前想清楚**：那意味着用户的 Claude Code 凭证会明文发给那台主机。要提醒用户。

## 有用的可选项

**`allowModels`** —— 白名单。有些上游对不认识的模型名会静默降级到别的模型而不报错，那种情况下用户以为在用 A 实际在用 B。本地挡住比事后发现好。

**`bodyOverrides`**（仅 passthrough）—— 在路由层钉死某些请求参数，避免会话级设置改掉它：

```jsonc
"bodyOverrides": { "output_config": { "effort": "max" } },
"bodyOverridePaths": ["/v1/messages"]
```

浅合并，保留原有的同级键。

**`retry`** —— 默认对 429/502/503/504 和连接错误重试 5 次，退避 `[0,400,800,1600,3200,6400]`ms。只在还没向客户端写出任何字节时重试。

如果上游用非标准方式报告间歇性软错误（比如 400 加特定文案），可以按响应体正则重试：

```jsonc
"retry": {
  "bodyPattern": "temporarily unavailable",
  "bodyPatternStatuses": [400]
}
```

默认关闭。官方端点不需要这个——需要它说明上游在用非标准方式报错，校验器会给一条提醒。

**`required`** —— 设 `true` 时，凭证取不到会让服务**启动失败**。默认 `false`，此时凭证缺失的路由被标记为 degraded，命中返回 503，其他路由照常工作。

## 验证

```bash
gpt-router check       # 配置有问题时退出码 78，一次列出全部
gpt-router restart
gpt-router status      # 看新路由在不在，有没有 degraded
```

然后在 Claude Code 里 `/model <新模型名>` 实际发一轮对话。`gpt-router logs -n 20` 能看到请求走了哪条路由、上游是谁、状态码和耗时。

## 校验报错对照

| 报错 | 怎么改 |
|---|---|
| `未知字段` + 相近建议 | 按建议改拼写 |
| `不能包含协议前缀` | `host` 填裸主机名，协议写 `protocol` |
| `mode="secrets" 缺少 secretKey` | 补上 `secrets.json` 里的键名 |
| `不能配 header="inherit"` | 改成 `authorization` 或 `x-api-key` |
| `没有兜底路由` | 给一条路由加 `default: true` |
| `有 N 条兜底路由` | 只留一条 `default: true` |
| `这是 adapter="X" 专属字段` | 删掉，或换对 adapter |
| `这个值看起来是一个凭证` | 移到 `secrets.json`，用 `secretKey` 引用 |
| `别名 "X" 不在 allowModels 里` | 加进白名单或从 `modelMap` 删掉 |
