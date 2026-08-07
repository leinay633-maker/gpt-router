'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

const { shouldRetry, backoffFor, canAttemptAgain } = require('../src/http/retry');
const { buildHeaders, joinPath, extractClientKey, moduleFor, describe: describeUpstream } = require('../src/http/upstream');
const { typeForStatus, extractUpstreamMessage, envelope, TYPES } = require('../src/http/errors');

/** 模拟 load.js 规范化后的 retry 配置。 */
function retryCfg(over = {}) {
  return {
    maxRetries: 5,
    backoffMs: [0, 400, 800, 1600, 3200, 6400],
    statuses: new Set([429, 502, 503, 504]),
    onConnectionError: true,
    bodyPattern: null,
    bodyPatternStatuses: new Set([400]),
    ...over,
  };
}

const outcome = (o = {}) => ({ status: null, bodyText: null, errorMessage: null, ...o });

// ── 重试判定 ──
test('软错误状态码触发重试', () => {
  const r = retryCfg();
  for (const status of [429, 502, 503, 504]) {
    assert.strictEqual(shouldRetry(r, outcome({ status })).retry, true, `${status} 应重试`);
  }
});

test('硬错误状态码不重试', () => {
  const r = retryCfg();
  for (const status of [400, 401, 403, 404, 422]) {
    assert.strictEqual(shouldRetry(r, outcome({ status })).retry, false, `${status} 不该重试`);
  }
});

test('连接层错误默认重试，关掉后不重试', () => {
  assert.strictEqual(shouldRetry(retryCfg(), outcome({ errorMessage: 'socket hang up' })).retry, true);
  assert.strictEqual(
    shouldRetry(retryCfg({ onConnectionError: false }), outcome({ errorMessage: 'socket hang up' })).retry,
    false,
  );
});

test('bodyPattern 默认关闭，配了才生效', () => {
  const off = retryCfg();
  assert.strictEqual(shouldRetry(off, outcome({ status: 400, bodyText: 'quota not covered' })).retry, false);

  const on = retryCfg({ bodyPattern: /not cover/i });
  assert.strictEqual(shouldRetry(on, outcome({ status: 400, bodyText: 'quota not covered' })).retry, true);
  assert.strictEqual(shouldRetry(on, outcome({ status: 400, bodyText: 'genuinely bad input' })).retry, false);
});

test('bodyPattern 只在声明的状态码上生效', () => {
  const r = retryCfg({ bodyPattern: /transient/i, bodyPatternStatuses: new Set([400]) });
  assert.strictEqual(shouldRetry(r, outcome({ status: 400, bodyText: 'transient' })).retry, true);
  assert.strictEqual(shouldRetry(r, outcome({ status: 418, bodyText: 'transient' })).retry, false);
});

test('重试原因带在结果里，供日志区分', () => {
  assert.strictEqual(shouldRetry(retryCfg(), outcome({ status: 503 })).reason, 'status-503');
  assert.strictEqual(shouldRetry(retryCfg(), outcome({ errorMessage: 'x' })).reason, 'conn-err');
  assert.strictEqual(
    shouldRetry(retryCfg({ bodyPattern: /x/ }), outcome({ status: 400, bodyText: 'x' })).reason,
    'body-pattern',
  );
});

test('退避序列按尝试次数取值，耗尽后取末值', () => {
  const r = retryCfg();
  assert.strictEqual(backoffFor(r, 0), 0, '首次不退避');
  assert.strictEqual(backoffFor(r, 1), 400);
  assert.strictEqual(backoffFor(r, 5), 6400);
  assert.strictEqual(backoffFor(r, 99), 6400, '越界时取最后一个值');
});

test('尝试次数上限', () => {
  const r = retryCfg({ maxRetries: 2 });
  assert.ok(canAttemptAgain(r, 0));
  assert.ok(canAttemptAgain(r, 1));
  assert.ok(!canAttemptAgain(r, 2), '达到上限后停止');
});

test('maxRetries=0 表示不重试', () => {
  assert.ok(!canAttemptAgain(retryCfg({ maxRetries: 0 }), 0));
});

// ── 鉴权组装：安全敏感，重点覆盖 ──
const UPSTREAM = { protocol: 'https', host: 'up.example.com', port: 443, pathPrefix: '' };

function route(auth, over = {}) {
  return { auth: { stripClientAuth: false, ...auth }, upstream: UPSTREAM, key: null, ...over };
}

test('inherit 模式原样转发客户端凭证', () => {
  const h = buildHeaders({
    incoming: { authorization: 'Bearer client-key', 'x-custom': 'v', 'content-type': 'application/json' },
    route: route({ mode: 'client', header: 'inherit' }),
    clientKey: 'client-key',
  });
  assert.strictEqual(h.authorization, 'Bearer client-key');
  assert.strictEqual(h['x-custom'], 'v', 'inherit 模式保留自定义头');
  assert.strictEqual(h.host, 'up.example.com');
});

test('自带凭证时剥掉客户端凭证，不泄给第三方上游', () => {
  const h = buildHeaders({
    incoming: { authorization: 'Bearer CLIENT-SECRET', 'x-api-key': 'CLIENT-SECRET' },
    route: route({ mode: 'secrets', header: 'authorization', stripClientAuth: true }, { key: 'own-key' }),
    clientKey: 'CLIENT-SECRET',
  });
  assert.strictEqual(h.authorization, 'Bearer own-key');
  assert.strictEqual(h['x-api-key'], undefined, 'x-api-key 必须删掉');
  assert.ok(!JSON.stringify(h).includes('CLIENT-SECRET'), '客户端凭证不得出现在发往上游的任何头里');
});

test('x-api-key 模式与 authorization 模式互斥', () => {
  const h1 = buildHeaders({
    incoming: {},
    route: route({ mode: 'secrets', header: 'x-api-key' }, { key: 'k' }),
    clientKey: null,
  });
  assert.strictEqual(h1['x-api-key'], 'k');
  assert.strictEqual(h1.authorization, undefined);

  const h2 = buildHeaders({
    incoming: {},
    route: route({ mode: 'secrets', header: 'authorization' }, { key: 'k' }),
    clientKey: null,
  });
  assert.strictEqual(h2.authorization, 'Bearer k');
  assert.strictEqual(h2['x-api-key'], undefined);
});

test('非 inherit 模式只保留协议必需头，丢掉可能泄漏身份的', () => {
  const h = buildHeaders({
    incoming: {
      'content-type': 'application/json',
      'anthropic-beta': 'context-1m-2025-08-07',
      'anthropic-version': '2023-06-01',
      'x-tracking-id': 'should-be-dropped',
      cookie: 'should-be-dropped',
    },
    route: route({ mode: 'secrets', header: 'authorization' }, { key: 'k' }),
    clientKey: null,
  });
  assert.strictEqual(h['content-type'], 'application/json');
  assert.strictEqual(h['anthropic-beta'], 'context-1m-2025-08-07', '1M 上下文靠这个头，必须保留');
  assert.strictEqual(h['x-tracking-id'], undefined);
  assert.strictEqual(h.cookie, undefined);
});

test('mode=client 用请求里的 key，mode=secrets 用自己的', () => {
  const asClient = buildHeaders({
    incoming: {},
    route: route({ mode: 'client', header: 'authorization' }, { key: 'route-key' }),
    clientKey: 'from-request',
  });
  assert.strictEqual(asClient.authorization, 'Bearer from-request');

  const asSecrets = buildHeaders({
    incoming: {},
    route: route({ mode: 'secrets', header: 'authorization' }, { key: 'route-key' }),
    clientKey: 'from-request',
  });
  assert.strictEqual(asSecrets.authorization, 'Bearer route-key');
});

test('mode=none 不带任何凭证', () => {
  const h = buildHeaders({
    incoming: { authorization: 'Bearer x' },
    route: route({ mode: 'none', header: 'authorization', stripClientAuth: true }),
    clientKey: 'x',
  });
  assert.strictEqual(h.authorization, undefined);
});

test('逐跳头一律不转发', () => {
  const h = buildHeaders({
    incoming: {
      connection: 'keep-alive',
      'transfer-encoding': 'chunked',
      'keep-alive': 'timeout=5',
      'proxy-authorization': 'Basic xxx',
      'content-type': 'application/json',
    },
    route: route({ mode: 'client', header: 'inherit' }),
    clientKey: null,
  });
  for (const k of ['connection', 'transfer-encoding', 'keep-alive', 'proxy-authorization']) {
    assert.strictEqual(h[k], undefined, `${k} 不该转发`);
  }
});

test('content-length 按实际 body 长度设置', () => {
  const h = buildHeaders({
    incoming: { 'content-length': '999' },
    route: route({ mode: 'client', header: 'inherit' }),
    clientKey: null,
    contentLength: 42,
  });
  assert.strictEqual(h['content-length'], '42');

  const noBody = buildHeaders({
    incoming: { 'content-length': '999' },
    route: route({ mode: 'client', header: 'inherit' }),
    clientKey: null,
  });
  assert.strictEqual(noBody['content-length'], undefined);
});

// ── 路径与协议 ──
test('pathPrefix 拼接', () => {
  assert.strictEqual(joinPath({ pathPrefix: '/anthropic' }, '/v1/messages'), '/anthropic/v1/messages');
  assert.strictEqual(joinPath({ pathPrefix: '' }, '/v1/messages'), '/v1/messages');
  assert.strictEqual(joinPath({}, '/v1/messages'), '/v1/messages');
});

test('protocol 决定用 http 还是 https 模块', () => {
  assert.strictEqual(moduleFor('http'), require('node:http'));
  assert.strictEqual(moduleFor('https'), require('node:https'));
  assert.strictEqual(moduleFor(undefined), require('node:https'), '默认 https');
});

test('extractClientKey 认两种放法', () => {
  assert.strictEqual(extractClientKey({ 'x-api-key': 'k1' }), 'k1');
  assert.strictEqual(extractClientKey({ authorization: 'Bearer k2' }), 'k2');
  assert.strictEqual(extractClientKey({ authorization: 'bearer k3' }), 'k3', '大小写不敏感');
  assert.strictEqual(extractClientKey({}), null);
});

test('describe 给出可读的上游标识', () => {
  assert.strictEqual(describeUpstream({ host: 'a.com', pathPrefix: '/x' }), 'a.com/x');
  assert.strictEqual(describeUpstream({ host: 'a.com' }), 'a.com');
});

// ── 错误信封 ──
test('状态码映射到 Anthropic 错误类型', () => {
  assert.strictEqual(typeForStatus(400), TYPES.invalidRequest);
  assert.strictEqual(typeForStatus(401), TYPES.authentication);
  assert.strictEqual(typeForStatus(403), TYPES.permission);
  assert.strictEqual(typeForStatus(404), TYPES.notFound);
  assert.strictEqual(typeForStatus(429), TYPES.rateLimit);
  assert.strictEqual(typeForStatus(529), TYPES.overloaded);
  assert.strictEqual(typeForStatus(500), TYPES.api);
  assert.strictEqual(typeForStatus(502), TYPES.api);
});

test('错误信封结构符合 Anthropic 格式', () => {
  const e = envelope(TYPES.api, 'boom');
  assert.deepStrictEqual(e, { type: 'error', error: { type: 'api_error', message: 'boom' } });
});

test('从上游错误体里挖消息', () => {
  assert.strictEqual(extractUpstreamMessage('{"error":{"message":"quota exceeded"}}'), 'quota exceeded');
  assert.strictEqual(extractUpstreamMessage('{"message":"top level"}'), 'top level');
  assert.strictEqual(extractUpstreamMessage('plain text error'), 'plain text error');
  assert.strictEqual(extractUpstreamMessage(''), '');
  assert.strictEqual(extractUpstreamMessage(null), '');
});

test('超长上游错误体被截断', () => {
  const long = 'x'.repeat(5000);
  assert.ok(extractUpstreamMessage(long).length <= 2000);
});
