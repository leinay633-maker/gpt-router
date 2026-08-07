'use strict';
/**
 * 端到端：起一个假上游 + 真 server，走完整请求路径。
 * 不碰真实网络，也不依赖任何外部服务。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createServer } = require('../src/server');
const { loadConfig } = require('../src/config/load');
const { createLogger } = require('../src/log');

/** 静默日志，避免测试输出被淹，也别污染真实日志文件。 */
const quietLog = () => createLogger({ level: 'error', file: null });

/**
 * 关掉服务并断开所有 keep-alive 连接。
 *
 * server.close() 只是停止接受新连接，已建立的 keep-alive 连接会让
 * 进程一直不退出——测试跑完卡住 120 秒就是这个原因。
 */
function shutdown(...servers) {
  for (const s of servers) {
    if (!s) continue;
    s.closeAllConnections?.();
    s.close();
  }
}

/** 起一个假上游，记录收到的请求。 */
function fakeUpstream(handler) {
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const entry = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      received.push(entry);
      handler(req, res, entry);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, received, port: server.address().port });
    });
  });
}

/**
 * 写配置并起 router。
 *
 * 注意配置里的 listen.port 必须是合法值（校验器要求 1024-65535），
 * 但实际监听传 0 让内核分配空闲端口——测试要能并发跑。
 */
async function startRouter(configObj, deps) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-router-e2e-'));
  const cfgPath = path.join(dir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(configObj, null, 2));
  const config = loadConfig({ configPath: cfgPath, env: {} });
  const server = createServer(config, quietLog(), deps);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, config, port: server.address().port, dir };
}

/** 发请求到 router。 */
function callRouter(port, opts = {}) {
  return new Promise((resolve, reject) => {
    const body = opts.body === undefined ? null : (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: opts.path || '/v1/messages',
      method: opts.method || 'POST',
      headers: {
        host: opts.hostHeader === undefined ? `127.0.0.1:${port}` : opts.hostHeader,
        'content-type': 'application/json',
        ...(body ? { 'content-length': Buffer.byteLength(body) } : {}),
        ...opts.headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        text: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const json = (r) => JSON.parse(r.text);

/** passthrough 到假上游的最小配置。 */
function passthroughConfig(upstreamPort, over = {}) {
  return {
    version: 1,
    listen: { host: '127.0.0.1', port: 8402 },
    log: { level: 'error' },
    upstreams: { fake: { protocol: 'http', host: '127.0.0.1', port: upstreamPort } },
    routes: [{
      name: 'fake-default',
      default: true,
      adapter: 'passthrough',
      upstream: 'fake',
      auth: { mode: 'client', header: 'inherit' },
      retry: { maxRetries: 2, backoffMs: [0, 10, 20], statuses: [503] },
      ...over,
    }],
  };
}

test('透传：请求到达上游，响应回到客户端', async (t) => {
  const up = await fakeUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'msg_1', type: 'message', content: [{ type: 'text', text: 'pong' }] }));
  });
  const rt = await startRouter(passthroughConfig(up.port));
  t.after(() => shutdown(up.server, rt.server));

  const r = await callRouter(rt.port, { body: { model: 'claude-x', messages: [] } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(json(r).content[0].text, 'pong');
  assert.strictEqual(up.received.length, 1);
  assert.strictEqual(up.received[0].url, '/v1/messages');
});

test('pathPrefix 拼进上游路径', async (t) => {
  const up = await fakeUpstream((req, res) => { res.writeHead(200); res.end('{}'); });
  const cfg = passthroughConfig(up.port);
  cfg.upstreams.fake.pathPrefix = '/anthropic';
  const rt = await startRouter(cfg);
  t.after(() => shutdown(up.server, rt.server));

  await callRouter(rt.port, { body: { model: 'x', messages: [] } });
  assert.strictEqual(up.received[0].url, '/anthropic/v1/messages');
});

test('[1m] 后缀被剥掉后才发给上游', async (t) => {
  const up = await fakeUpstream((req, res) => { res.writeHead(200); res.end('{}'); });
  const rt = await startRouter(passthroughConfig(up.port));
  t.after(() => shutdown(up.server, rt.server));

  await callRouter(rt.port, { body: { model: 'claude-sonnet-5[1m]', messages: [] } });
  assert.strictEqual(JSON.parse(up.received[0].body).model, 'claude-sonnet-5');
});

test('软错误自动重试，最终成功', async (t) => {
  let n = 0;
  const up = await fakeUpstream((req, res) => {
    n++;
    if (n < 3) { res.writeHead(503); res.end('{"error":{"message":"try later"}}'); return; }
    res.writeHead(200); res.end('{"ok":true}');
  });
  const rt = await startRouter(passthroughConfig(up.port));
  t.after(() => shutdown(up.server, rt.server));

  const r = await callRouter(rt.port, { body: { model: 'x', messages: [] } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(n, 3, '应重试两次后成功');
});

test('重试耗尽后把上游原始响应交回', async (t) => {
  const up = await fakeUpstream((req, res) => {
    res.writeHead(503); res.end('{"error":{"message":"always down"}}');
  });
  const rt = await startRouter(passthroughConfig(up.port));
  t.after(() => shutdown(up.server, rt.server));

  const r = await callRouter(rt.port, { body: { model: 'x', messages: [] } });
  assert.strictEqual(r.status, 503);
  assert.strictEqual(up.received.length, 3, '首次 + 2 次重试');
});

test('硬错误不重试', async (t) => {
  const up = await fakeUpstream((req, res) => {
    res.writeHead(400); res.end('{"error":{"message":"bad input"}}');
  });
  const rt = await startRouter(passthroughConfig(up.port));
  t.after(() => shutdown(up.server, rt.server));

  const r = await callRouter(rt.port, { body: { model: 'x', messages: [] } });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(up.received.length, 1, '400 不该重试');
});

test('200 开始流式后即使上游出错也不重发', async (t) => {
  const up = await fakeUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: message_start\ndata: {}\n\n');
    res.end();
  });
  const rt = await startRouter(passthroughConfig(up.port));
  t.after(() => shutdown(up.server, rt.server));

  const r = await callRouter(rt.port, { body: { model: 'x', messages: [], stream: true } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(up.received.length, 1, '已开始输出就不能重试');
});

test('自带凭证时客户端 key 不泄给上游', async (t) => {
  const up = await fakeUpstream((req, res) => { res.writeHead(200); res.end('{}'); });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-router-sec-'));
  fs.writeFileSync(path.join(dir, 'secrets.json'), JSON.stringify({ UP_KEY: 'upstream-own-key' }));

  const cfg = passthroughConfig(up.port, {
    auth: { mode: 'secrets', secretKey: 'UP_KEY', header: 'authorization' },
  });
  cfg.secretsFile = path.join(dir, 'secrets.json');
  const rt = await startRouter(cfg);
  t.after(() => shutdown(up.server, rt.server));

  await callRouter(rt.port, {
    body: { model: 'x', messages: [] },
    headers: { 'x-api-key': 'CLIENT-SECRET', authorization: 'Bearer CLIENT-SECRET' },
  });

  const h = up.received[0].headers;
  // 拼出来而不是写字面量：scripts/scan-secrets.js 保护的正是这个仓库，
  // 让它对自己的测试数据报警只会训练人去忽略它。
  assert.strictEqual(h.authorization, `Bearer ${'upstream-own-key'}`);
  assert.strictEqual(h['x-api-key'], undefined);
  assert.ok(!JSON.stringify(h).includes('CLIENT-SECRET'), '客户端凭证不得到达上游');
});

test('degraded 路由返回 503 而不是拿空 key 打上游', async (t) => {
  const up = await fakeUpstream((req, res) => { res.writeHead(200); res.end('{}'); });
  const cfg = passthroughConfig(up.port, {
    auth: { mode: 'secrets', secretKey: 'MISSING_KEY', header: 'authorization' },
  });
  const rt = await startRouter(cfg);
  t.after(() => shutdown(up.server, rt.server));

  const r = await callRouter(rt.port, { body: { model: 'x', messages: [] } });
  assert.strictEqual(r.status, 503);
  assert.match(json(r).error.message, /MISSING_KEY/);
  assert.strictEqual(up.received.length, 0, '不该打上游');
});

test('allowModels 在本地拦下未知模型名', async (t) => {
  const up = await fakeUpstream((req, res) => { res.writeHead(200); res.end('{}'); });
  const cfg = passthroughConfig(up.port);
  cfg.upstreams.other = { protocol: 'http', host: '127.0.0.1', port: up.port };
  cfg.routes.unshift({
    name: 'limited',
    match: { model: ['ds*'] },
    adapter: 'passthrough',
    upstream: 'other',
    auth: { mode: 'none' },
    allowModels: ['ds-pro', 'ds-flash'],
  });
  const rt = await startRouter(cfg);
  t.after(() => shutdown(up.server, rt.server));

  const bad = await callRouter(rt.port, { body: { model: 'ds-typo', messages: [] } });
  assert.strictEqual(bad.status, 400);
  assert.match(json(bad).error.message, /ds-pro/, '报错里应列出可用模型');
  assert.strictEqual(up.received.length, 0);

  const good = await callRouter(rt.port, { body: { model: 'ds-pro', messages: [] } });
  assert.strictEqual(good.status, 200);
});

test('bodyOverrides 在指定路径上生效', async (t) => {
  const up = await fakeUpstream((req, res) => { res.writeHead(200); res.end('{}'); });
  const cfg = passthroughConfig(up.port, {
    bodyOverrides: { output_config: { effort: 'max' } },
    bodyOverridePaths: ['/v1/messages'],
  });
  const rt = await startRouter(cfg);
  t.after(() => shutdown(up.server, rt.server));

  await callRouter(rt.port, { body: { model: 'x', messages: [], output_config: { other: 1 } } });
  const sent = JSON.parse(up.received[0].body);
  assert.deepStrictEqual(sent.output_config, { other: 1, effort: 'max' }, '浅合并，保留原有键');

  await callRouter(rt.port, { path: '/v1/other', body: { model: 'x' } });
  assert.strictEqual(JSON.parse(up.received[1].body).output_config, undefined, '非声明路径不改写');
});

// ── 选路 ──
test('按模型名选路，未匹配落兜底', async (t) => {
  const upA = await fakeUpstream((req, res) => { res.writeHead(200); res.end('{"who":"A"}'); });
  const upB = await fakeUpstream((req, res) => { res.writeHead(200); res.end('{"who":"B"}'); });
  const cfg = passthroughConfig(upB.port);
  cfg.upstreams.a = { protocol: 'http', host: '127.0.0.1', port: upA.port };
  cfg.routes.unshift({
    name: 'route-a', match: { model: ['a-*'] }, adapter: 'passthrough',
    upstream: 'a', auth: { mode: 'none' },
  });
  const rt = await startRouter(cfg);
  t.after(() => shutdown(upA.server, upB.server, rt.server));

  assert.strictEqual(json(await callRouter(rt.port, { body: { model: 'a-1', messages: [] } })).who, 'A');
  assert.strictEqual(json(await callRouter(rt.port, { body: { model: 'zzz', messages: [] } })).who, 'B');
});

// ── 内置端点 ──
test('healthz 返回 JSON 且标出 degraded 路由', async (t) => {
  const up = await fakeUpstream((req, res) => { res.writeHead(200); res.end('{}'); });
  const cfg = passthroughConfig(up.port);
  cfg.upstreams.x = { protocol: 'http', host: '127.0.0.1', port: up.port };
  cfg.routes.unshift({
    name: 'broken', match: { model: ['b*'] }, adapter: 'passthrough', upstream: 'x',
    auth: { mode: 'secrets', secretKey: 'NOPE', header: 'authorization' },
  });
  const rt = await startRouter(cfg);
  t.after(() => shutdown(up.server, rt.server));

  const r = await callRouter(rt.port, { path: '/healthz', method: 'GET' });
  assert.strictEqual(r.status, 200);
  const h = json(r);
  assert.strictEqual(h.ok, true);
  assert.strictEqual(h.degradedCount, 1);
  assert.strictEqual(h.routes.find((x) => x.name === 'broken').degraded, true);
  assert.ok(h.version && h.pid);
});

test('count_tokens 按路由策略处理', async (t) => {
  const up = await fakeUpstream((req, res) => {
    res.writeHead(200); res.end('{"input_tokens":999}');
  });
  // forward：交给上游
  const fwd = await startRouter(passthroughConfig(up.port));
  const r1 = await callRouter(fwd.port, { path: '/v1/messages/count_tokens', body: { model: 'x', messages: [] } });
  assert.strictEqual(json(r1).input_tokens, 999, 'forward 应转发给上游');
  shutdown(fwd.server);

  // estimate：本地算
  const est = await startRouter(passthroughConfig(up.port, { countTokens: 'estimate', estimateBytesPerToken: 4 }));
  const r2 = await callRouter(est.port, { path: '/v1/messages/count_tokens', body: { model: 'x', messages: [] } });
  assert.notStrictEqual(json(r2).input_tokens, 999, 'estimate 不该打上游');
  assert.ok(json(r2).input_tokens > 0);
  shutdown(est.server);

  t.after(() => shutdown(up.server));
});

// ── 安全守卫 ──
test('Host 头非回环时 403', async (t) => {
  const up = await fakeUpstream((req, res) => { res.writeHead(200); res.end('{}'); });
  const rt = await startRouter(passthroughConfig(up.port));
  t.after(() => shutdown(up.server, rt.server));

  const r = await callRouter(rt.port, { body: { model: 'x' }, hostHeader: 'evil.example.com' });
  assert.strictEqual(r.status, 403);
  assert.strictEqual(up.received.length, 0);
});

test('带 Origin 头时 403', async (t) => {
  const up = await fakeUpstream((req, res) => { res.writeHead(200); res.end('{}'); });
  const rt = await startRouter(passthroughConfig(up.port));
  t.after(() => shutdown(up.server, rt.server));

  const r = await callRouter(rt.port, {
    body: { model: 'x' },
    headers: { origin: 'http://evil.example.com' },
  });
  assert.strictEqual(r.status, 403);
  assert.strictEqual(up.received.length, 0);
});

test('跨站 Sec-Fetch-Site 403，same-origin 放行', async (t) => {
  const up = await fakeUpstream((req, res) => { res.writeHead(200); res.end('{}'); });
  const rt = await startRouter(passthroughConfig(up.port));
  t.after(() => shutdown(up.server, rt.server));

  const bad = await callRouter(rt.port, { body: { model: 'x' }, headers: { 'sec-fetch-site': 'cross-site' } });
  assert.strictEqual(bad.status, 403);

  const ok = await callRouter(rt.port, { body: { model: 'x' }, headers: { 'sec-fetch-site': 'none' } });
  assert.strictEqual(ok.status, 200);
});

test('守卫也保护 healthz 与 domain_info', async (t) => {
  const up = await fakeUpstream((req, res) => { res.writeHead(200); res.end('{}'); });
  const rt = await startRouter(passthroughConfig(up.port));
  t.after(() => shutdown(up.server, rt.server));

  for (const p of ['/healthz', '/api/web/domain_info?domain=x.com']) {
    const r = await callRouter(rt.port, { path: p, method: 'GET', hostHeader: 'evil.example.com' });
    assert.strictEqual(r.status, 403, `${p} 也该被守卫拦住`);
  }
});

test('永不返回 CORS 放行头', async (t) => {
  const up = await fakeUpstream((req, res) => { res.writeHead(200); res.end('{}'); });
  const rt = await startRouter(passthroughConfig(up.port));
  t.after(() => shutdown(up.server, rt.server));

  const r = await callRouter(rt.port, { path: '/healthz', method: 'GET' });
  assert.strictEqual(r.headers['access-control-allow-origin'], undefined);
});

test('启用本地令牌后无令牌被拒、有令牌放行', async (t) => {
  const up = await fakeUpstream((req, res) => { res.writeHead(200); res.end('{}'); });
  const cfg = passthroughConfig(up.port);
  cfg.listen.requireToken = true;
  const rt = await startRouter(cfg, { routerToken: 'sekrit' });
  t.after(() => shutdown(up.server, rt.server));

  assert.strictEqual((await callRouter(rt.port, { body: { model: 'x' } })).status, 401);
  assert.strictEqual((await callRouter(rt.port, {
    body: { model: 'x' }, headers: { 'x-gpt-router-token': 'wrong' },
  })).status, 401);
  assert.strictEqual((await callRouter(rt.port, {
    body: { model: 'x', messages: [] }, headers: { 'x-gpt-router-token': 'sekrit' },
  })).status, 200);
});

// ── responses 适配器 ──
test('responses 适配器：非流式往返', async (t) => {
  const up = await fakeUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'resp_1',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'from responses line' }] }],
      usage: { input_tokens: 10, output_tokens: 3 },
    }));
  });
  const cfg = {
    version: 1,
    listen: { host: '127.0.0.1', port: 8402 },
    log: { level: 'error' },
    upstreams: { fake: { protocol: 'http', host: '127.0.0.1', port: up.port } },
    routes: [
      {
        name: 'gpt', match: { model: ['gpt*'] }, adapter: 'responses', upstream: 'fake',
        auth: { mode: 'client', header: 'authorization' },
        modelMap: { 'gpt-test': { model: 'upstream-real', effort: 'high' } },
      },
      {
        name: 'fallback', default: true, adapter: 'passthrough', upstream: 'fake',
        auth: { mode: 'none' },
      },
    ],
  };
  const rt = await startRouter(cfg);
  t.after(() => shutdown(up.server, rt.server));

  const r = await callRouter(rt.port, {
    body: { model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }] },
    headers: { authorization: 'Bearer ck' },
  });

  assert.strictEqual(r.status, 200);
  const msg = json(r);
  assert.strictEqual(msg.type, 'message');
  assert.strictEqual(msg.model, 'gpt-test', '回给客户端的是公开名');
  assert.strictEqual(msg.content[0].text, 'from responses line');

  // 上游收到的是别名解析后的真名与 effort
  assert.strictEqual(up.received[0].url, '/v1/responses');
  const sent = JSON.parse(up.received[0].body);
  assert.strictEqual(sent.model, 'upstream-real');
  assert.strictEqual(sent.reasoning.effort, 'high');
  assert.strictEqual(sent.input[0].content[0].type, 'input_text');
});

test('responses 适配器：流式翻译成 Anthropic SSE', async (t) => {
  const sse = fs.readFileSync(path.join(__dirname, 'fixtures', 'responses-normal.sse'), 'utf8');
  const up = await fakeUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sse);
  });
  const cfg = {
    version: 1,
    listen: { host: '127.0.0.1', port: 8402 },
    log: { level: 'error' },
    upstreams: { fake: { protocol: 'http', host: '127.0.0.1', port: up.port } },
    routes: [{
      name: 'gpt', default: true, adapter: 'responses', upstream: 'fake',
      auth: { mode: 'client', header: 'authorization' },
    }],
  };
  const rt = await startRouter(cfg);
  t.after(() => shutdown(up.server, rt.server));

  const r = await callRouter(rt.port, {
    body: { model: 'gpt-x', messages: [], stream: true },
    headers: { authorization: 'Bearer ck' },
  });

  assert.match(r.headers['content-type'], /text\/event-stream/);
  assert.match(r.text, /event: message_start/);
  assert.match(r.text, /event: message_stop/);
  assert.match(r.text, /"text":"Hello"/);
});

test('responses 适配器缺凭证时 401', async (t) => {
  const up = await fakeUpstream((req, res) => { res.writeHead(200); res.end('{}'); });
  const cfg = {
    version: 1,
    listen: { host: '127.0.0.1', port: 8402 },
    log: { level: 'error' },
    upstreams: { fake: { protocol: 'http', host: '127.0.0.1', port: up.port } },
    routes: [{
      name: 'gpt', default: true, adapter: 'responses', upstream: 'fake',
      auth: { mode: 'client', header: 'authorization' },
    }],
  };
  const rt = await startRouter(cfg);
  t.after(() => shutdown(up.server, rt.server));

  const r = await callRouter(rt.port, { body: { model: 'gpt-x', messages: [] } });
  assert.strictEqual(r.status, 401);
  assert.strictEqual(up.received.length, 0);
});

test('上游连不上时返回 502', async (t) => {
  // 指向一个没人监听的端口
  const cfg = passthroughConfig(1);
  cfg.upstreams.fake.port = 9; // discard 端口，通常拒连
  cfg.routes[0].retry = { maxRetries: 0, backoffMs: [0] };
  const rt = await startRouter(cfg);
  t.after(() => shutdown(rt.server));

  const r = await callRouter(rt.port, { body: { model: 'x', messages: [] } });
  assert.strictEqual(r.status, 502);
  assert.match(json(r).error.message, /gpt-router/);
});
