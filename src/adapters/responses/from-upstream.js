'use strict';
/**
 * OpenAI Responses 响应 → Anthropic Messages 响应（非流式）。
 *
 * 流式走 sse.js；这里处理一次性返回的完整响应体。
 */

const { usageToAnthropic } = require('./sse');

/**
 * @param {object} r Responses 响应体
 * @param {string} publicModel 回给客户端的模型名（不是上游真名）
 */
function responsesToAnthropicMessage(r, publicModel) {
  const content = [];
  let hasToolUse = false;

  for (const item of r.output || []) {
    if (item.type === 'reasoning') {
      // thinking 正文拿不到（网关通常不吐 summary），但 signature 必须保留，
      // 否则客户端下一轮无法带回，上游会拒绝这条 reasoning 记录。
      content.push({ type: 'thinking', thinking: '', signature: item.encrypted_content || '' });
    } else if (item.type === 'message') {
      for (const p of item.content || []) {
        if (p.type === 'output_text') content.push({ type: 'text', text: p.text || '' });
      }
    } else if (item.type === 'function_call') {
      hasToolUse = true;
      let inputObj = {};
      try {
        inputObj = JSON.parse(item.arguments || '{}');
      } catch {
        // 上游给了非法 JSON——保留空对象比整轮失败好，客户端会报参数错误
      }
      content.push({ type: 'tool_use', id: item.call_id, name: item.name, input: inputObj });
    }
  }

  const stopReason = hasToolUse ? 'tool_use'
    : r.status === 'incomplete' ? 'max_tokens'
    : 'end_turn';

  return {
    id: r.id || 'msg_router',
    type: 'message',
    role: 'assistant',
    model: publicModel,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: usageToAnthropic(r.usage),
  };
}

module.exports = { responsesToAnthropicMessage };
