'use strict';
/**
 * /v1/messages/count_tokens 的三种处理策略。
 *
 * 为什么这是路由级而非全局：Anthropic Messages 协议有这个端点，
 * OpenAI Responses 协议没有。所以 passthrough 路由默认转发给上游，
 * responses 路由只能本地粗估。这个差异是协议本质，不是偏好。
 *
 * 粗估会让客户端的上下文占用显示偏离真实值，但比整个功能报错好——
 * Claude Code 拿不到这个数字会拒绝发送请求。
 */

const errors = require('../http/errors');

const isCountTokensPath = (url) => url.startsWith('/v1/messages/count_tokens');

/**
 * 本地估算。除以 4 是英文文本的经验值；中文会偏低，但这个数字只用于
 * 客户端显示上下文占用，不参与计费或截断决策。
 */
function estimate(parsed, bytesPerToken) {
  const bytes = Buffer.byteLength(JSON.stringify(parsed || {}), 'utf8');
  return Math.ceil(bytes / (bytesPerToken || 4));
}

/**
 * @returns {boolean} true 表示已处理完，调用方不必继续
 */
function handle(ctx) {
  const { req, res, parsed, route, log, started } = ctx;

  if (route.countTokens === 'forward') return false; // 交给适配器转发

  if (route.countTokens === 'reject') {
    errors.badRequest(res, `路由 "${route.name}" 的上游不支持 count_tokens`);
    return true;
  }

  const n = estimate(parsed, route.estimateBytesPerToken);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ input_tokens: n }));
  log.info(`${req.method} ${req.url} route=${route.name} count_tokens≈${n} (estimated) dur=${Date.now() - started}ms`);
  return true;
}

module.exports = { handle, estimate, isCountTokensPath };
