# 装机、环境变量、卸载

## 装

```bash
npx gpt-router install
```

或从仓库跑 `node bin/gpt-router.js install`。

`install` 做四件事：在 `~/.gpt-router/` 生成 `config.json` 和 `secrets.json`（已存在则不动）、注册登录自启、启动服务、打印该设的环境变量。它是幂等的，重复跑等于覆盖注册文件加重启。

不想注册自启就加 `--no-autostart`，之后手动 `gpt-router run`。

装完确认：

```bash
gpt-router status
```

`注册` 和 `运行` 两行都要正常。只有前者正常说明装上了但没起来，去看 `gpt-router logs`。

## 环境变量

这一步代理不会替用户做。

```bash
# Windows
setx ANTHROPIC_BASE_URL "http://127.0.0.1:8402"

# macOS / Linux，写进 ~/.zshrc 或 ~/.bashrc
export ANTHROPIC_BASE_URL="http://127.0.0.1:8402"
```

端口要跟 `config.json` 里的 `listen.port` 一致。设完**必须重开终端**，Claude Code 只在启动时读环境变量。

验证：

```bash
gpt-router doctor
```

`ANTHROPIC_BASE_URL` 那项显示 ✓ 才算好。

### 帮用户设之前

这个变量影响所有 Claude Code 会话，包括用户可能正在跑的其他项目。改之前说清楚，确认了再动。

在 Windows 上还有一个坑值得提醒：如果用户同时在用别的 Claude 工具（比如别的 Claude Code 封装），有些工具会读 `~/.claude/settings.json` 而不只是环境变量，把 base URL 写进那里可能让它们静默走到这个代理上。**优先用环境变量，不要写进 settings.json。**

## 换端口

改 `~/.gpt-router/config.json` 的 `listen.port`，然后：

```bash
gpt-router check && gpt-router restart
```

别忘了同步改 `ANTHROPIC_BASE_URL`，并重开终端。

## 卸载

```bash
gpt-router uninstall
```

停服 + 移除自启，**保留**配置和凭证。

```bash
gpt-router uninstall --purge
```

连 `~/.gpt-router/` 一起删，含 `secrets.json`。**不可逆，执行前必须明确确认。**

两种情况都要提醒用户手动去掉 `ANTHROPIC_BASE_URL`——留着它而代理已经没了，Claude Code 会所有请求都失败。

## 平台差异

| 平台 | 自启方式 | 谁看着进程 |
|---|---|---|
| Windows | 启动文件夹 `.lnk`，被拦时降级到注册表 `HKCU\...\Run` | 代理自带的 keepalive |
| macOS | `~/Library/LaunchAgents` 的 plist | launchd |
| Linux | `~/.config/systemd/user/` 的 unit | systemd |

Linux 上如果用户没开 linger，登出后服务会被杀。`install` 会检测并提示，但**不自动改**——那影响系统级行为。要开的话让用户自己跑：

```bash
loginctl enable-linger $USER
```

没有 systemd 的环境（WSL1、部分容器、runit/openrc 发行版）装不了自启，`install` 会明确报错。降级方案是手动 `gpt-router run` 配自己的进程管理器。

**macOS 和 Linux 的自启目前未在实机验证过。** 代码和测试都有，但没有真机跑过。如果用户在这两个平台上遇到问题，这是首要怀疑对象，值得如实告知而不是假设它能工作。
