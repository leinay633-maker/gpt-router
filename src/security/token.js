'use strict';
/**
 * 可选的本地共享令牌。默认关闭。
 *
 * 挡的是"能向本地端口发请求、但读不到你 home 目录文件"的攻击者：沙箱化的构建
 * 脚本、受限的 CI runner、恶意的 npm postinstall。对能读你文件的攻击者无效——
 * 令牌本身就在 secrets.json 里。
 *
 * 默认关是因为开启后 Claude Code 侧要多配一个自定义头，装机从一步变两步，
 * 而单用户桌面场景换来的边际安全很小。
 */

const crypto = require('node:crypto');
const errors = require('../http/errors');

const HEADER = 'x-gpt-router-token';

/**
 * 定长比较，避免按字节短路带来的时序信息泄漏。
 * 本地场景意义有限，但写对不费事。
 */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  // timingSafeEqual 要求等长，所以先比长度——长度本身不是秘密。
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * @returns {boolean} true 表示已拒绝，调用方应立即返回
 */
function reject(req, res, expected, log) {
  if (!expected) return false; // 未启用

  const provided = req.headers[HEADER];
  if (!provided) {
    log.warn(`${req.method} ${req.url} BLOCKED 缺少 ${HEADER} 头`);
    errors.unauthorized(res, `本路由要求本地令牌，请在请求里带 ${HEADER} 头`);
    return true;
  }

  if (!safeEqual(provided, expected)) {
    log.warn(`${req.method} ${req.url} BLOCKED ${HEADER} 不匹配`);
    errors.unauthorized(res, `${HEADER} 不正确`);
    return true;
  }

  return false;
}

module.exports = { reject, safeEqual, HEADER };
