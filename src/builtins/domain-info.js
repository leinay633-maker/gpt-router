'use strict';
/**
 * WebFetch 预检端点：强制回官方域。
 *
 * Claude Code 抓网页前会先 GET /api/web/domain_info?domain=<host>，
 * 期望拿到 {"can_fetch": true}。这个端点只存在于 api.anthropic.com，
 * 且不需要鉴权。
 *
 * 如果跟着 ANTHROPIC_BASE_URL 一起转发给别的上游，通常会拿到 200 加空
 * body，CC 解析不到 can_fetch 就报 "Unable to verify if domain is safe to
 * fetch"——这句话看起来像网络故障或企业策略拦截，实际是路由错投。这个坑
 * 值得专门处理，因为报错内容把人指向了完全错误的方向。
 */

const https = require('node:https');

const isDomainInfoPath = (url) => url.startsWith('/api/web/domain_info');

function handle(ctx) {
  const { req, res, config, log, started } = ctx;
  const cfg = config.builtins.domainInfo;

  const upReq = https.request(
    {
      host: cfg.host,
      port: 443,
      path: req.url,
      method: 'GET',
      headers: { accept: 'application/json', 'user-agent': 'gpt-router' },
    },
    (upRes) => {
      const chunks = [];
      upRes.on('data', (c) => chunks.push(c));
      upRes.on('error', () => {});
      upRes.on('end', () => {
        if (res.writableEnded) return;
        res.writeHead(upRes.statusCode, {
          'content-type': upRes.headers['content-type'] || 'application/json',
        });
        res.end(Buffer.concat(chunks));
        log.info(`GET ${req.url} status=${upRes.statusCode} up=${cfg.host} dur=${Date.now() - started}ms`);
      });
    },
  );

  upReq.setTimeout(cfg.timeoutMs, () => {
    upReq.destroy(new Error(`domain_info timeout ${Math.round(cfg.timeoutMs / 1000)}s`));
  });

  upReq.on('error', (e) => {
    log.warn(`GET ${req.url} up=${cfg.host} ERROR ${e.message} dur=${Date.now() - started}ms`);
    if (res.writableEnded) return;
    if (cfg.failOpen) {
      // 预检失败就放行，让真实抓取自己决定成败——否则一个预检故障
      // 会把 WebFetch 整个功能卡死。
      if (!res.headersSent) res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ domain: '', can_fetch: true }));
    } else {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `domain_info: ${e.message}` } }));
    }
  });

  res.on('close', () => {
    if (!res.writableEnded) upReq.destroy();
  });

  upReq.end();
}

module.exports = { handle, isDomainInfoPath };
