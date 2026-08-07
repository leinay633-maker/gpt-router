'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { validate, matchesGlob, suggest } = require('../src/config/validate');

/** 最小的合法配置，各用例在它之上做局部改动。 */
function base(overrides = {}) {
  return {
    version: 1,
    upstreams: {
      anthropic: { protocol: 'https', host: 'api.anthropic.com', port: 443 },
    },
    routes: [
      {
        name: 'anthropic-default',
        default: true,
        adapter: 'passthrough',
        upstream: 'anthropic',
        auth: { mode: 'client', header: 'inherit' },
      },
    ],
    ...overrides,
  };
}

const ptrs = (r) => r.errors.map((e) => e.pointer);
const msgs = (r) => r.errors.map((e) => `${e.pointer} ${e.message} ${e.fix || ''}`).join('\n');
const hasErrorAt = (r, pointer) => r.errors.some((e) => e.pointer === pointer);
const hasWarnAt = (r, pointer) => r.warnings.some((w) => w.pointer === pointer);

test('最小合法配置无错误无警告', () => {
  const r = validate(base());
  assert.deepStrictEqual(r.errors, [], msgs(r));
  assert.deepStrictEqual(r.warnings, []);
});

test('根不是对象时立即返回', () => {
  for (const bad of [null, [], 'x', 42]) {
    const r = validate(bad);
    assert.ok(r.errors.length >= 1, `${JSON.stringify(bad)} 应报错`);
  }
});

// ── V1 版本 ──
test('V1 缺 version 报错', () => {
  const cfg = base();
  delete cfg.version;
  assert.ok(hasErrorAt(validate(cfg), '/version'));
});

test('V1 版本号不符报错', () => {
  assert.ok(hasErrorAt(validate(base({ version: 2 })), '/version'));
});

// ── V2 未知字段 ──
test('V2 未知根字段报错并给出相近建议', () => {
  const r = validate(base({ upstream: {} })); // 少了 s
  assert.ok(hasErrorAt(r, '/upstream'));
  assert.match(msgs(r), /upstreams/);
});

test('V2 路由里拼错 allowModels 会被抓到并建议正确写法', () => {
  const cfg = base();
  cfg.routes[0].allowedModels = ['a']; // 常见拼错
  const r = validate(cfg);
  assert.ok(hasErrorAt(r, '/routes/0/allowedModels'));
  assert.match(msgs(r), /allowModels/);
});

test('suggest 距离过大时不瞎猜', () => {
  assert.strictEqual(suggest('zzzzzzzzzz', new Set(['host', 'port'])), null);
});

// ── V16 凭证扫描 ──
// 运行时拼出来，别让源码里出现能被 scripts/scan-secrets.js 命中的字面量
// ——那个扫描器保护的正是这个仓库，它对自己的测试用例报警是对的。
const FAKE_KEY = ['sk', 'abcdefghijklmnopqrstuvwx'].join('-');

test('V16 config 里出现 sk- 开头的值报错', () => {
  const cfg = base();
  cfg.routes[0].auth = { mode: 'secrets', secretKey: FAKE_KEY, header: 'authorization' };
  const r = validate(cfg);
  assert.ok(r.errors.some((e) => /凭证/.test(e.message)), msgs(r));
});

test('V16 敏感键名下放字符串报错', () => {
  const cfg = base();
  cfg.upstreams.anthropic.apiKey = 'whatever';
  const r = validate(cfg);
  // 既触发未知字段，也触发敏感键名
  assert.ok(r.errors.some((e) => /凭证/.test(e.message)), msgs(r));
});

test('V16 requireToken 这类布尔开关不误报', () => {
  const r = validate(base({ listen: { requireToken: false } }));
  assert.ok(!r.errors.some((e) => /凭证/.test(e.message)), msgs(r));
});

// ── V3 / V4 路由与兜底 ──
test('V3 routes 缺失或为空报错', () => {
  const cfg1 = base(); delete cfg1.routes;
  assert.ok(hasErrorAt(validate(cfg1), '/routes'));
  assert.ok(hasErrorAt(validate(base({ routes: [] })), '/routes'));
});

test('V4 没有兜底路由报错', () => {
  const cfg = base();
  delete cfg.routes[0].default;
  cfg.routes[0].match = { model: ['claude*'] };
  const r = validate(cfg);
  assert.ok(hasErrorAt(r, '/routes'));
  assert.match(msgs(r), /没有兜底路由/);
});

test('V4 两条兜底路由报错并列出位置', () => {
  const cfg = base();
  cfg.routes.push({
    name: 'second', default: true, adapter: 'passthrough', upstream: 'anthropic',
    auth: { mode: 'client', header: 'inherit' },
  });
  const r = validate(cfg);
  assert.match(msgs(r), /2 条兜底路由/);
});

test('V5 路由名重复报错', () => {
  const cfg = base();
  cfg.routes.push({
    name: 'anthropic-default', adapter: 'passthrough', upstream: 'anthropic',
    match: { model: ['x*'] }, auth: { mode: 'client', header: 'inherit' },
  });
  assert.ok(hasErrorAt(validate(cfg), '/routes/1/name'));
});

test('V5 路由名格式受限', () => {
  const cfg = base();
  cfg.routes[0].name = 'Bad_Name';
  assert.ok(hasErrorAt(validate(cfg), '/routes/0/name'));
});

// ── V6 / V7 匹配条件 ──
test('V6 兜底路由带 match 报错', () => {
  const cfg = base();
  cfg.routes[0].match = { model: ['x*'] };
  assert.ok(hasErrorAt(validate(cfg), '/routes/0/match'));
});

test('V6 非兜底路由缺匹配条件报错', () => {
  const cfg = base();
  cfg.routes.push({ name: 'x', adapter: 'passthrough', upstream: 'anthropic', auth: { mode: 'client', header: 'inherit' } });
  assert.ok(hasErrorAt(validate(cfg), '/routes/1'));
});

test('V6 match 与 matchRegex 互斥', () => {
  const cfg = base();
  cfg.routes.push({
    name: 'x', adapter: 'passthrough', upstream: 'anthropic',
    match: { model: ['a*'] }, matchRegex: '^a',
    auth: { mode: 'client', header: 'inherit' },
  });
  assert.ok(hasErrorAt(validate(cfg), '/routes/1/matchRegex'));
});

test('V7 matchRegex 编译失败报错', () => {
  const cfg = base();
  cfg.routes.push({
    name: 'x', adapter: 'passthrough', upstream: 'anthropic',
    matchRegex: '([unclosed', auth: { mode: 'client', header: 'inherit' },
  });
  assert.ok(hasErrorAt(validate(cfg), '/routes/1/matchRegex'));
});

// ── V9 / V10 上游 ──
test('V9 引用不存在的上游报错并给建议', () => {
  const cfg = base();
  cfg.routes[0].upstream = 'anthropi'; // 少一个字母
  const r = validate(cfg);
  assert.ok(hasErrorAt(r, '/routes/0/upstream'));
  assert.match(msgs(r), /anthropic/);
});

test('V10 host 带协议前缀报错并给出裸主机名', () => {
  const cfg = base();
  cfg.upstreams.anthropic.host = 'https://api.anthropic.com';
  const r = validate(cfg);
  assert.ok(hasErrorAt(r, '/upstreams/anthropic/host'));
  assert.match(msgs(r), /改成 "api\.anthropic\.com"/);
});

test('V10 pathPrefix 必须以 / 开头且不以 / 结尾', () => {
  const cfg1 = base();
  cfg1.upstreams.anthropic.pathPrefix = 'anthropic';
  assert.ok(hasErrorAt(validate(cfg1), '/upstreams/anthropic/pathPrefix'));

  const cfg2 = base();
  cfg2.upstreams.anthropic.pathPrefix = '/anthropic/';
  assert.ok(hasErrorAt(validate(cfg2), '/upstreams/anthropic/pathPrefix'));
});

test('V11 没被引用的上游只是 warn', () => {
  const cfg = base();
  cfg.upstreams.unused = { host: 'example.com' };
  const r = validate(cfg);
  assert.deepStrictEqual(r.errors, [], msgs(r));
  assert.ok(hasWarnAt(r, '/upstreams/unused'));
});

// ── V12–V15 鉴权 ──
test('V12 auth 缺失报错', () => {
  const cfg = base();
  delete cfg.routes[0].auth;
  assert.ok(hasErrorAt(validate(cfg), '/routes/0/auth'));
});

test('V12 auth.mode 缺失报错且不给默认值', () => {
  const cfg = base();
  cfg.routes[0].auth = { header: 'inherit' };
  assert.ok(hasErrorAt(validate(cfg), '/routes/0/auth/mode'));
});

test('V13 mode=secrets 缺 secretKey 报错', () => {
  const cfg = base();
  cfg.routes[0].auth = { mode: 'secrets', header: 'authorization' };
  const r = validate(cfg);
  assert.ok(hasErrorAt(r, '/routes/0/auth/secretKey'));
});

test('V13 mode=env 缺 envVar 报错', () => {
  const cfg = base();
  cfg.routes[0].auth = { mode: 'env', header: 'authorization' };
  assert.ok(hasErrorAt(validate(cfg), '/routes/0/auth/envVar'));
});

test('V13 mode=client 却给了 secretKey 报错', () => {
  const cfg = base();
  cfg.routes[0].auth = { mode: 'client', header: 'inherit', secretKey: 'X' };
  assert.ok(hasErrorAt(validate(cfg), '/routes/0/auth/secretKey'));
});

test('V14 自带凭证配 header=inherit 报错', () => {
  const cfg = base();
  cfg.routes[0].auth = { mode: 'env', envVar: 'MY_KEY', header: 'inherit' };
  assert.ok(hasErrorAt(validate(cfg), '/routes/0/auth/header'));
});

test('V15 关闭 stripClientAuth 需要显式确认字段', () => {
  const cfg = base();
  cfg.routes[0].auth = { mode: 'env', envVar: 'MY_KEY', header: 'authorization', stripClientAuth: false };
  const r = validate(cfg);
  assert.ok(hasErrorAt(r, '/routes/0/auth/stripClientAuth'), msgs(r));

  cfg.routes[0].auth.iKnowThisLeaksMyClientKey = true;
  assert.deepStrictEqual(validate(cfg).errors, []);
});

// ── V17 / V18 监听 ──
test('V17 非回环地址需要同时解锁与开令牌', () => {
  const r1 = validate(base({ listen: { host: '0.0.0.0' } }));
  assert.ok(hasErrorAt(r1, '/listen/host'));

  // 只解锁不开令牌，仍然报错
  const r2 = validate(base({ listen: { host: '0.0.0.0', allowNonLoopback: true } }));
  assert.ok(hasErrorAt(r2, '/listen/allowNonLoopback'), msgs(r2));

  // 两者齐备才放行
  const r3 = validate(base({ listen: { host: '0.0.0.0', allowNonLoopback: true, requireToken: true } }));
  assert.deepStrictEqual(r3.errors, [], msgs(r3));
});

test('V18 端口范围受限', () => {
  assert.ok(hasErrorAt(validate(base({ listen: { port: 80 } })), '/listen/port'));
  assert.ok(hasErrorAt(validate(base({ listen: { port: 70000 } })), '/listen/port'));
  assert.deepStrictEqual(validate(base({ listen: { port: 8402 } })).errors, []);
});

// ── V21 / V22 重试 ──
test('V21 backoffMs 长度不足报错', () => {
  const cfg = base();
  cfg.routes[0].retry = { maxRetries: 5, backoffMs: [0, 400] };
  const r = validate(cfg);
  assert.ok(hasErrorAt(r, '/routes/0/retry/backoffMs'));
  assert.match(msgs(r), /至少 6 个元素/);
});

test('V21 statuses 必须是 4xx/5xx', () => {
  const cfg = base();
  cfg.routes[0].retry = { statuses: [200, 502] };
  assert.ok(hasErrorAt(validate(cfg), '/routes/0/retry/statuses'));
});

test('V22 bodyPattern 编译失败报错', () => {
  const cfg = base();
  cfg.routes[0].retry = { bodyPattern: '([bad' };
  assert.ok(hasErrorAt(validate(cfg), '/routes/0/retry/bodyPattern'));
});

test('V22 bodyPattern 合法时给出上游特定补丁的提醒', () => {
  const cfg = base();
  cfg.routes[0].retry = { bodyPattern: 'not cover', bodyPatternStatuses: [400] };
  const r = validate(cfg);
  assert.deepStrictEqual(r.errors, [], msgs(r));
  assert.ok(hasWarnAt(r, '/routes/0/retry'));
});

test('V22 bodyPattern 缺配套状态码报错', () => {
  const cfg = base();
  cfg.routes[0].retry = { bodyPattern: 'x', bodyPatternStatuses: [] };
  assert.ok(hasErrorAt(validate(cfg), '/routes/0/retry/bodyPatternStatuses'));
});

// ── V23 / V24 适配器专属字段 ──
test('V23 passthrough 路由带 responses 专属字段报错', () => {
  const cfg = base();
  cfg.routes[0].modelMap = { a: { model: 'b' } };
  cfg.routes[0].requestPath = '/v1/responses';
  const r = validate(cfg);
  assert.ok(hasErrorAt(r, '/routes/0/modelMap'));
  assert.ok(hasErrorAt(r, '/routes/0/requestPath'));
});

test('V24 responses 路由带 bodyOverrides 报错', () => {
  const cfg = base();
  cfg.upstreams.openai = { host: 'api.openai.com' };
  cfg.routes.push({
    name: 'gpt', match: { model: ['gpt*'] }, adapter: 'responses', upstream: 'openai',
    auth: { mode: 'client', header: 'authorization' },
    bodyOverrides: { foo: 1 },
  });
  const r = validate(cfg);
  assert.ok(hasErrorAt(r, '/routes/1/bodyOverrides'), msgs(r));
});

// ── V25 / V26 ──
test('V25 countTokens 取值受限', () => {
  const cfg = base();
  cfg.routes[0].countTokens = 'guess';
  assert.ok(hasErrorAt(validate(cfg), '/routes/0/countTokens'));
});

test('V26 modelMap 的键不在 allowModels 里报错', () => {
  const cfg = base();
  cfg.upstreams.openai = { host: 'api.openai.com' };
  cfg.routes.push({
    name: 'gpt', match: { model: ['gpt*'] }, adapter: 'responses', upstream: 'openai',
    auth: { mode: 'client', header: 'authorization' },
    allowModels: ['gpt-a'],
    modelMap: { 'gpt-b': { model: 'gpt-b' } },
  });
  const r = validate(cfg);
  assert.ok(hasErrorAt(r, '/routes/1/modelMap/gpt-b'), msgs(r));
});

test('V26 modelMap 的键不满足 match 只是 warn', () => {
  const cfg = base();
  cfg.upstreams.openai = { host: 'api.openai.com' };
  cfg.routes.push({
    name: 'gpt', match: { model: ['gpt*'] }, adapter: 'responses', upstream: 'openai',
    auth: { mode: 'client', header: 'authorization' },
    modelMap: { 'claude-x': { model: 'claude-x' } },
  });
  const r = validate(cfg);
  assert.deepStrictEqual(r.errors, [], msgs(r));
  assert.ok(hasWarnAt(r, '/routes/1/modelMap/claude-x'));
});

// ── 日志 ──
test('logBodies 开启时给出隐私提醒', () => {
  const r = validate(base({ log: { logBodies: true } }));
  assert.deepStrictEqual(r.errors, []);
  assert.ok(hasWarnAt(r, '/log/logBodies'));
});

// ── 一次性收集多个错误，而不是撞到第一个就停 ──
test('多个错误一次性全部收集', () => {
  const cfg = {
    version: 1,
    upstreams: { u: { host: 'https://x.com/path' } },
    routes: [
      { name: 'Bad_Name', adapter: 'nope', upstream: 'missing' },
    ],
  };
  const r = validate(cfg);
  assert.ok(r.errors.length >= 5, `应一次报出多个问题，实际 ${r.errors.length}:\n${msgs(r)}`);
  // 覆盖不同层级
  assert.ok(ptrs(r).some((p) => p.startsWith('/upstreams')));
  assert.ok(ptrs(r).some((p) => p.startsWith('/routes/0')));
});

// ── 辅助函数 ──
test('matchesGlob 前缀匹配', () => {
  assert.ok(matchesGlob('gpt-5.6', 'gpt*'));
  assert.ok(matchesGlob('gpt', 'gpt*'));
  assert.ok(!matchesGlob('claude-5', 'gpt*'));
  assert.ok(matchesGlob('exact', 'exact'));
  assert.ok(!matchesGlob('exactly', 'exact'));
});
