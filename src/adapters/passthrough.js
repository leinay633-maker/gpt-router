'use strict';
/**
 * 透传适配器：把 Anthropic Messages 请求原样转发给上游。
 *
 * 重试的时序约束是这里最要紧的事：一旦上游回了 200 就立即 pipe（保持流式低
 * 延迟），此后不再重试——内容已经在往客户端走了，重发会让用户看到两遍。
 * 所以重试只发生在"请求被秒拒、还没写出任何字节"的阶段。
 */

const upstreamHttp = require('../http/upstream');
const { shouldRetry, backoffFor, canAttemptAgain } = require('../http/retry');
const errors = require('../http/errors');

/**
 * @param {object} ctx
 * @param {import('node:http').IncomingMessage} ctx.req
 * @param {import('node:http').ServerResponse} ctx.res
 * @param {Buffer} ctx.body 可能已被 bodyOverrides 改写
 * @param {object} ctx.route 规范化后的路由
 * @param {string|null} ctx.clientKey
 * @param {string} ctx.model 公开模型名，仅用于日志
 * @param {object} ctx.log
 * @param {number} ctx.started Date.now()
 * @param {number} [ctx.attempt]
 */
function handlePassthrough(ctx) {
  const { req, res, body, route, clientKey, model, log, started } = ctx;
  const attempt = ctx.attempt || 0;
  const { upstream, retry } = route;

  const tag = upstreamHttp.describe(upstream);
  const keyNote = route.auth.mode === 'client' ? 'client-key' : `key=${log.key(route.key)}`;
  const logLine = (extra) => {
    const retryNote = attempt ? ` retry=${attempt}` : '';
    log.info(`${req.method} ${req.url} model=${model} route=${route.name} up=${tag} ${keyNote}${retryNote} ${extra}`);
  };

  const headers = upstreamHttp.buildHeaders({
    incoming: req.headers,
    route,
    clientKey,
    contentLength: Buffer.byteLength(body),
  });

  /** 安排一次重试。客户端已断开就放弃，别白花上游额度。 */
  const scheduleRetry = (reason) => {
    const next = attempt + 1;
    log.info(`${req.method} ${req.url} model=${model} route=${route.name} RETRY attempt=${next} reason=${reason} dur=${Date.now() - started}ms`);
    setTimeout(() => {
      if (res.writableEnded || res.destroyed) return;
      handlePassthrough({ ...ctx, attempt: next });
    }, backoffFor(retry, next));
  };

  const upReq = upstreamHttp.request({
    upstream,
    path: upstreamHttp.joinPath(upstream, req.url),
    method: req.method,
    headers,
    timeoutMs: route.timeoutMs,

    onResponse: (upRes) => {
      // 200：立刻 pipe，保持流式低延迟。此后不可重试。
      if (upRes.statusCode === 200) {
        const h = { ...upRes.headers };
        delete h.connection;
        delete h['transfer-encoding'];
        res.writeHead(200, h);
        upRes.on('error', (e) => {
          log.warn(`${req.method} ${req.url} route=${route.name} UPSTREAM_RES_ERROR ${e.message}`);
          res.destroy();
        });
        upRes.pipe(res);
        upRes.on('end', () => logLine(`status=200 dur=${Date.now() - started}ms`));
        return;
      }

      // 非 200：缓冲完整响应体后再决定。此刻还没写出任何字节，重试是安全的。
      const chunks = [];
      upRes.on('data', (c) => chunks.push(c));
      upRes.on('error', () => {});
      upRes.on('end', () => {
        const buf = Buffer.concat(chunks);
        const text = buf.toString('utf8');
        const verdict = shouldRetry(retry, { status: upRes.statusCode, bodyText: text, errorMessage: null });

        if (verdict.retry && canAttemptAgain(retry, attempt)) {
          scheduleRetry(verdict.reason);
          return;
        }

        // 不可重试或已达上限：把上游的原始响应交回客户端。
        const h = { ...upRes.headers };
        delete h.connection;
        delete h['transfer-encoding'];
        if (!res.headersSent) res.writeHead(upRes.statusCode, h);
        res.end(buf);
        logLine(`status=${upRes.statusCode} dur=${Date.now() - started}ms (final)`);
      });
    },

    onError: (e) => {
      const verdict = shouldRetry(retry, { status: null, bodyText: null, errorMessage: e.message });
      if (verdict.retry && canAttemptAgain(retry, attempt) && !res.headersSent) {
        scheduleRetry(verdict.reason);
        return;
      }
      log.warn(`${req.method} ${req.url} model=${model} route=${route.name} ERROR ${e.message} dur=${Date.now() - started}ms`);
      errors.badGateway(res, e.message);
    },
  });

  // 客户端提前断开就别继续占着上游连接。
  res.on('close', () => {
    if (!res.writableEnded) upReq.destroy();
  });

  upReq.end(body);
}

module.exports = { handlePassthrough };
