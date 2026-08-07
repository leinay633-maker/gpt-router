'use strict';
/**
 * Responses 适配器：Anthropic Messages ↔ OpenAI Responses 双向翻译。
 *
 * 这条线的存在理由：有些提供方只把某些模型挂在 Responses 协议上，
 * 而 Claude Code 只会说 Anthropic Messages。翻译发生在这里。
 */

const upstreamHttp = require('../../http/upstream');
const errors = require('../../http/errors');
const { anthropicToResponses } = require('./to-upstream');
const { responsesToAnthropicMessage } = require('./from-upstream');
const { createSSETranslator } = require('./sse');

/**
 * 解析模型别名：公开名 → 上游真名 + effort。
 * 没配别名就原样透传模型名，effort 留空。
 */
function resolveModel(route, model) {
  const mapped = route.modelMap && route.modelMap[model];
  return mapped
    ? { model: mapped.model, effort: mapped.effort || null }
    : { model, effort: null };
}

function handleResponses(ctx) {
  const { req, res, parsed, route, clientKey, model, log, started } = ctx;
  const { upstream } = route;

  // mode=client 时凭证来自请求；取不到就不该往上游打。
  const key = route.auth.mode === 'client' ? clientKey : route.key;
  if (!key && route.auth.mode !== 'none') {
    errors.unauthorized(res, '请求未携带凭证');
    return;
  }

  if (!parsed) {
    errors.badRequest(res, 'responses 适配器需要 JSON 请求体');
    return;
  }

  const resolved = resolveModel(route, model);
  const tag = upstreamHttp.describe(upstream);
  const routeTag = `${model}→${resolved.model}(${resolved.effort || 'default'})`;

  let upBody;
  try {
    const converted = anthropicToResponses(parsed, resolved, {
      reasoningSummary: route.reasoningSummary,
    });
    upBody = Buffer.from(JSON.stringify(converted), 'utf8');
  } catch (e) {
    log.error(`${req.method} ${req.url} model=${routeTag} CONVERT_ERROR ${e.message}`);
    errors.internal(res, `请求转换失败: ${e.message}`);
    return;
  }

  const headers = upstreamHttp.buildHeaders({
    incoming: req.headers,
    route,
    clientKey,
    contentLength: upBody.length,
  });
  headers['content-type'] = 'application/json';
  headers.accept = parsed.stream ? 'text/event-stream' : 'application/json';

  const logDone = (extra) => {
    log.info(`${req.method} ${req.url} model=${routeTag} route=${route.name} up=${tag} key=${log.key(key)} ${extra}`);
  };

  const upReq = upstreamHttp.request({
    upstream,
    path: route.requestPath,
    method: 'POST',
    headers,
    timeoutMs: route.timeoutMs,

    onResponse: (upRes) => {
      if (upRes.statusCode !== 200) {
        const chunks = [];
        upRes.on('data', (c) => chunks.push(c));
        upRes.on('error', () => {});
        upRes.on('end', () => {
          const msg = errors.extractUpstreamMessage(Buffer.concat(chunks).toString('utf8'));
          logDone(`status=${upRes.statusCode} dur=${Date.now() - started}ms`);
          errors.fromUpstream(res, upRes.statusCode, msg, 'responses');
        });
        return;
      }

      if (parsed.stream) {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
        });
        const translator = createSSETranslator({
          model, // 回给客户端的是公开名，不是上游真名
          synthesizeBoundaries: route.synthesizeStreamBoundaries,
          emit: (event, payload) => {
            if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
          },
          onDone: (stop) => logDone(`status=200 stop=${stop} dur=${Date.now() - started}ms`),
        });

        upRes.setEncoding('utf8');
        upRes.on('data', (c) => translator.feed(c));
        upRes.on('error', (e) => {
          log.warn(`${req.method} ${req.url} model=${routeTag} UPSTREAM_RES_ERROR ${e.message}`);
          translator.finish(); // 已收到的内容仍然交付
          res.end();
        });
        upRes.on('end', () => {
          translator.finish();
          res.end();
        });
        return;
      }

      const chunks = [];
      upRes.on('data', (c) => chunks.push(c));
      upRes.on('error', (e) => {
        log.warn(`${req.method} ${req.url} model=${routeTag} UPSTREAM_RES_ERROR ${e.message}`);
        res.destroy();
      });
      upRes.on('end', () => {
        try {
          const parsedUp = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(responsesToAnthropicMessage(parsedUp, model)));
          logDone(`status=200 dur=${Date.now() - started}ms`);
        } catch (e) {
          log.error(`${req.method} ${req.url} model=${routeTag} NONSTREAM_CONVERT_ERROR ${e.message}`);
          errors.internal(res, `响应转换失败: ${e.message}`);
        }
      });
    },

    onError: (e) => {
      log.warn(`${req.method} ${req.url} model=${routeTag} ERROR ${e.message} dur=${Date.now() - started}ms`);
      if (!res.headersSent) errors.badGateway(res, e.message);
      else res.end();
    },
  });

  res.on('close', () => {
    if (!res.writableEnded) upReq.destroy();
  });

  upReq.end(upBody);
}

module.exports = { handleResponses, resolveModel };
