'use strict';
/**
 * macOS：LaunchAgent。
 *
 * launchd 自带 KeepAlive，所以这里不需要我们的 daemon 层——supervisor 是
 * 'system'，ExecStart 直接指向 `gpt-router run`。
 */

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { render, writeFile, removeFile, run, logPaths } = require('./shared');

const label = (ctx) => `io.github.gpt-router.${ctx.serviceId}`;
const plistPath = (ctx) => path.join(os.homedir(), 'Library', 'LaunchAgents', `${label(ctx)}.plist`);
const domain = () => `gui/${process.getuid ? process.getuid() : ''}`;

/**
 * launchctl bootstrap 是现代写法，load -w 已废弃但在旧系统上仍是唯一可用的。
 * 先试新的，失败再退回旧的。
 */
async function bootstrap(ctx) {
  const target = plistPath(ctx);
  const modern = await run('launchctl', ['bootstrap', domain(), target]);
  if (modern.ok) return { ok: true, how: 'bootstrap' };

  const legacy = await run('launchctl', ['load', '-w', target]);
  if (legacy.ok) return { ok: true, how: 'load -w' };

  return { ok: false, message: modern.stderr || legacy.stderr || '未知错误' };
}

async function bootout(ctx) {
  const target = plistPath(ctx);
  const modern = await run('launchctl', ['bootout', `${domain()}/${label(ctx)}`]);
  if (modern.ok) return true;
  const legacy = await run('launchctl', ['unload', '-w', target]);
  return legacy.ok;
}

module.exports = {
  supervisor: 'system',
  platformName: 'macOS (launchd)',

  registrationPath: plistPath,

  /** 装机前的环境自检。 */
  async preflight() {
    const which = await run('which', ['launchctl']);
    if (!which.ok) {
      return { ok: false, message: '找不到 launchctl，无法安装 LaunchAgent。' };
    }
    return { ok: true };
  },

  async install(ctx) {
    const logs = logPaths(ctx);
    const content = render('launchd.plist.tmpl', {
      LABEL: label(ctx),
      NODE: ctx.nodePath,
      ENTRY: ctx.entry,
      HOME: ctx.home,
      STDOUT: logs.stdout,
      STDERR: logs.stderr,
    });

    // 重装前先卸载，否则 launchd 会拒绝加载同名 Label
    await bootout(ctx);
    const target = writeFile(plistPath(ctx), content);
    const loaded = await bootstrap(ctx);

    return {
      registrationPath: target,
      started: loaded.ok,
      message: loaded.ok
        ? `已注册 LaunchAgent（${loaded.how}）`
        : `plist 已写入 ${target}，但加载失败：${loaded.message}`,
    };
  },

  async uninstall(ctx) {
    await bootout(ctx);
    const removed = removeFile(plistPath(ctx));
    return { removed, registrationPath: plistPath(ctx) };
  },

  async start(ctx) {
    if (!fs.existsSync(plistPath(ctx))) {
      return { ok: false, message: '还没安装。先跑 gpt-router install。' };
    }
    const r = await run('launchctl', ['kickstart', '-k', `${domain()}/${label(ctx)}`]);
    if (r.ok) return { ok: true };
    // kickstart 在旧系统上不存在，退回 bootstrap
    const b = await bootstrap(ctx);
    return b.ok ? { ok: true } : { ok: false, message: b.message };
  },

  async stop(ctx) {
    const r = await run('launchctl', ['bootout', `${domain()}/${label(ctx)}`]);
    return { ok: r.ok, message: r.ok ? null : r.stderr };
  },

  /** 注册状态。运行状态由 CLI 通过 /healthz 单独判断。 */
  async registered(ctx) {
    if (!fs.existsSync(plistPath(ctx))) return { installed: false, enabled: false };
    const r = await run('launchctl', ['print', `${domain()}/${label(ctx)}`]);
    return { installed: true, enabled: r.ok };
  },
};
