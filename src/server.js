'use strict';
/**
 * 请求生命周期。
 *
 * 顺序是有意的：安全守卫在最前面（包括 healthz 和 domain_info——它们是 GET，
 * 恰恰是浏览器最容易打到的），然后才是内置端点、选路、适配器。
 */

const http = require('node:http');

const originGuard = require('./security/origin-guard');
const tokenGuard = require('./security/token');
const healthz = require('./builtins/healthz');
const domainInfo = require('./builtins/domain-info');
const countTokens = require('./builtins/count-tokens');
const modelSuffix = require('./builtins/model-suffix');
const { checkAdmission, applyBodyOverrides } = require('./router');
const { handlePassthrough } = require('./adapters/passthrough');
const { handleResponses } = require('./adapters/responses');
const upstreamHttp = require('./http/upstream');
const errors = require('./http/errors');

/**
 * @param {object} config loadConfig 的产物
 * @param {object} log createLogger 的产物
 * @param {object} [deps] 测试时注入 secrets（令牌）
 */
function createServer(config, log, deps = {}) {
  const startedAt = Date.now();
  const routerToken = config.listen.requireToken ? (deps.routerToken || null) : null;

  const server = http.createServer((req, res) => {
    const started = Date.now();
    res.on('error', () => {}); // 客户端断开时别让未捕获错误打死进程

    // ── 安全守卫最先跑 ──
    if (config.listen.guardOrigin && originGuard.reject(req, res, log)) return;
    if (tokenGuard.reject(req, res, routerToken, log)) return;

    // ── 内置端点 ──
    if (req.method === 'GET' && req.url === '/healthz') {
      if (!config.builtins.healthz) {
        errors.sendError(res, 404, errors.TYPES.notFound, 'healthz 已关闭');
        return;
      }
      healthz.handle({ res, config, startedAt });
      return;
    }

    if (req.method === 'GET' && domainInfo.isDomainInfoPath(req.url)) {
      if (config.builtins.domainInfo.enabled) {
        domainInfo.handle({ req, res, config, log, started });
        return;
      }
      // 关掉的话就当普通请求走选路，交给兜底路由转发
    }

    // ── 读请求体 ──
    const chunks = [];
    req.on('error', () => {});
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = Buffer.concat(chunks);
      let parsed = null;
      let model = '-';

      try {
        parsed = JSON.parse(body.toString('utf8'));
        model = parsed.model || '-';
      } catch {
        parsed = null; // GET 或非 JSON body，交给透传处理
      }

      // 剥 [1m] 这类后缀。上游只认裸名，1M 靠 anthropic-beta 头生效。
      if (config.builtins.stripModelSuffix && typeof model === 'string') {
        const stripped = modelSuffix.applyToBody(parsed, body, model);
        model = stripped.model;
        body = stripped.body;
      }

      const route = config.pickRoute(model);
      if (!route) {
        // 校验层保证了必有兜底路由，走到这里说明是内部错误
        errors.internal(res, '没有可用路由');
        return;
      }

      const admission = checkAdmission(route, model);
      if (!admission.ok) {
        log.warn(`${req.method} ${req.url} model=${model} route=${route.name} REJECT ${admission.message} dur=${Date.now() - started}ms`);
        errors.sendError(res, admission.status, admission.type, errors.prefixed(admission.message));
        return;
      }

      const clientKey = upstreamHttp.extractClientKey(req.headers);

      // count_tokens：Responses 线没这个端点，只能本地估算
      if (countTokens.isCountTokensPath(req.url)) {
        if (countTokens.handle({ req, res, parsed, route, log, started })) return;
      }

      // 在路由层钉死某些请求参数，避免会话级设置把它改掉
      const overridden = applyBodyOverrides(route, parsed, body, req.url);
      parsed = overridden.parsed;
      body = overridden.body;

      if (config.log.logBodies) {
        log.debug(`${req.method} ${req.url} body=${body.toString('utf8').slice(0, 4000)}`);
      }

      const ctx = { req, res, body, parsed, route, clientKey, model, log, started };
      if (route.adapter === 'responses') handleResponses(ctx);
      else handlePassthrough(ctx);
    });
  });

  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  return server;
}

/**
 * 起服务。EADDRINUSE 视为"已有实例在跑"，退出码 0——
 * 这样监督层不会把它当成崩溃反复重启（原实现在这里有个无限重启的坑）。
 */
function listen(config, log, deps = {}) {
  const server = createServer(config, log, deps);

  return new Promise((resolve, reject) => {
    server.on('error', (e) => {
      if (e.code === 'EADDRINUSE') {
        log.info(`端口 ${config.listen.port} 已被占用，疑似已有实例在跑，本实例退出`);
        const err = new Error('EADDRINUSE');
        err.alreadyRunning = true;
        reject(err);
        return;
      }
      reject(e);
    });

    server.listen(config.listen.port, config.listen.host, () => {
      const routeSummary = config.routes
        .map((r) => `${r.name}[${r.adapter}→${upstreamHttp.describe(r.upstream)}${r.degraded ? ' DEGRADED' : ''}]`)
        .join(' ');
      log.info(`gpt-router 启动 listen=${config.listen.host}:${config.listen.port} routes=${routeSummary}`);
      for (const w of config.warnings) log.warn(w);
      resolve(server);
    });
  });
}

module.exports = { createServer, listen };
