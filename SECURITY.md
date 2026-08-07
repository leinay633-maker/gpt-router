# 安全策略

## 报告漏洞

请通过 GitHub 的 [Security Advisories](https://github.com/<owner>/gpt-router/security/advisories/new) 私下报告，不要开公开 issue。

我会尽力在几天内回应。这是个人维护的小项目，没有 SLA。

## 本项目的威胁模型

gpt-router 是一个跑在开发者自己机器上的本地代理。它的安全目标是有限的，写在这里避免误解：

**在威胁模型内：**

- 外部网络无法访问代理。默认只绑定 `127.0.0.1`；要监听其他地址必须同时显式解锁 `listen.allowNonLoopback` 并开启 `listen.requireToken`。
- 浏览器里的网页无法通过 JS 访问代理。Host/Origin 守卫默认开启，覆盖 DNS rebinding。
- 凭证不出现在 git 仓库里。`secrets.json` 被 `.gitignore` 忽略，配置校验器会拒绝把凭证写进 `config.json`，仓库自带的扫描器（`scripts/scan-secrets.js`）可作为 pre-commit 钩子。
- 凭证不出现在日志里。只记录末 4 位。
- 客户端凭证不会意外泄给第三方上游。`auth.mode` 为 `env` 或 `secrets` 时默认剥离客户端凭证；要关掉必须写一个名字很难忽视的确认字段。

**不在威胁模型内：**

- **同机进程。** 任何以你的身份运行的程序都能向代理发请求并花掉你的上游额度。这跟把 API key 放在环境变量里的暴露面基本相同——能发请求的进程通常也能读到凭证文件。`listen.requireToken` 只能挡住那些能发请求但读不到你 home 目录的进程（沙箱化的构建脚本、受限 runner）。
- **静态加密。** `secrets.json` 是明文文件，靠文件系统权限保护（POSIX 上 0600）。它不是密钥保险库。
- **第三方上游的行为。** 你把上游指向哪台主机、那台主机拿你的 prompt 和凭证做什么，本项目无法也不会负责。仓库不预置任何第三方中转服务，示例只有官方端点。
- **多用户共享主机。** 设计假设是单用户工作站。

## 版本支持

只维护最新版本。

## 依赖

零运行期依赖，只用 Node 内置模块。这是有意的设计约束，CI 里有断言保证（`scripts/verify-no-deps.js`），所以本项目没有第三方供应链面。
