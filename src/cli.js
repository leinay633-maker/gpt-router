'use strict';
/**
 * CLI 子命令。
 *
 * 这个文件里没有一处 process.platform 判断——平台差异全部收在
 * src/supervise/ 下，由那里的模块声明自己的 supervisor 类型。
 */

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');

const { loadConfig, routerHome, configPathOf, ConfigError } = require('./config/load');
const { validate, formatReport } = require('./config/validate');
const { loadSecrets } = require('./config/secrets');
const { createLogger } = require('./log');
const { listen } = require('./server');
const supervise = require('./supervise');
const { keepalive } = require('./daemon');
const { PKG_VERSION } = require('./builtins/healthz');

const out = (s = '') => process.stdout.write(`${s}\n`);
const err = (s = '') => process.stderr.write(`${s}\n`);

/** 配置加载失败时统一的报错出口。 */
function reportConfigError(e) {
  if (e instanceof ConfigError) {
    err(e.report || e.message);
    return e.exitCode;
  }
  throw e;
}

/** 打 /healthz，这是"服务是否真在提供能力"的唯一真相。 */
function probeHealth(host, port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const req = http.request(
      { host, port, path: '/healthz', method: 'GET', headers: { host: `${host}:${port}` } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve({ up: res.statusCode === 200, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
          } catch {
            resolve({ up: false, body: null });
          }
        });
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve({ up: false, body: null }));
    req.end();
  });
}

/** install 时若配置缺失，从 example 生成一份。已存在则不动。 */
function ensureConfigFiles(home) {
  const created = [];
  fs.mkdirSync(home, { recursive: true });

  const cfgTarget = path.join(home, 'config.json');
  if (!fs.existsSync(cfgTarget)) {
    fs.copyFileSync(path.resolve(__dirname, '..', 'config.example.json'), cfgTarget);
    created.push(cfgTarget);
  }

  const secTarget = path.join(home, 'secrets.json');
  if (!fs.existsSync(secTarget)) {
    // 0600：POSIX 上只有本人可读。Windows 走 ACL，这个模式位无效但无害。
    fs.writeFileSync(secTarget, '{\n}\n', { mode: 0o600 });
    created.push(secTarget);
  }

  return created;
}

// ────────────────────────── 子命令 ──────────────────────────

async function cmdRun() {
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    return reportConfigError(e);
  }

  const log = createLogger({ ...config.log, stderr: true });
  let secretsValues = {};
  try {
    secretsValues = loadSecrets(config.secretsPath).values;
  } catch {
    // loadConfig 已经校验过，这里失败不该发生
  }

  try {
    const server = await listen(config, log, { routerToken: secretsValues.ROUTER_TOKEN || null });

    const shutdown = (signal) => {
      log.info(`收到 ${signal}，正在关闭`);
      server.closeAllConnections?.();
      server.close(() => process.exit(0));
      // 兜底：连接不肯断也别吊死
      setTimeout(() => process.exit(0), 3000).unref();
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    return null; // 前台常驻
  } catch (e) {
    if (e.alreadyRunning) return 0; // 已有实例，主动退出且不算失败
    err(`gpt-router: 启动失败 ${e.message}`);
    return 1;
  }
}

async function cmdKeepalive() {
  keepalive({ home: routerHome() });
  return null;
}

async function cmdCheck(args) {
  const configPath = args.config || configPathOf();
  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (e) {
    err(e.code === 'ENOENT'
      ? `gpt-router: 找不到配置文件 ${configPath}\n\n跑 gpt-router install 会生成一份。`
      : `gpt-router: 读取 ${configPath} 失败：${e.message}`);
    return 78;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    err(`gpt-router: ${configPath} 语法错误\n\n  ${e.message}\n\nJSON 不支持注释，也不允许尾逗号。`);
    return 78;
  }

  const result = validate(parsed);
  const report = formatReport(result, configPath);
  if (result.errors.length) {
    err(report);
    return 78;
  }

  out(`gpt-router: 配置有效（${configPath}）`);
  if (result.warnings.length) out(report);

  // 校验通过后再看凭证能不能解析出来
  try {
    const loaded = loadConfig({ configPath });
    const degraded = loaded.routes.filter((r) => r.degraded);
    if (degraded.length) {
      out('');
      out(`${degraded.length} 条路由当前不可用（命中时返回 503）：`);
      for (const r of degraded) out(`  ${r.name}：${r.degradedReason}`);
    }
  } catch (e) {
    return reportConfigError(e);
  }

  return 0;
}

async function cmdInstall(args) {
  const home = routerHome();
  const created = ensureConfigFiles(home);
  for (const f of created) out(`已生成 ${f}`);

  let config;
  try {
    config = loadConfig();
  } catch (e) {
    return reportConfigError(e);
  }

  let platform;
  try {
    platform = supervise.forPlatform();
  } catch (e) {
    err(`gpt-router: ${e.message}`);
    return 1;
  }

  const pre = await platform.preflight();
  if (!pre.ok) {
    err(`gpt-router: 无法安装自启\n\n${pre.message}`);
    return 1;
  }

  const ctx = supervise.context(config);

  if (args.noAutostart) {
    out(`跳过自启注册（--no-autostart）。手动运行：gpt-router run`);
  } else {
    const result = await platform.install(ctx);
    out(`平台：${platform.platformName}`);
    out(`注册文件：${result.registrationPath}`);
    out(result.message);
    for (const n of result.notes || []) out(`\n${n}`);
  }

  // 等服务起来，再报实际状态——不假设 install 成功就等于在跑
  await new Promise((r) => setTimeout(r, 1200));
  const health = await probeHealth(config.listen.host, config.listen.port);

  out('');
  if (health.up) {
    // 端口上确实有人应答，但可能不是我们——比如用户早就有一个别的服务在这个
    // 端口上。healthz 是自述端点，认不出自己就说明撞了，别谎报安装成功。
    const mine = health.body && health.body.ok === true && typeof health.body.routes === 'object';
    if (!mine) {
      out(`端口 ${config.listen.port} 上有其他服务在应答，不是 gpt-router。`);
      out(`换个端口：改 ${config.configPath} 里的 listen.port，然后 gpt-router restart。`);
      return 1;
    }
    if (health.body.configPath !== config.configPath) {
      out(`端口 ${config.listen.port} 已被另一个 gpt-router 实例占用：`);
      out(`  它的配置：${health.body.configPath}`);
      out(`  本次配置：${config.configPath}`);
      out('');
      out(`两个实例不能共用一个端口。改本次配置里的 listen.port，或先停掉那个实例。`);
      return 1;
    }
    out(`服务已就绪：http://${config.listen.host}:${config.listen.port}`);
    if (health.body.degradedCount) {
      out(`注意：${health.body.degradedCount} 条路由不可用，跑 gpt-router status 看详情`);
    }
  } else {
    out(`服务尚未响应 /healthz。跑 gpt-router logs 看日志，或 gpt-router doctor 体检。`);
  }

  out('');
  out('接下来在 Claude Code 侧设这个环境变量：');
  out('');
  out(`  ANTHROPIC_BASE_URL=http://${config.listen.host}:${config.listen.port}`);
  out('');
  out('Windows: setx ANTHROPIC_BASE_URL "http://' + config.listen.host + ':' + config.listen.port + '"');
  out('macOS/Linux: 写进 ~/.zshrc 或 ~/.bashrc');
  out('');
  out('设完要重开终端才生效。改完可以跑 gpt-router doctor 确认。');

  return health.up ? 0 : 1;
}

async function cmdUninstall(args) {
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    // 配置坏了也要能卸载
    config = { home: routerHome(), configPath: configPathOf(), log: { file: null }, listen: {} };
  }

  let platform;
  try {
    platform = supervise.forPlatform();
  } catch (e) {
    err(`gpt-router: ${e.message}`);
    return 1;
  }

  const ctx = supervise.context(config);
  const result = await platform.uninstall(ctx);
  out(result.removed ? `已移除 ${result.registrationPath}` : `注册文件本来就不存在`);

  if (args.purge) {
    // 明确说了 --purge 才删配置和凭证
    fs.rmSync(config.home, { recursive: true, force: true });
    out(`已删除 ${config.home}（含 config.json 与 secrets.json）`);
  } else {
    out(`配置保留在 ${config.home}。要一起删就加 --purge。`);
  }

  out('');
  out('别忘了把 Claude Code 侧的 ANTHROPIC_BASE_URL 环境变量也去掉。');
  return 0;
}

async function cmdStart() {
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    return reportConfigError(e);
  }
  const platform = supervise.forPlatform();
  const r = await platform.start(supervise.context(config));
  if (!r.ok) {
    err(`gpt-router: 启动失败 ${r.message || ''}`);
    return 1;
  }
  await new Promise((res) => setTimeout(res, 1200));
  const health = await probeHealth(config.listen.host, config.listen.port);
  out(health.up ? '已启动' : '已发出启动指令，但服务尚未响应 /healthz');
  return health.up ? 0 : 1;
}

async function cmdStop() {
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    return reportConfigError(e);
  }
  const platform = supervise.forPlatform();
  const r = await platform.stop(supervise.context(config));
  // 平台层能报出"本来就没在跑"这类情况，别一律盖成"已停止"
  if (!r.ok) {
    out(`停止失败：${r.message || ''}`);
    return 1;
  }
  out(r.message || '已停止');
  return 0;
}

async function cmdRestart() {
  const stopped = await cmdStop();
  if (stopped !== 0) return stopped;
  await new Promise((r) => setTimeout(r, 500));
  return cmdStart();
}

/**
 * status 把两件事分开报告：注册状态和运行状态。
 * 这两者不一致（装了但没跑）恰恰是最常见的故障态。
 */
async function cmdStatus(args) {
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    return reportConfigError(e);
  }

  const platform = supervise.forPlatform();
  const reg = await platform.registered(supervise.context(config));
  const health = await probeHealth(config.listen.host, config.listen.port);

  if (args.json) {
    out(JSON.stringify({
      platform: platform.platformName,
      registration: reg,
      running: health.up,
      health: health.body,
    }, null, 2));
    return health.up ? 0 : 1;
  }

  out(`平台      ${platform.platformName}`);
  out(`注册      ${reg.installed ? (reg.enabled ? '已启用' : '已安装但未启用') : '未安装'}`);
  out(`运行      ${health.up ? '正常' : '未响应'}  (http://${config.listen.host}:${config.listen.port})`);
  out(`配置      ${config.configPath}`);
  out(`日志      ${config.log.file}`);

  if (health.up && health.body) {
    out(`版本      ${health.body.version}  pid ${health.body.pid}  已运行 ${health.body.uptimeSec}s`);
    out('');
    out('路由：');
    for (const r of health.body.routes) {
      const flags = [r.default ? 'default' : null, r.degraded ? `不可用: ${r.reason}` : null]
        .filter(Boolean).join(', ');
      out(`  ${r.name.padEnd(20)} ${r.adapter.padEnd(12)} → ${r.upstream}${flags ? `  [${flags}]` : ''}`);
    }
  } else if (reg.installed) {
    out('');
    out('已注册但没在跑。跑 gpt-router logs 看原因，或 gpt-router doctor 体检。');
  }

  return health.up ? 0 : 1;
}

/**
 * logs 自己实现 tail -f：Windows 没有 tail，
 * shell out 是"三平台一致"里最容易偷懒然后翻车的地方。
 */
async function cmdLogs(args) {
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    return reportConfigError(e);
  }

  const file = config.log.file;
  if (!fs.existsSync(file)) {
    err(`还没有日志文件：${file}`);
    return 1;
  }

  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  const n = args.lines || 50;
  for (const l of lines.slice(-n)) out(l);

  if (!args.follow) return 0;

  let offset = fs.statSync(file).size;
  out(`\n--- 跟随 ${file}（Ctrl+C 退出）---`);
  fs.watchFile(file, { interval: 500 }, (cur) => {
    if (cur.size < offset) {
      offset = 0; // 日志被轮转了
      return;
    }
    if (cur.size === offset) return;
    const stream = fs.createReadStream(file, { start: offset, end: cur.size - 1, encoding: 'utf8' });
    stream.on('data', (chunk) => process.stdout.write(chunk));
    stream.on('end', () => { offset = cur.size; });
  });
  return null; // 常驻
}

async function cmdDoctor() {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  // Node 版本
  const major = Number(process.versions.node.split('.')[0]);
  add('Node 版本', major >= 18, `${process.versions.node}${major >= 18 ? '' : '（需要 >= 18）'}`);

  // 配置
  let config = null;
  const cfgPath = configPathOf();
  try {
    config = loadConfig();
    add('配置文件', true, config.configPath);
  } catch (e) {
    // "还没装" 和 "装了但配错了" 要给出不同的下一步动作
    const detail = !fs.existsSync(cfgPath)
      ? `不存在，跑 gpt-router install 生成（${cfgPath}）`
      : (e instanceof ConfigError ? '校验失败，跑 gpt-router check 看详情' : e.message);
    add('配置文件', false, detail);
  }

  if (config) {
    // 平台注册
    try {
      const platform = supervise.forPlatform();
      const reg = await platform.registered(supervise.context(config));
      add('自启注册', reg.installed, reg.installed
        ? `${platform.platformName}${reg.enabled ? '' : '（已安装但未启用）'}`
        : '未安装，跑 gpt-router install');
    } catch (e) {
      add('自启注册', false, e.message);
    }

    // 服务本体
    const health = await probeHealth(config.listen.host, config.listen.port);
    add('服务响应', health.up, health.up
      ? `http://${config.listen.host}:${config.listen.port}`
      : '未响应 /healthz');

    // 路由可用性
    if (health.up && health.body) {
      const bad = health.body.routes.filter((r) => r.degraded);
      add('路由凭证', bad.length === 0, bad.length
        ? `${bad.length} 条不可用：${bad.map((r) => r.name).join(', ')}`
        : `${health.body.routes.length} 条路由就绪`);
    }

    // CC 侧环境变量
    const base = process.env.ANTHROPIC_BASE_URL;
    const expected = `http://${config.listen.host}:${config.listen.port}`;
    add('ANTHROPIC_BASE_URL', base === expected,
      base ? (base === expected ? base : `当前是 ${base}，期望 ${expected}`) : `未设置，应为 ${expected}`);
  }

  out('');
  for (const c of checks) {
    out(`  ${c.ok ? '✓' : '✗'} ${c.name.padEnd(22)} ${c.detail}`);
  }
  out('');

  const failed = checks.filter((c) => !c.ok);
  if (!failed.length) {
    out('一切正常。');
    return 0;
  }
  out(`${failed.length} 项需要处理。`);
  return 1;
}

function cmdVersion() {
  out(`gpt-router ${PKG_VERSION}`);
  out(`node ${process.versions.node} on ${process.platform}-${process.arch}`);
  return 0;
}

function cmdHelp() {
  out(`gpt-router ${PKG_VERSION} —— 让 Claude Code 用上非 Anthropic 模型的本地代理

用法：gpt-router <命令> [选项]

安装与生命周期
  install [--port N] [--no-autostart]   生成配置、注册自启、启动服务
  uninstall [--purge]                   停服并移除自启；--purge 连配置一起删
  start | stop | restart                控制服务
  status [--json]                       注册状态 + 运行状态
  logs [-n N] [-f]                      看日志，-f 跟随

诊断
  check [--config PATH]                 只校验配置，不启动（退出码 78 表示配置有问题）
  doctor                                环境体检：Node、配置、注册、服务、环境变量
  run                                   前台运行，调试用

配置在 ${routerHome()}
  config.json    可分享，不含凭证
  secrets.json   凭证，永不入库

先跑 gpt-router install。`);
  return 0;
}

// ────────────────────────── 分派 ──────────────────────────

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--purge') args.purge = true;
    else if (a === '--no-autostart') args.noAutostart = true;
    else if (a === '-f' || a === '--follow') args.follow = true;
    else if (a === '-n' || a === '--lines') args.lines = Number(argv[++i]);
    else if (a === '--port') args.port = Number(argv[++i]);
    else if (a === '--config') args.config = argv[++i];
    else args._.push(a);
  }
  return args;
}

const COMMANDS = {
  run: cmdRun,
  _keepalive: cmdKeepalive,
  install: cmdInstall,
  uninstall: cmdUninstall,
  start: cmdStart,
  stop: cmdStop,
  restart: cmdRestart,
  status: cmdStatus,
  logs: cmdLogs,
  check: cmdCheck,
  doctor: cmdDoctor,
  version: cmdVersion,
  '--version': cmdVersion,
  '-v': cmdVersion,
  help: cmdHelp,
  '--help': cmdHelp,
  '-h': cmdHelp,
};

async function main(argv) {
  const args = parseArgs(argv);
  const name = args._[0] || 'help';
  const cmd = COMMANDS[name];

  if (!cmd) {
    err(`gpt-router: 未知命令 "${name}"\n`);
    cmdHelp();
    return 1;
  }

  return cmd(args);
}

module.exports = { main, parseArgs, probeHealth, COMMANDS };
