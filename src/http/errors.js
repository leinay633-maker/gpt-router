'use strict';
/**
 * Anthropic 错误信封的统一构造。
 *
 * 原实现里这段结构在七处各写了一遍，字段偶有出入。客户端靠 error.type
 * 决定要不要重试，写歪了会让 Claude Code 表现得莫名其妙，所以收成一处。
 */

/** Anthropic 的错误类型集合，客户端据此决定行为。 */
const TYPES = {
  invalidRequest: 'invalid_request_error',
  authentication: 'authentication_error',
  permission: 'permission_error',
  notFound: 'not_found_error',
  rateLimit: 'rate_limit_error',
  api: 'api_error',
  overloaded: 'overloaded_error',
};

/** HTTP 状态码 → Anthropic 错误类型。 */
function typeForStatus(status) {
  if (status === 400) return TYPES.invalidRequest;
  if (status === 401) return TYPES.authentication;
  if (status === 403) return TYPES.permission;
  if (status === 404) return TYPES.notFound;
  if (status === 429) return TYPES.rateLimit;
  if (status === 529) return TYPES.overloaded;
  return TYPES.api;
}

function envelope(type, message) {
  return { type: 'error', error: { type, message } };
}

/** 消息统一加 gpt-router 前缀，好让用户一眼看出是代理报的还是上游报的。 */
const prefixed = (msg) => `gpt-router: ${msg}`;

/**
 * 直接把错误写进 response。已发过 header 就只 end，不硬塞第二个 header。
 * @returns {boolean} 是否成功写出
 */
function sendError(res, status, type, message) {
  if (res.writableEnded) return false;
  if (!res.headersSent) {
    res.writeHead(status, { 'content-type': 'application/json' });
  }
  res.end(JSON.stringify(envelope(type, message)));
  return true;
}

const badRequest = (res, msg) => sendError(res, 400, TYPES.invalidRequest, prefixed(msg));
const unauthorized = (res, msg) => sendError(res, 401, TYPES.authentication, prefixed(msg));
const forbidden = (res, msg) => sendError(res, 403, TYPES.permission, prefixed(msg));
const unavailable = (res, msg) => sendError(res, 503, TYPES.api, prefixed(msg));
const badGateway = (res, msg) => sendError(res, 502, TYPES.api, prefixed(msg));
const internal = (res, msg) => sendError(res, 500, TYPES.api, prefixed(msg));

/** 上游返回了非 200：保留原状态码，但把错误类型映射到 Anthropic 语义。 */
function fromUpstream(res, status, message, tag) {
  return sendError(res, status, typeForStatus(status), `upstream${tag ? `(${tag})` : ''}: ${message}`);
}

/** 从上游错误响应体里挖出人可读的消息。 */
function extractUpstreamMessage(bodyText) {
  const text = (bodyText || '').slice(0, 2000);
  try {
    const j = JSON.parse(text);
    return (j.error && (j.error.message || j.error.type)) || j.message || text;
  } catch {
    return text;
  }
}

module.exports = {
  TYPES,
  typeForStatus,
  envelope,
  prefixed,
  sendError,
  badRequest,
  unauthorized,
  forbidden,
  unavailable,
  badGateway,
  internal,
  fromUpstream,
  extractUpstreamMessage,
};
