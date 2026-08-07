'use strict';
/**
 * GET /healthz —— 服务自述。
 *
 * 原实现回纯文本 "ok"。改成 JSON 是为了让 CLI 的 status/doctor 有单一真相
 * 可读：进程活着不等于路由可用（比如凭证缺失的路由是 degraded），这两件事
 * 分开报告才能定位"装了但不工作"这类最常见的故障。
 */

const PKG_VERSION = require('../../package.json').version;

function handle({ res, config, startedAt }) {
  const routes = config.routes.map((r) => ({
    name: r.name,
    adapter: r.adapter,
    upstream: r.upstream.host + (r.upstream.pathPrefix || ''),
    default: r.isDefault,
    degraded: r.degraded,
    ...(r.degraded ? { reason: r.degradedReason } : {}),
  }));

  const payload = {
    ok: true,
    version: PKG_VERSION,
    pid: process.pid,
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    listen: `${config.listen.host}:${config.listen.port}`,
    configPath: config.configPath,
    logFile: config.log.file,
    routes,
    degradedCount: routes.filter((r) => r.degraded).length,
  };

  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload, null, 2));
}

module.exports = { handle, PKG_VERSION };
