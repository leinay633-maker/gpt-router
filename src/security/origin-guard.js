'use strict';
/**
 * Host / Origin 守卫。默认开启。
 *
 * 绑定 127.0.0.1 挡住了外部网络，但挡不住用户浏览器里的任意网页：网页 JS 可以
 * fetch('http://127.0.0.1:8402/v1/messages')。同源策略会阻止它读取响应，但请求
 * 已经发出、上游已经计费；配合 DNS rebinding 甚至能读到响应。
 *
 * 这是"任何本机进程都能花用户额度"这个大问题里唯一能廉价堵住的入口，所以默认开。
 *
 * 三道检查：
 *   1. Host 头必须是回环。攻击者用 DNS rebinding 时，他的域名会出现在 Host 里。
 *   2. 出现 Origin 或跨站的 Sec-Fetch-Site 一律拒绝。Claude Code 是 Node 客户端，
 *      不发这两个头，所以正常使用不受影响。
 *   3. 永不返回 Access-Control-Allow-Origin，让浏览器的预检自己失败。
 */

const errors = require('../http/errors');

/** Host 头允许的形态，端口可有可无。 */
const LOOPBACK_HOST_RE = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i;

/**
 * @returns {{allowed: true} | {allowed: false, reason: string}}
 */
function inspect(headers) {
  const host = headers.host || '';
  if (!LOOPBACK_HOST_RE.test(host)) {
    // 空 Host 也拒绝：HTTP/1.1 要求必须带，缺失说明不是正常客户端。
    return { allowed: false, reason: host ? `Host 头不是回环地址："${host}"` : '缺少 Host 头' };
  }

  if (headers.origin) {
    return { allowed: false, reason: `带了 Origin 头："${headers.origin}"，说明请求来自浏览器页面` };
  }

  const site = headers['sec-fetch-site'];
  if (site && site !== 'none' && site !== 'same-origin') {
    return { allowed: false, reason: `Sec-Fetch-Site: ${site}` };
  }

  return { allowed: true };
}

/**
 * 在所有处理器之前调用，包括 healthz 和 domain_info——这两个是 GET，
 * 恰恰是浏览器最容易打到的。
 *
 * @returns {boolean} true 表示已拒绝，调用方应立即返回
 */
function reject(req, res, log) {
  const verdict = inspect(req.headers);
  if (verdict.allowed) return false;

  log.warn(`${req.method} ${req.url} BLOCKED ${verdict.reason}`);
  errors.forbidden(res, `请求被本地守卫拒绝：${verdict.reason}`);
  return true;
}

module.exports = { inspect, reject, LOOPBACK_HOST_RE };
