'use strict';
/**
 * Anthropic Messages 请求 → OpenAI Responses 请求。
 *
 * 两个协议对"一轮对话"的建模方式不同，转换时有三处需要留意：
 *
 * - Anthropic 把 tool_result 放在 user 消息的 content 数组里；Responses 要求
 *   function_call_output 是顶层 input 项。所以遇到它必须先把攒着的文本 flush
 *   成一条消息，再单独插入——否则顺序会乱。
 *
 * - thinking 块的 signature 是不透明凭据，客户端下一轮会原样带回来。
 *   Responses 侧对应 reasoning 项的 encrypted_content。两边字段名不同但语义
 *   一致，直接搬运即可，不要试图解析。
 *
 * - tools 的 JSON Schema 直接复用（input_schema → parameters），但 strict 必须
 *   为 false：Claude Code 的工具 schema 用了 Responses strict 模式不支持的构造。
 */

/** system 可以是字符串或 block 数组，统一成纯文本。 */
function systemToText(sys) {
  if (!sys) return '';
  if (typeof sys === 'string') return sys;
  if (Array.isArray(sys)) {
    return sys.map((b) => (b && b.type === 'text' ? b.text : '')).filter(Boolean).join('\n\n');
  }
  return '';
}

/** Responses 的 function_call_output 只收字符串，所以 block 数组要拍平。 */
function toolResultToText(block) {
  let text = '';
  const c = block.content;
  if (typeof c === 'string') {
    text = c;
  } else if (Array.isArray(c)) {
    text = c.map((b) => (b && b.type === 'text' ? b.text : '')).filter(Boolean).join('\n');
  }
  return block.is_error ? `Error: ${text}` : text;
}

/**
 * @param {object} body Anthropic Messages 请求体
 * @param {object} resolved 选路结果：{model, effort} —— model 是上游真名
 * @param {object} [routeOpts] {reasoningSummary}
 */
function anthropicToResponses(body, resolved, routeOpts = {}) {
  const input = [];

  for (const msg of body.messages || []) {
    const content = typeof msg.content === 'string'
      ? [{ type: 'text', text: msg.content }]
      : (msg.content || []);

    if (msg.role === 'user') {
      let parts = [];
      const flush = () => {
        if (parts.length) { input.push({ role: 'user', content: parts }); parts = []; }
      };
      for (const b of content) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text') {
          parts.push({ type: 'input_text', text: b.text || '' });
        } else if (b.type === 'tool_result') {
          // 必须先 flush：function_call_output 是顶层项，插在攒着的文本之前会乱序
          flush();
          input.push({ type: 'function_call_output', call_id: b.tool_use_id, output: toolResultToText(b) });
        }
      }
      flush();
    } else if (msg.role === 'assistant') {
      let parts = [];
      const flush = () => {
        if (parts.length) { input.push({ role: 'assistant', content: parts }); parts = []; }
      };
      for (const b of content) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text') {
          parts.push({ type: 'output_text', text: b.text || '' });
        } else if (b.type === 'tool_use') {
          flush();
          input.push({
            type: 'function_call',
            call_id: b.id,
            name: b.name,
            arguments: JSON.stringify(b.input || {}),
          });
        } else if (b.type === 'thinking' && typeof b.signature === 'string' && b.signature.length > 0) {
          flush();
          input.push({ type: 'reasoning', encrypted_content: b.signature, summary: [] });
        }
      }
      flush();
    }
  }

  const out = {
    model: resolved.model,
    input,
    stream: !!body.stream,
    // 不让上游存储这轮对话——代理是透明中间层，不该替用户决定数据留存。
    store: false,
  };

  const sys = systemToText(body.system);
  if (sys) out.instructions = sys;
  if (body.max_tokens) out.max_output_tokens = body.max_tokens;

  if (resolved.effort) {
    out.reasoning = {
      effort: resolved.effort,
      summary: routeOpts.reasoningSummary || 'auto',
    };
  }

  const tools = (body.tools || []).filter((t) => t && t.input_schema);
  if (tools.length) {
    out.tools = tools.map((t) => ({
      type: 'function',
      name: t.name,
      description: t.description || '',
      parameters: t.input_schema,
      // Claude Code 的工具 schema 含 strict 模式不支持的构造，必须关掉
      strict: false,
    }));
  }

  if (body.tool_choice) {
    const tc = body.tool_choice.type;
    out.tool_choice = tc === 'tool' ? { type: 'function', name: body.tool_choice.name }
      : tc === 'any' ? 'required'
      : tc === 'none' ? 'none'
      : 'auto';
  }

  return out;
}

module.exports = { anthropicToResponses, systemToText, toolResultToText };
