'use strict';
/**
 * 监督层：注册文件的命名与内容。
 *
 * 这些用例的由来是一次真实事故：拿隔离的 GPT_ROUTER_HOME 跑安装验证，
 * 把作者自己正在服务的实例连带自启注册一起干掉了。两个根因——
 * 注册文件名不含 home 指纹、进程清理用命令行模糊匹配——都在这里钉住。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const supervise = require('../src/supervise');
const { render } = require('../src/supervise/shared');

const DEFAULT_HOME = path.join(os.homedir(), '.gpt-router');

function fakeConfig(home) {
  return {
    home,
    configPath: path.join(home, 'config.json'),
    log: { file: path.join(home, 'router.log') },
    listen: { host: '127.0.0.1', port: 8402 },
  };
}

// ── serviceId：这次事故的直接根因 ──
test('默认 home 用干净的裸名', () => {
  assert.strictEqual(supervise.serviceIdFor(DEFAULT_HOME, DEFAULT_HOME), 'gpt-router');
});

test('自定义 home 追加指纹，不与默认实例撞名', () => {
  const id = supervise.serviceIdFor('D:/somewhere/.testhome', DEFAULT_HOME);
  assert.notStrictEqual(id, 'gpt-router', '撞名会静默覆盖别的实例的自启注册');
  assert.match(id, /^gpt-router-[0-9a-f]{8}$/);
});

test('不同 home 得到不同 serviceId', () => {
  const a = supervise.serviceIdFor('/home/x/.a', DEFAULT_HOME);
  const b = supervise.serviceIdFor('/home/x/.b', DEFAULT_HOME);
  assert.notStrictEqual(a, b);
});

test('同一个 home 稳定得到同一个 serviceId', () => {
  // 不稳定的话，卸载就找不到当初注册的那个文件了
  const h = 'D:/GitHub/gpt-router/.testhome';
  assert.strictEqual(
    supervise.serviceIdFor(h, DEFAULT_HOME),
    supervise.serviceIdFor(h, DEFAULT_HOME),
  );
});

test('Windows 上大小写不同的同一路径视为同一实例', () => {
  const lower = supervise.serviceIdFor('d:/github/gpt-router/.testhome', DEFAULT_HOME);
  const upper = supervise.serviceIdFor('D:/GitHub/GPT-Router/.testhome', DEFAULT_HOME);
  assert.strictEqual(lower, upper);
});

test('context 把 serviceId 和真实 node 路径带出来', () => {
  const ctx = supervise.context(fakeConfig(DEFAULT_HOME));
  assert.strictEqual(ctx.serviceId, 'gpt-router');
  assert.strictEqual(ctx.nodePath, process.execPath, '不能硬编码 node 路径');
  assert.ok(ctx.entry.endsWith(path.join('bin', 'gpt-router.js')));
  assert.ok(fs.existsSync(ctx.entry), 'entry 必须真实存在');
});

test('自定义 home 的 context 带指纹', () => {
  const ctx = supervise.context(fakeConfig('D:/GitHub/gpt-router/.testhome'));
  assert.match(ctx.serviceId, /^gpt-router-[0-9a-f]{8}$/);
});

// ── 平台分派 ──
test('三个平台都有模块，且都实现同一接口', () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    const mod = supervise.PLATFORMS[platform]();
    assert.ok(['system', 'internal'].includes(mod.supervisor), `${platform} 要声明 supervisor 类型`);
    for (const fn of ['preflight', 'install', 'uninstall', 'start', 'stop', 'registered']) {
      assert.strictEqual(typeof mod[fn], 'function', `${platform} 缺 ${fn}`);
    }
    assert.strictEqual(typeof mod.platformName, 'string');
  }
});

test('mac 与 Linux 交给系统做 KeepAlive，Windows 自己看着', () => {
  assert.strictEqual(supervise.PLATFORMS.darwin().supervisor, 'system');
  assert.strictEqual(supervise.PLATFORMS.linux().supervisor, 'system');
  assert.strictEqual(supervise.PLATFORMS.win32().supervisor, 'internal');
});

test('不支持的平台给出降级路径而不是崩', () => {
  assert.throws(
    () => supervise.forPlatform('sunos'),
    (e) => e.unsupportedPlatform === true && /gpt-router run/.test(e.message),
  );
});

// ── 模板渲染 ──
test('模板占位符没填全时报错，而不是把 {{X}} 写进注册文件', () => {
  // 漏填会让故障推迟到服务启动时才暴露，那时已经很难查了
  assert.throws(
    () => render('launchd.plist.tmpl', { LABEL: 'x' }),
    /未替换的占位符/,
  );
});

test('launchd plist 用 SuccessfulExit:false 而不是 KeepAlive:true', () => {
  const xml = render('launchd.plist.tmpl', {
    LABEL: 'io.github.gpt-router.test',
    NODE: '/usr/local/bin/node',
    ENTRY: '/opt/gpt-router/bin/gpt-router.js',
    HOME: '/Users/x/.gpt-router',
    STDOUT: '/Users/x/.gpt-router/out.log',
    STDERR: '/Users/x/.gpt-router/err.log',
  });

  // 退出码 0 表示"端口被占，已有实例在跑，我主动退" —— 重启它就是无限循环
  assert.match(xml, /<key>SuccessfulExit<\/key>\s*<false\/>/);
  assert.ok(!/<key>KeepAlive<\/key>\s*<true\/>/.test(xml), 'KeepAlive:true 会导致无限重启');
  assert.match(xml, /<string>run<\/string>/, 'ExecStart 直接跑 run，不经过 daemon 层');
  assert.match(xml, /GPT_ROUTER_HOME/);
  assert.ok(!xml.includes('{{'), '不能有残留占位符');
});

test('systemd unit 用 on-failure 并带崩溃熔断', () => {
  const unit = render('systemd.service.tmpl', {
    OWNER: 'someone',
    NODE: '/usr/bin/node',
    ENTRY: '/opt/gpt-router/bin/gpt-router.js',
    HOME: '/home/x/.gpt-router',
    STDOUT: '/home/x/.gpt-router/out.log',
    STDERR: '/home/x/.gpt-router/err.log',
  });

  assert.match(unit, /Restart=on-failure/);
  assert.ok(!/Restart=always/.test(unit), 'always 会把主动退出也重启');
  assert.match(unit, /ExecStart=\S+ \S+ run$/m);

  // StartLimit* 属于 [Unit]。放进 [Service] 的话 systemd 只打一行
  // "Unknown key name" 就忽略了，熔断静默失效——只检查"存在"抓不到这个错。
  const sections = {};
  let current = null;
  for (const line of unit.split('\n')) {
    const header = line.match(/^\[(\w+)\]/);
    if (header) { current = header[1]; sections[current] = []; continue; }
    if (current) sections[current].push(line.trim());
  }
  for (const key of ['StartLimitIntervalSec', 'StartLimitBurst']) {
    assert.ok(sections.Unit.some((l) => l.startsWith(`${key}=`)), `${key} 必须在 [Unit] 里`);
    assert.ok(!sections.Service.some((l) => l.startsWith(`${key}=`)), `${key} 不能放在 [Service]`);
  }
});

test('VBS 启动器烤入真实 node 路径且调 _keepalive', () => {
  const vbs = render('launcher.vbs.tmpl', {
    NODE: 'C:\\Users\\someone\\AppData\\nvm\\v22\\node.exe',
    ENTRY: 'D:\\repo\\bin\\gpt-router.js',
  });

  assert.match(vbs, /nvm\\v22\\node\.exe/, '必须用安装时的真实路径');
  assert.ok(!vbs.includes('Program Files\\nodejs'), '不能回退到硬编码的默认安装位置');
  assert.match(vbs, /_keepalive/);
  assert.match(vbs, /, 0, False/, '第二个参数 0 才是真正无窗口');
});

// ── daemon 常量：无限重启那个 bug 的回归防线 ──
test('daemon 的熔断参数存在且合理', () => {
  const d = require('../src/daemon');
  assert.strictEqual(typeof d.keepalive, 'function');
  assert.ok(d.MAX_RAPID_FAILURES >= 2, '要有崩溃循环上限');
  assert.ok(d.RESTART_DELAY_MS >= 1000, '重启间隔别太短');
  assert.ok(d.HEALTHY_UPTIME_MS > d.RESTART_DELAY_MS, '判定健康的时长要长于重启间隔');
});
