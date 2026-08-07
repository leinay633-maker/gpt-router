'use strict';
/**
 * OpenAI Responses SSE → Anthropic Messages SSE 翻译器。
 *
 * 纯状态机：喂字符串进去，吐 (event, payload) 出来。不碰 socket、不碰 fs，
 * 所以能脱离网络单测——这也是把它单独拆一个文件的主要原因。
 *
 * 两处防御值得说明，它们来自实际踩坑而非规范：
 *
 * 1. 有些 Responses 实现不发 `response.created`。Anthropic 协议要求
 *    `message_start` 必须是第一个事件，客户端拿不到它就无法开始渲染。
 *    所以任何事件到来时先确保 message_start 已发（ensureStart）。
 *
 * 2. 有些实现也不发 `response.completed`，流直接断掉。若据此报错，
 *    用户会看到一轮内容完整但标着失败的回答。所以流结束时合成一个正常
 *    的 message_stop 收尾。
 *
 * 这两条由 synthesizeStreamBoundaries 控制，默认开。关掉后严格按上游事件走。
 */

/** Anthropic 的 usage 结构与 Responses 不同：cache 命中要从 input 里扣掉。 */
function usageToAnthropic(u) {
  u = u || {};
  const det = u.input_tokens_details || {};
  const cached = det.cached_tokens || 0;
  return {
    input_tokens: Math.max(0, (u.input_tokens || 0) - cached),
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: det.cache_write_tokens || 0,
    output_tokens: u.output_tokens || 0,
  };
}

/**
 * @param {object} opts
 * @param {string} opts.model 回给客户端的模型名（公开名，不是上游真名）
 * @param {(event: string, payload: object) => void} opts.emit 发送一个 SSE 事件
 * @param {(stopReason: string) => void} [opts.onDone] 收尾回调，用于打日志
 * @param {boolean} [opts.synthesizeBoundaries=true] 见文件头注释
 */
function createSSETranslator(opts) {
  const { model, emit } = opts;
  const onDone = opts.onDone || (() => {});
  const synthesize = opts.synthesizeBoundaries !== false;

  let buf = '';
  let started = false;
  let blockIndex = -1;
  let blockOpen = false;
  let curBlockType = null;
  let hasToolUse = false;
  let finished = false;

  const ensureStart = (id) => {
    if (started) return;
    started = true;
    emit('message_start', {
      type: 'message_start',
      message: {
        id: id || 'msg_router',
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  };

  const openBlock = (contentBlock) => {
    blockIndex++;
    blockOpen = true;
    curBlockType = contentBlock.type;
    emit('content_block_start', { type: 'content_block_start', index: blockIndex, content_block: contentBlock });
  };

  const closeBlock = () => {
    if (!blockOpen) return;
    emit('content_block_stop', { type: 'content_block_stop', index: blockIndex });
    blockOpen = false;
    curBlockType = null;
  };

  const delta = (d) => {
    emit('content_block_delta', { type: 'content_block_delta', index: blockIndex, delta: d });
  };

  const finishMessage = (stopReason, usage) => {
    if (finished) return;
    ensureStart();
    closeBlock();
    emit('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: usageToAnthropic(usage),
    });
    emit('message_stop', { type: 'message_stop' });
    finished = true;
    onDone(stopReason);
  };

  const fail = (message) => {
    if (finished) return;
    ensureStart();
    emit('error', { type: 'error', error: { type: 'api_error', message } });
    finished = true;
    onDone(`error:${message}`.slice(0, 120));
  };

  function handleEvent(d) {
    // 上游可能不发 response.created，所以任何事件都先确保 message_start 已发出。
    if (synthesize) ensureStart(d.response && d.response.id);

    switch (d.type) {
      case 'response.created':
        // 严格模式下这里才是 message_start 的来源
        ensureStart(d.response && d.response.id);
        break;

      case 'response.output_item.added': {
        const item = d.item || {};
        if (item.type === 'reasoning') {
          closeBlock();
          openBlock({ type: 'thinking', thinking: '' });
        } else if (item.type === 'function_call') {
          closeBlock();
          hasToolUse = true;
          openBlock({ type: 'tool_use', id: item.call_id, name: item.name, input: {} });
        }
        break;
      }

      case 'response.content_part.added':
        if ((d.part || {}).type === 'output_text') {
          closeBlock();
          openBlock({ type: 'text', text: '' });
        }
        break;

      case 'response.output_text.delta':
        if (curBlockType === 'text') delta({ type: 'text_delta', text: d.delta || '' });
        break;

      case 'response.reasoning_summary_text.delta':
        if (curBlockType === 'thinking') delta({ type: 'thinking_delta', thinking: d.delta || '' });
        break;

      case 'response.function_call_arguments.delta':
        if (curBlockType === 'tool_use') delta({ type: 'input_json_delta', partial_json: d.delta || '' });
        break;

      case 'response.output_item.done': {
        const item = d.item || {};
        if (item.type === 'reasoning' && curBlockType === 'thinking') {
          // thinking 块的签名靠 encrypted_content 往返：Anthropic 侧叫 signature，
          // Responses 侧叫 encrypted_content，内容原样搬运即可。
          if (item.encrypted_content) {
            delta({ type: 'signature_delta', signature: item.encrypted_content });
          }
          closeBlock();
        } else if (item.type === 'function_call') {
          closeBlock();
        }
        break;
      }

      case 'response.content_part.done':
        if (curBlockType === 'text') closeBlock();
        break;

      case 'response.completed':
        finishMessage(hasToolUse ? 'tool_use' : 'end_turn', (d.response || {}).usage);
        break;

      case 'response.incomplete':
        finishMessage('max_tokens', (d.response || {}).usage);
        break;

      case 'response.failed':
        fail(((d.response || {}).error || {}).message || 'upstream response.failed');
        break;

      case 'error':
        fail(d.message || (d.error && d.error.message) || 'upstream error event');
        break;

      default:
        // 未知事件类型忽略。Responses 协议在扩展，未知事件不该让整轮失败。
        break;
    }
  }

  return {
    /** 喂一段原始 SSE 文本。可以任意切分，跨 chunk 的事件会被缓冲。 */
    feed(chunk) {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const rawEvent = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dataLines = rawEvent
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim());
        if (!dataLines.length) continue;
        const dataStr = dataLines.join('');
        if (dataStr === '[DONE]') continue;
        let d;
        try {
          d = JSON.parse(dataStr);
        } catch {
          continue; // 半个事件或心跳，跳过
        }
        try {
          handleEvent(d);
        } catch (e) {
          fail(`translator: ${e.message}`);
        }
      }
    },

    /**
     * 上游流结束。没等到 response.completed 时合成正常收尾，
     * 而不是报错——见文件头第 2 条。
     */
    finish() {
      if (finished) return;
      if (synthesize) {
        finishMessage(hasToolUse ? 'tool_use' : 'end_turn', null);
      } else {
        fail('upstream stream ended without response.completed');
      }
    },

    get finished() { return finished; },
    get sawToolUse() { return hasToolUse; },
  };
}

module.exports = { createSSETranslator, usageToAnthropic };
