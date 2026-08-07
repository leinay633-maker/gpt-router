'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { createSSETranslator, usageToAnthropic } = require('../src/adapters/responses/sse');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

/** 收集翻译器发出的事件，供断言。 */
function collect(opts = {}) {
  const events = [];
  const done = [];
  const tr = createSSETranslator({
    model: opts.model || 'test-model',
    emit: (event, payload) => events.push({ event, payload }),
    onDone: (stop) => done.push(stop),
    synthesizeBoundaries: opts.synthesizeBoundaries,
  });
  return { tr, events, done, names: () => events.map((e) => e.event) };
}

const textOf = (events) => events
  .filter((e) => e.event === 'content_block_delta' && e.payload.delta.type === 'text_delta')
  .map((e) => e.payload.delta.text)
  .join('');

test('正常流翻译成合规的 Anthropic 事件序列', () => {
  const { tr, events, names, done } = collect();
  tr.feed(fixture('responses-normal.sse'));
  tr.finish();

  assert.strictEqual(names()[0], 'message_start', 'message_start 必须是第一个事件');
  assert.strictEqual(names().at(-1), 'message_stop');
  assert.strictEqual(textOf(events), 'Hello, world');
  assert.deepStrictEqual(done, ['end_turn']);

  // content_block_start/stop 必须配对
  const starts = names().filter((n) => n === 'content_block_start').length;
  const stops = names().filter((n) => n === 'content_block_stop').length;
  assert.strictEqual(starts, stops, 'content_block 必须配对');
});

test('message_start 只发一次', () => {
  const { tr, names } = collect();
  tr.feed(fixture('responses-normal.sse'));
  tr.finish();
  assert.strictEqual(names().filter((n) => n === 'message_start').length, 1);
});

test('usage 里的 cache 命中从 input_tokens 扣除', () => {
  const { tr, events } = collect();
  tr.feed(fixture('responses-normal.sse'));
  const md = events.find((e) => e.event === 'message_delta');
  assert.strictEqual(md.payload.usage.input_tokens, 20, '120 - 100 cached');
  assert.strictEqual(md.payload.usage.cache_read_input_tokens, 100);
  assert.strictEqual(md.payload.usage.output_tokens, 8);
});

// ── 防御路径一：上游不发 response.created ──
test('缺 response.created 时仍合成 message_start', () => {
  const { tr, events, names } = collect();
  tr.feed(fixture('responses-no-created.sse'));

  assert.strictEqual(names()[0], 'message_start');
  assert.strictEqual(textOf(events), 'answer text');
});

// ── 防御路径二：上游不发 response.completed，流直接断 ──
test('缺 response.completed 时合成正常收尾而非报错', () => {
  const { tr, events, names, done } = collect();
  tr.feed(fixture('responses-no-created.sse'));
  tr.finish();

  assert.strictEqual(names().at(-1), 'message_stop');
  assert.ok(!names().includes('error'), '不该报错——内容是完整的');
  assert.deepStrictEqual(done, ['end_turn']);
  // 内容仍然完整
  assert.strictEqual(textOf(events), 'answer text');
});

test('关掉 synthesizeBoundaries 后缺 completed 会报错', () => {
  const { tr, names } = collect({ synthesizeBoundaries: false });
  tr.feed(fixture('responses-no-created.sse'));
  tr.finish();
  assert.ok(names().includes('error'), '严格模式下应报错');
});

// ── 工具调用 ──
test('工具调用流：thinking 签名与 input_json 增量都保留', () => {
  const { tr, events, names, done } = collect();
  tr.feed(fixture('responses-tool-call.sse'));
  tr.finish();

  const thinking = events.filter((e) => e.event === 'content_block_delta' && e.payload.delta.type === 'thinking_delta');
  assert.strictEqual(thinking.map((e) => e.payload.delta.thinking).join(''), 'Need to read the file.');

  const sig = events.find((e) => e.event === 'content_block_delta' && e.payload.delta.type === 'signature_delta');
  assert.strictEqual(sig.payload.delta.signature, 'sig-opaque-blob', 'encrypted_content → signature 原样搬运');

  const toolStart = events.find((e) => e.event === 'content_block_start' && e.payload.content_block.type === 'tool_use');
  assert.strictEqual(toolStart.payload.content_block.id, 'call_1');
  assert.strictEqual(toolStart.payload.content_block.name, 'Read');

  const json = events
    .filter((e) => e.event === 'content_block_delta' && e.payload.delta.type === 'input_json_delta')
    .map((e) => e.payload.delta.partial_json)
    .join('');
  assert.deepStrictEqual(JSON.parse(json), { file_path: '/tmp/x' });

  assert.deepStrictEqual(done, ['tool_use'], '有工具调用时 stop_reason 是 tool_use');
  assert.strictEqual(tr.sawToolUse, true);
});

// ── 分块喂入 ──
test('任意切分喂入结果一致', () => {
  const raw = fixture('responses-normal.sse');
  for (const size of [1, 3, 17, 64, 1000]) {
    const { tr, events } = collect();
    for (let i = 0; i < raw.length; i += size) tr.feed(raw.slice(i, i + size));
    tr.finish();
    assert.strictEqual(textOf(events), 'Hello, world', `切分大小 ${size} 时结果应一致`);
  }
});

// ── 异常与边界 ──
test('response.failed 转成 error 事件', () => {
  const { tr, names, events } = collect();
  tr.feed('data: {"type":"response.created","response":{"id":"r"}}\n\n');
  tr.feed('data: {"type":"response.failed","response":{"error":{"message":"upstream boom"}}}\n\n');
  assert.ok(names().includes('error'));
  assert.match(events.find((e) => e.event === 'error').payload.error.message, /upstream boom/);
});

test('error 事件后不再发别的东西', () => {
  const { tr, names } = collect();
  tr.feed('data: {"type":"error","message":"bad"}\n\n');
  tr.feed('data: {"type":"response.output_text.delta","delta":"ignored"}\n\n');
  tr.finish();
  const afterError = names().slice(names().indexOf('error') + 1);
  assert.deepStrictEqual(afterError, [], '收尾后应静默');
});

test('response.incomplete 映射成 max_tokens', () => {
  const { tr, done } = collect();
  tr.feed('data: {"type":"response.incomplete","response":{"usage":{"output_tokens":5}}}\n\n');
  assert.deepStrictEqual(done, ['max_tokens']);
});

test('未知事件类型被忽略而不是让整轮失败', () => {
  const { tr, names } = collect();
  tr.feed('data: {"type":"response.created","response":{"id":"r"}}\n\n');
  tr.feed('data: {"type":"response.some_future_event","foo":1}\n\n');
  tr.feed('data: {"type":"response.completed","response":{}}\n\n');
  assert.ok(!names().includes('error'));
  assert.strictEqual(names().at(-1), 'message_stop');
});

test('半个 JSON 与 [DONE] 都不会崩', () => {
  const { tr, names } = collect();
  tr.feed('data: {broken\n\n');
  tr.feed('data: [DONE]\n\n');
  tr.finish();
  assert.strictEqual(names().at(-1), 'message_stop');
});

test('finish 幂等', () => {
  const { tr, names } = collect();
  tr.feed(fixture('responses-normal.sse'));
  tr.finish();
  const n1 = names().length;
  tr.finish();
  tr.finish();
  assert.strictEqual(names().length, n1);
});

test('usageToAnthropic 处理空输入', () => {
  assert.deepStrictEqual(usageToAnthropic(null), {
    input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0,
  });
});

test('cached 大于 input 时不产生负数', () => {
  const u = usageToAnthropic({ input_tokens: 10, input_tokens_details: { cached_tokens: 50 } });
  assert.strictEqual(u.input_tokens, 0);
});
