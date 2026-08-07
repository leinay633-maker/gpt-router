'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

const { anthropicToResponses, systemToText, toolResultToText } = require('../src/adapters/responses/to-upstream');
const { responsesToAnthropicMessage } = require('../src/adapters/responses/from-upstream');

const RESOLVED = { model: 'upstream-real-name', effort: null };

test('纯文本对话转换', () => {
  const out = anthropicToResponses({
    messages: [{ role: 'user', content: 'hi' }],
  }, RESOLVED);

  assert.strictEqual(out.model, 'upstream-real-name');
  assert.strictEqual(out.store, false, '不替用户决定上游是否留存对话');
  assert.deepStrictEqual(out.input, [
    { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
  ]);
});

test('system 提到顶层 instructions', () => {
  const out = anthropicToResponses({
    system: 'be brief',
    messages: [{ role: 'user', content: 'hi' }],
  }, RESOLVED);
  assert.strictEqual(out.instructions, 'be brief');
});

test('system 为 block 数组时拼接', () => {
  assert.strictEqual(
    systemToText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]),
    'a\n\nb',
  );
  assert.strictEqual(systemToText(undefined), '');
  assert.strictEqual(systemToText('plain'), 'plain');
});

test('assistant 的 tool_use 转成顶层 function_call', () => {
  const out = anthropicToResponses({
    messages: [
      { role: 'user', content: 'read it' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'sure' },
          { type: 'tool_use', id: 'call_1', name: 'Read', input: { file_path: '/x' } },
        ],
      },
    ],
  }, RESOLVED);

  const fc = out.input.find((i) => i.type === 'function_call');
  assert.strictEqual(fc.call_id, 'call_1');
  assert.strictEqual(fc.name, 'Read');
  assert.deepStrictEqual(JSON.parse(fc.arguments), { file_path: '/x' });

  // 文本必须排在 function_call 之前
  const textIdx = out.input.findIndex((i) => i.role === 'assistant');
  const fcIdx = out.input.indexOf(fc);
  assert.ok(textIdx < fcIdx, 'flush 后再插入，顺序不能乱');
});

test('user 的 tool_result 转成顶层 function_call_output 且不打乱顺序', () => {
  const out = anthropicToResponses({
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'before' },
        { type: 'tool_result', tool_use_id: 'call_1', content: 'file body' },
        { type: 'text', text: 'after' },
      ],
    }],
  }, RESOLVED);

  assert.deepStrictEqual(out.input.map((i) => i.type || i.role), ['user', 'function_call_output', 'user']);
  assert.strictEqual(out.input[1].call_id, 'call_1');
  assert.strictEqual(out.input[1].output, 'file body');
  assert.strictEqual(out.input[0].content[0].text, 'before');
  assert.strictEqual(out.input[2].content[0].text, 'after');
});

test('tool_result 的错误标记转成文本前缀', () => {
  assert.strictEqual(toolResultToText({ content: 'oops', is_error: true }), 'Error: oops');
  assert.strictEqual(
    toolResultToText({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }),
    'a\nb',
  );
});

test('thinking 的 signature 搬进 encrypted_content', () => {
  const out = anthropicToResponses({
    messages: [{
      role: 'assistant',
      content: [{ type: 'thinking', thinking: 'hidden', signature: 'sig-blob' }],
    }],
  }, RESOLVED);

  const reasoning = out.input.find((i) => i.type === 'reasoning');
  assert.strictEqual(reasoning.encrypted_content, 'sig-blob');
});

test('没有 signature 的 thinking 块被丢弃', () => {
  const out = anthropicToResponses({
    messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'x' }] }],
  }, RESOLVED);
  assert.ok(!out.input.some((i) => i.type === 'reasoning'), '无签名的 reasoning 上游不会接受');
});

test('tools 转换且 strict 必须为 false', () => {
  const out = anthropicToResponses({
    messages: [{ role: 'user', content: 'x' }],
    tools: [
      { name: 'Read', description: 'read a file', input_schema: { type: 'object', properties: {} } },
      { name: 'NoSchema' }, // 缺 input_schema，应被过滤
    ],
  }, RESOLVED);

  assert.strictEqual(out.tools.length, 1, '缺 input_schema 的工具被过滤');
  assert.strictEqual(out.tools[0].type, 'function');
  assert.strictEqual(out.tools[0].name, 'Read');
  assert.strictEqual(out.tools[0].strict, false, 'CC 的 schema 不兼容 strict 模式');
  assert.deepStrictEqual(out.tools[0].parameters, { type: 'object', properties: {} });
});

test('tool_choice 四种取值映射', () => {
  const call = (tc) => anthropicToResponses(
    { messages: [{ role: 'user', content: 'x' }], tool_choice: tc },
    RESOLVED,
  ).tool_choice;

  assert.deepStrictEqual(call({ type: 'tool', name: 'Read' }), { type: 'function', name: 'Read' });
  assert.strictEqual(call({ type: 'any' }), 'required');
  assert.strictEqual(call({ type: 'none' }), 'none');
  assert.strictEqual(call({ type: 'auto' }), 'auto');
});

test('effort 生成 reasoning 配置', () => {
  const out = anthropicToResponses(
    { messages: [{ role: 'user', content: 'x' }] },
    { model: 'm', effort: 'high' },
    { reasoningSummary: 'concise' },
  );
  assert.deepStrictEqual(out.reasoning, { effort: 'high', summary: 'concise' });
});

test('没有 effort 时不带 reasoning 字段', () => {
  const out = anthropicToResponses({ messages: [] }, { model: 'm', effort: null });
  assert.strictEqual(out.reasoning, undefined);
});

test('max_tokens 映射成 max_output_tokens', () => {
  const out = anthropicToResponses({ messages: [], max_tokens: 4096 }, RESOLVED);
  assert.strictEqual(out.max_output_tokens, 4096);
});

test('畸形 content block 被跳过而不崩', () => {
  const out = anthropicToResponses({
    messages: [{ role: 'user', content: [null, 'not-an-object', { type: 'text', text: 'ok' }] }],
  }, RESOLVED);
  assert.strictEqual(out.input[0].content.length, 1);
});

// ── 反向 ──
test('非流式响应转回 Anthropic 消息', () => {
  const msg = responsesToAnthropicMessage({
    id: 'resp_1',
    output: [
      { type: 'reasoning', encrypted_content: 'sig' },
      { type: 'message', content: [{ type: 'output_text', text: 'hello' }] },
    ],
    usage: { input_tokens: 30, output_tokens: 5, input_tokens_details: { cached_tokens: 10 } },
  }, 'public-name');

  assert.strictEqual(msg.type, 'message');
  assert.strictEqual(msg.role, 'assistant');
  assert.strictEqual(msg.model, 'public-name', '回给客户端的是公开名');
  assert.strictEqual(msg.stop_reason, 'end_turn');
  assert.deepStrictEqual(msg.content[0], { type: 'thinking', thinking: '', signature: 'sig' });
  assert.deepStrictEqual(msg.content[1], { type: 'text', text: 'hello' });
  assert.strictEqual(msg.usage.input_tokens, 20);
  assert.strictEqual(msg.usage.cache_read_input_tokens, 10);
});

test('含 function_call 的响应 stop_reason 为 tool_use', () => {
  const msg = responsesToAnthropicMessage({
    output: [{ type: 'function_call', call_id: 'c1', name: 'Read', arguments: '{"a":1}' }],
  }, 'm');
  assert.strictEqual(msg.stop_reason, 'tool_use');
  assert.deepStrictEqual(msg.content[0], { type: 'tool_use', id: 'c1', name: 'Read', input: { a: 1 } });
});

test('function_call 参数非法 JSON 时降级为空对象而非整轮失败', () => {
  const msg = responsesToAnthropicMessage({
    output: [{ type: 'function_call', call_id: 'c1', name: 'Read', arguments: '{broken' }],
  }, 'm');
  assert.deepStrictEqual(msg.content[0].input, {});
});

test('status=incomplete 映射成 max_tokens', () => {
  const msg = responsesToAnthropicMessage({ status: 'incomplete', output: [] }, 'm');
  assert.strictEqual(msg.stop_reason, 'max_tokens');
});

test('空响应不崩', () => {
  const msg = responsesToAnthropicMessage({}, 'm');
  assert.deepStrictEqual(msg.content, []);
  assert.strictEqual(msg.stop_reason, 'end_turn');
});

// ── 往返：单向测试看不出的字段错配，往返能抓到 ──
test('工具调用往返后语义不变', () => {
  const original = {
    messages: [
      { role: 'user', content: 'read /x' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '', signature: 'sig-1' },
          { type: 'tool_use', id: 'call_1', name: 'Read', input: { file_path: '/x' } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'body' }] },
    ],
  };

  const upstream = anthropicToResponses(original, RESOLVED);

  // 模拟上游把 input 里的 assistant 部分作为 output 回放
  const back = responsesToAnthropicMessage({
    output: upstream.input.filter((i) => i.type === 'reasoning' || i.type === 'function_call'),
  }, 'm');

  const thinking = back.content.find((c) => c.type === 'thinking');
  const toolUse = back.content.find((c) => c.type === 'tool_use');
  assert.strictEqual(thinking.signature, 'sig-1', 'signature 往返不丢');
  assert.strictEqual(toolUse.id, 'call_1', 'call_id 往返不丢');
  assert.deepStrictEqual(toolUse.input, { file_path: '/x' }, 'arguments 往返不丢');
});
