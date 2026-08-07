'use strict';
/**
 * 重试判定与退避。
 *
 * 一条硬约束：重试只能发生在还没向客户端写出任何字节之前。一旦 200 到达并
 * 开始 pipe，流式内容已经在往客户端走了，再重试会把内容发两遍。所以这里只
 * 负责判断"能不能重试"，实际的时序守卫在调用方。
 */

/**
 * 这个失败值得重试吗？
 *
 * @param {object} retry 规范化后的路由 retry 配置
 * @param {object} outcome
 * @param {number|null} outcome.status HTTP 状态码，连接错误时为 null
 * @param {string|null} outcome.bodyText 响应体，仅在需要正则匹配时用到
 * @param {string|null} outcome.errorMessage 连接层错误消息
 * @returns {{retry: boolean, reason: string|null}}
 */
function shouldRetry(retry, outcome) {
  const { status, bodyText, errorMessage } = outcome;

  // 连接层失败：socket hang up、ECONNRESET、超时等。上游根本没应答，重试安全。
  if (errorMessage) {
    return retry.onConnectionError
      ? { retry: true, reason: 'conn-err' }
      : { retry: false, reason: null };
  }

  if (status !== null && retry.statuses.has(status)) {
    return { retry: true, reason: `status-${status}` };
  }

  // 有些上游用 200 之外的状态码 + 特定文案报告间歇性软错误，
  // 这种情况标准状态码判定抓不到，只能按响应体正则匹配。
  // 默认关闭——官方端点不需要，需要它说明上游在用非标准方式报错。
  if (retry.bodyPattern && status !== null && retry.bodyPatternStatuses.has(status)) {
    if (retry.bodyPattern.test(bodyText || '')) {
      return { retry: true, reason: 'body-pattern' };
    }
  }

  return { retry: false, reason: null };
}

/** 第 attempt 次尝试前该等多久。数组耗尽后用最后一个值。 */
function backoffFor(retry, attempt) {
  const arr = retry.backoffMs;
  if (!arr || !arr.length) return 0;
  return attempt < arr.length ? arr[attempt] : arr[arr.length - 1];
}

const canAttemptAgain = (retry, attempt) => attempt < retry.maxRetries;

module.exports = { shouldRetry, backoffFor, canAttemptAgain };
