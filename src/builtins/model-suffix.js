'use strict';
/**
 * 剥掉模型名的方括号后缀。
 *
 * Claude Code 用 "claude-sonnet-5[1m]" 这种写法在界面上表达 1M 上下文，
 * 但上游只认裸模型名——真正让 1M 生效的是 anthropic-beta 请求头，不是名字。
 * 带着后缀发过去会被拒。
 *
 * 这是客户端行为，与挂哪个上游无关，所以是全局内置而非路由级配置。
 */

/** @returns {string} 裸模型名 */
function stripSuffix(model) {
  if (typeof model !== 'string') return model;
  const i = model.indexOf('[');
  return i > 0 ? model.slice(0, i) : model;
}

/**
 * 就地改写请求体里的模型名。
 * @returns {{model: string, body: Buffer, changed: boolean}}
 */
function applyToBody(parsed, body, model) {
  const bare = stripSuffix(model);
  if (bare === model) return { model, body, changed: false };
  if (parsed && parsed.model !== undefined) {
    parsed.model = bare;
    return { model: bare, body: Buffer.from(JSON.stringify(parsed), 'utf8'), changed: true };
  }
  return { model: bare, body, changed: true };
}

module.exports = { stripSuffix, applyToBody };
