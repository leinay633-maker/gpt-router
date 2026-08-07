'use strict';
/**
 * 上游请求的统一出口。
 *
 * 原实现把 https + port 443 写死在两处，于是"配置化上游"根本无从谈起——
 * 用户接不了 http 的本地或自建上游。这里按 upstream.protocol 选模块。
 */

const http = require('node:http');
const https = require('node:https');

/** 按协议取对应的 request 实现。 */
const moduleFor = (protocol) => (protocol === 'http' ? http : https);

/**
 * 拼上游完整路径：pathPrefix + 客户端请求路径。
 * pathPrefix 的首尾斜杠已由校验层保证（以 / 开头、不以 / 结尾）。
 */
function joinPath(upstream, requestUrl) {
  const prefix = upstream.pathPrefix || '';
  return prefix + requestUrl;
}

/**
 * 按路由的 auth 配置组装发往上游的 header。
 *
 * @param {object} params
 * @param {Record<string,string>} params.incoming 客户端请求头
 * @param {object} params.route 规范化后的路由
 * @param {string|null} params.clientKey 从客户端请求里取出的凭证（mode=client 时用）
 * @param {number} [params.contentLength]
 */
function buildHeaders({ incoming, route, clientKey, contentLength }) {
  const { auth, upstream } = route;
  // inherit 模式原样转发客户端头；其余模式从干净的基础上重建，
  // 避免把 CC 的自定义头一并送给第三方上游。
  const headers = auth.header === 'inherit' ? { ...incoming } : pickSafeHeaders(incoming);

  headers.host = upstream.host;

  if (auth.stripClientAuth) {
    delete headers.authorization;
    delete headers['x-api-key'];
  }

  const key = auth.mode === 'client' ? clientKey : route.key;
  if (key && auth.header !== 'inherit') {
    if (auth.header === 'x-api-key') {
      headers['x-api-key'] = key;
      delete headers.authorization;
    } else {
      headers.authorization = `Bearer ${key}`;
      delete headers['x-api-key'];
    }
  }

  if (contentLength !== undefined) {
    headers['content-length'] = String(contentLength);
  } else {
    delete headers['content-length'];
  }

  // 逐跳头不能转发
  delete headers.connection;
  delete headers['transfer-encoding'];
  delete headers['keep-alive'];
  delete headers['proxy-authorization'];

  return headers;
}

/**
 * 非 inherit 模式下保留哪些客户端头。
 * 保留协议必需的，丢掉可能泄漏身份或让上游误判的。
 */
const SAFE_HEADERS = new Set([
  'content-type', 'accept', 'accept-encoding', 'user-agent',
  'anthropic-version', 'anthropic-beta',
]);

function pickSafeHeaders(incoming) {
  const out = {};
  for (const [k, v] of Object.entries(incoming || {})) {
    if (SAFE_HEADERS.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

/**
 * 发一个上游请求。
 *
 * @param {object} params
 * @param {object} params.upstream {protocol, host, port}
 * @param {string} params.path
 * @param {string} params.method
 * @param {Record<string,string>} params.headers
 * @param {number} params.timeoutMs
 * @param {(res: http.IncomingMessage) => void} params.onResponse
 * @param {(err: Error) => void} params.onError
 * @returns {http.ClientRequest}
 */
function request({ upstream, path, method, headers, timeoutMs, onResponse, onError }) {
  const mod = moduleFor(upstream.protocol);
  const req = mod.request(
    { host: upstream.host, port: upstream.port, path, method, headers },
    onResponse,
  );
  req.setTimeout(timeoutMs, () => {
    req.destroy(new Error(`upstream timeout ${Math.round(timeoutMs / 1000)}s`));
  });
  req.on('error', onError);
  return req;
}

/** 从客户端请求头里取凭证，两种放法都认。 */
function extractClientKey(headers) {
  return headers['x-api-key']
    || (headers.authorization || '').replace(/^Bearer\s+/i, '')
    || null;
}

/** 供日志显示的上游标识。 */
const describe = (upstream) => `${upstream.host}${upstream.pathPrefix || ''}`;

module.exports = {
  request,
  buildHeaders,
  joinPath,
  extractClientKey,
  moduleFor,
  describe,
  SAFE_HEADERS,
};
