'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadConfig, ConfigError, routeAccepts } = require('../src/config/load');
const { loadSecrets, resolveAuthKey, SecretsError, expandHome } = require('../src/config/secrets');

/** 每个用例用独立临时目录，避免互相污染。 */
function tmpdir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-router-test-'));
  return dir;
}

function writeJson(dir, name, obj) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
  return p;
}

const MINIMAL = {
  version: 1,
  upstreams: { anthropic: { host: 'api.anthropic.com' } },
  routes: [{
    name: 'anthropic-default',
    default: true,
    adapter: 'passthrough',
    upstream: 'anthropic',
    auth: { mode: 'client', header: 'inherit' },
  }],
};

test('仓库自带的 config.example.json 能通过校验', () => {
  const cfg = loadConfig({ configPath: path.join(__dirname, '..', 'config.example.json'), env: {} });
  assert.strictEqual(cfg.listen.port, 8402);
  assert.ok(cfg.defaultRoute);
  assert.strictEqual(cfg.defaultRoute.name, 'anthropic-default');
});

test('配置文件不存在时给出可操作的提示', () => {
  const dir = tmpdir();
  assert.throws(
    () => loadConfig({ configPath: path.join(dir, 'nope.json'), env: {} }),
    (e) => e instanceof ConfigError && e.exitCode === 78 && /install/.test(e.report),
  );
});

test('JSON 语法错误时提示常见原因', () => {
  const dir = tmpdir();
  const p = writeJson(dir, 'config.json', '{ "version": 1, }'); // 尾逗号
  assert.throws(
    () => loadConfig({ configPath: p, env: {} }),
    (e) => e instanceof ConfigError && /注释|逗号/.test(e.report),
  );
});

test('protocol 决定 port 默认值', () => {
  const dir = tmpdir();
  const cfg = structuredClone(MINIMAL);
  cfg.upstreams.plain = { protocol: 'http', host: 'localhost' };
  cfg.routes.push({
    name: 'plain', match: { model: ['local*'] }, adapter: 'passthrough',
    upstream: 'plain', auth: { mode: 'none' },
  });
  const p = writeJson(dir, 'config.json', cfg);
  const loaded = loadConfig({ configPath: p, env: {} });
  assert.strictEqual(loaded.upstreams.anthropic.port, 443, 'https 默认 443');
  assert.strictEqual(loaded.upstreams.plain.port, 80, 'http 默认 80');
});

test('countTokens 按适配器给不同默认值', () => {
  const dir = tmpdir();
  const cfg = structuredClone(MINIMAL);
  cfg.upstreams.openai = { host: 'api.openai.com' };
  cfg.routes.push({
    name: 'gpt', match: { model: ['gpt*'] }, adapter: 'responses',
    upstream: 'openai', auth: { mode: 'client', header: 'authorization' },
  });
  const loaded = loadConfig({ configPath: writeJson(dir, 'config.json', cfg), env: {} });
  const passthrough = loaded.routes.find((r) => r.name === 'anthropic-default');
  const responses = loaded.routes.find((r) => r.name === 'gpt');
  assert.strictEqual(passthrough.countTokens, 'forward', 'Messages 线有这个端点');
  assert.strictEqual(responses.countTokens, 'estimate', 'Responses 线没有，只能本地估算');
});

test('选路按数组顺序，首个命中生效，未匹配落兜底', () => {
  const dir = tmpdir();
  const cfg = structuredClone(MINIMAL);
  cfg.upstreams.a = { host: 'a.example.com' };
  cfg.routes.unshift({
    name: 'first', match: { model: ['x-*'] }, adapter: 'passthrough',
    upstream: 'a', auth: { mode: 'none' },
  });
  cfg.routes.splice(1, 0, {
    name: 'second', match: { model: ['x-*'] }, adapter: 'passthrough',
    upstream: 'a', auth: { mode: 'none' },
  });
  const loaded = loadConfig({ configPath: writeJson(dir, 'config.json', cfg), env: {} });
  assert.strictEqual(loaded.pickRoute('x-1').name, 'first', '同样匹配时取靠前的');
  assert.strictEqual(loaded.pickRoute('whatever').name, 'anthropic-default');
});

test('matchRegex 生效', () => {
  const dir = tmpdir();
  const cfg = structuredClone(MINIMAL);
  cfg.upstreams.a = { host: 'a.example.com' };
  cfg.routes.unshift({
    name: 'regex', matchRegex: '^m(1|2)$', adapter: 'passthrough',
    upstream: 'a', auth: { mode: 'none' },
  });
  const loaded = loadConfig({ configPath: writeJson(dir, 'config.json', cfg), env: {} });
  assert.strictEqual(loaded.pickRoute('m1').name, 'regex');
  assert.strictEqual(loaded.pickRoute('m3').name, 'anthropic-default');
});

test('凭证取不到时标记 degraded 但不阻止启动', () => {
  const dir = tmpdir();
  const cfg = structuredClone(MINIMAL);
  cfg.secretsFile = path.join(dir, 'secrets.json');
  cfg.upstreams.ds = { host: 'api.deepseek.com', pathPrefix: '/anthropic' };
  cfg.routes.unshift({
    name: 'ds', match: { model: ['deepseek*'] }, adapter: 'passthrough',
    upstream: 'ds', auth: { mode: 'secrets', secretKey: 'DEEPSEEK_KEY', header: 'authorization' },
  });
  const loaded = loadConfig({ configPath: writeJson(dir, 'config.json', cfg), env: {} });
  const ds = loaded.routes.find((r) => r.name === 'ds');
  assert.strictEqual(ds.degraded, true);
  assert.match(ds.degradedReason, /DEEPSEEK_KEY/);
  assert.ok(loaded.warnings.some((w) => /ds/.test(w)));
  // 兜底路由不受影响
  assert.strictEqual(loaded.pickRoute('claude-x').degraded, false);
});

test('required:true 的路由凭证缺失则启动失败', () => {
  const dir = tmpdir();
  const cfg = structuredClone(MINIMAL);
  cfg.secretsFile = path.join(dir, 'secrets.json');
  cfg.upstreams.ds = { host: 'api.deepseek.com' };
  cfg.routes.unshift({
    name: 'ds', match: { model: ['deepseek*'] }, adapter: 'passthrough',
    upstream: 'ds', required: true,
    auth: { mode: 'secrets', secretKey: 'DEEPSEEK_KEY', header: 'authorization' },
  });
  assert.throws(
    () => loadConfig({ configPath: writeJson(dir, 'config.json', cfg), env: {} }),
    (e) => e instanceof ConfigError && /required/.test(e.report),
  );
});

test('env 模式从环境变量取凭证', () => {
  const dir = tmpdir();
  const cfg = structuredClone(MINIMAL);
  cfg.upstreams.a = { host: 'a.example.com' };
  cfg.routes.unshift({
    name: 'e', match: { model: ['e*'] }, adapter: 'passthrough',
    upstream: 'a', auth: { mode: 'env', envVar: 'MY_UPSTREAM_KEY', header: 'authorization' },
  });
  const p = writeJson(dir, 'config.json', cfg);

  const withKey = loadConfig({ configPath: p, env: { MY_UPSTREAM_KEY: 'secret-value' } });
  const r1 = withKey.routes.find((r) => r.name === 'e');
  assert.strictEqual(r1.key, 'secret-value');
  assert.strictEqual(r1.degraded, false);

  const without = loadConfig({ configPath: p, env: {} });
  assert.strictEqual(without.routes.find((r) => r.name === 'e').degraded, true);
});

test('env/secrets 模式默认剥离客户端凭证，client 模式不剥', () => {
  const dir = tmpdir();
  const cfg = structuredClone(MINIMAL);
  cfg.upstreams.a = { host: 'a.example.com' };
  cfg.routes.unshift({
    name: 'e', match: { model: ['e*'] }, adapter: 'passthrough',
    upstream: 'a', auth: { mode: 'env', envVar: 'K', header: 'authorization' },
  });
  const loaded = loadConfig({ configPath: writeJson(dir, 'config.json', cfg), env: { K: 'v' } });
  assert.strictEqual(loaded.routes.find((r) => r.name === 'e').auth.stripClientAuth, true);
  assert.strictEqual(loaded.defaultRoute.auth.stripClientAuth, false);
});

// ── secrets.js ──
test('secrets 文件不存在不算错误', () => {
  const dir = tmpdir();
  const r = loadSecrets(path.join(dir, 'nope.json'));
  assert.strictEqual(r.exists, false);
  assert.deepStrictEqual(r.values, {});
});

test('secrets JSON 语法错误必须硬报错，不静默降级', () => {
  const dir = tmpdir();
  const p = writeJson(dir, 'secrets.json', '{ oops');
  assert.throws(() => loadSecrets(p), (e) => e instanceof SecretsError && /合法 JSON/.test(e.message));
});

test('secrets 非字符串值报错', () => {
  const dir = tmpdir();
  const p = writeJson(dir, 'secrets.json', { KEY: 12345 });
  assert.throws(() => loadSecrets(p), SecretsError);
});

test('secrets 空字符串跳过并警告', () => {
  const dir = tmpdir();
  const p = writeJson(dir, 'secrets.json', { EMPTY: '', GOOD: 'v' });
  const r = loadSecrets(p);
  assert.strictEqual(r.values.EMPTY, undefined);
  assert.strictEqual(r.values.GOOD, 'v');
  assert.ok(r.warnings.some((w) => /EMPTY/.test(w)));
});

test('resolveAuthKey 覆盖四种模式', () => {
  const secrets = { S: 'sv' };
  const env = { E: 'ev' };
  assert.strictEqual(resolveAuthKey({ mode: 'client' }, secrets, env).key, null);
  assert.strictEqual(resolveAuthKey({ mode: 'none' }, secrets, env).key, null);
  assert.strictEqual(resolveAuthKey({ mode: 'env', envVar: 'E' }, secrets, env).key, 'ev');
  assert.strictEqual(resolveAuthKey({ mode: 'secrets', secretKey: 'S' }, secrets, env).key, 'sv');
  assert.match(resolveAuthKey({ mode: 'env', envVar: 'MISSING' }, secrets, env).missing, /MISSING/);
});

test('expandHome 展开 ~ 前缀', () => {
  assert.strictEqual(expandHome('~'), os.homedir());
  assert.strictEqual(expandHome('~/x'), path.join(os.homedir(), 'x'));
  assert.strictEqual(expandHome('/abs/path'), '/abs/path');
});

test('routeAccepts 兜底路由接受一切', () => {
  assert.ok(routeAccepts({ isDefault: true }, 'anything'));
  assert.ok(!routeAccepts({ isDefault: false, matchPatterns: ['gpt*'] }, 'claude'));
  assert.ok(routeAccepts({ isDefault: false, matchPatterns: ['gpt*'] }, 'gpt-5'));
});
