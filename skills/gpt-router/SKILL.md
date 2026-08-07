---
name: gpt-router
description: 安装、配置和排障 gpt-router —— 一个让 Claude Code 通过自带 /model 切换器使用非 Anthropic 模型的本地代理。当用户想在 CC 里用 GPT、DeepSeek 或其他非 Anthropic 模型、需要加新上游或新路由、遇到「所有 API 请求都失败」「WebFetch 报无法验证域名」「某个模型固定返回 503」「流式回答不收尾」这类症状、或提到 gpt-router、ANTHROPIC_BASE_URL、本地代理、模型路由时使用。不适用于 Claude Code 本身的配置问题、以及不经过本代理的 API 调用。
---

# gpt-router

一个跑在 `127.0.0.1` 的反向代理。用户把 `ANTHROPIC_BASE_URL` 指向它，之后在 Claude Code 里用 `/model` 切模型，代理按模型名分流到不同上游，需要时做协议翻译。

三件事最常做，按需读对应的参考文件：

| 用户想做什么 | 读这个 |
|---|---|
| 装机、设环境变量、卸载 | [references/install.md](references/install.md) |
| 加一个上游或一条路由 | [references/add-upstream.md](references/add-upstream.md) |
| 排查故障 | [references/troubleshoot.md](references/troubleshoot.md) |

## 先搞清楚状态

任何操作之前先跑这个，它比问用户快也比猜准：

```bash
gpt-router doctor
```

它逐项报告 Node 版本、配置文件、自启注册、服务响应、路由凭证、`ANTHROPIC_BASE_URL`。哪一项是 ✗ 就从那里入手。

如果 `gpt-router` 命令不存在，说明还没装，走 install 流程。

## 操作前必须征求确认的动作

这个 skill 会碰用户机器上的持久状态。**每一项在执行前都要先说明要做什么，得到确认再做**——不要假设权限模式会替你拦住。

- 写或改 `~/.gpt-router/config.json`（先展示改动内容）
- 写 `~/.gpt-router/secrets.json`（凭证，且要提醒用户这是明文文件）
- 设置环境变量 `ANTHROPIC_BASE_URL`（影响所有 Claude Code 会话）
- `gpt-router install` / `uninstall`（注册或移除开机自启）
- `gpt-router uninstall --purge`（**会删掉配置和凭证，不可逆**）
- 停止或重启服务（会打断用户正在进行的会话）

只读的动作不用问：`doctor`、`status`、`check`、`logs`。

## 关键事实

**代理不改 Claude Code 的配置。** 装完之后 `ANTHROPIC_BASE_URL` 要用户自己设，代理只负责打印该设什么。这是有意的——改用户的 CC 配置是有副作用的跨工具写入。如果用户希望你帮着设，先确认，再用平台对应的方式（Windows `setx`、macOS/Linux 写 shell profile），并告诉他们要重开终端。

**凭证只能放 `secrets.json`。** 配置校验器会拒绝 `config.json` 里出现凭证格式的字符串，这是硬报错不是警告。别试图绕过。

**`auth.mode` 没有默认值。** 必须显式写 `client`、`env`、`secrets` 或 `none` 之一。选错的后果是安全性的：`client` 会把用户的 Claude Code 凭证原样转发给上游，配第三方上游时通常应该用 `secrets` 或 `env`（它们默认剥离客户端凭证）。

**改配置后先 `check` 再重启。** 校验在监听之前全部跑完，一次列出所有问题，退出码 78 表示配置有问题。不要改完直接重启然后去猜为什么起不来。

**不要预置第三方中转站。** 仓库示例只有官方端点。用户要接第三方是他们的选择，但要让他们知道 prompt 会明文经过那台主机。

## 常见误判

**"服务没在跑" 可能是端口被占。** `install` 会区分这两种情况，但如果用户手动跑 `run` 看到进程立刻退出且退出码是 0，那是"已有实例在跑，我主动退出"，不是崩溃。

**"装了但重启后不自启"** 在 Windows 上常见原因是安全软件拦了 Startup 目录的 `.lnk` 创建。代理会自动降级到注册表 Run 键，`status` 会显示实际用的是哪种。

**多个 home 的实例互不干扰。** `GPT_ROUTER_HOME` 不同的实例，注册文件名会带路径哈希，不会互相覆盖。但它们**不能共用一个端口**。
