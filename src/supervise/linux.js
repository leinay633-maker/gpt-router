'use strict';
/**
 * Linux：systemd user unit。
 *
 * systemd 自带 Restart，所以不需要我们的 daemon 层——supervisor 是 'system'。
 *
 * 两个必做检测：
 *   - 有没有 systemd。WSL1、部分容器、Alpine/runit 上没有，要在写文件之前
 *     就明确报错并指出降级路径，而不是写完 unit 再失败。
 *   - linger 开没开。没开的话用户一登出服务就被杀，这是 systemd user unit
 *     最常见的困惑。检测到就提示——但不自动改，它影响系统级行为。
 */

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { render, writeFile, removeFile, run, logPaths } = require('./shared');

const unitName = (ctx) => `${ctx.serviceId}.service`;
const unitPath = (ctx) => path.join(os.homedir(), '.config', 'systemd', 'user', unitName(ctx));

const hasSystemd = () => fs.existsSync('/run/systemd/system');

/** 用户登出后服务是否继续运行。 */
async function lingerEnabled() {
  const user = os.userInfo().username;
  const r = await run('loginctl', ['show-user', user, '--property=Linger']);
    if (!r.ok) return null; // loginctl 不可用，判断不了
  return /Linger=yes/i.test(r.stdout);
}

module.exports = {
  supervisor: 'system',
  platformName: 'Linux (systemd user unit)',

  registrationPath: unitPath,

  async preflight() {
    if (!hasSystemd()) {
      return {
        ok: false,
        message: '这台机器没有 systemd（/run/systemd/system 不存在）。\n'
          + '常见于 WSL1、部分容器镜像、以及用 runit/openrc 的发行版。\n\n'
          + '降级方案：手动跑 gpt-router run，用你自己的进程管理器（supervisord、\n'
          + 'pm2、tmux 等）看着它，或者在 WSL2 里安装。',
      };
    }
    const which = await run('systemctl', ['--user', '--version']);
    if (!which.ok) {
      return { ok: false, message: 'systemctl --user 不可用，无法安装 user unit。' };
    }
    return { ok: true };
  },

  async install(ctx) {
    const logs = logPaths(ctx);
    const content = render('systemd.service.tmpl', {
      OWNER: ctx.owner || 'gpt-router',
      NODE: ctx.nodePath,
      ENTRY: ctx.entry,
      HOME: ctx.home,
      STDOUT: logs.stdout,
      STDERR: logs.stderr,
    });

    const target = writeFile(unitPath(ctx), content);
    await run('systemctl', ['--user', 'daemon-reload']);
    const enabled = await run('systemctl', ['--user', 'enable', '--now', unitName(ctx)]);

    const notes = [];
    const linger = await lingerEnabled();
    if (linger === false) {
      // 提示而不自动改：enable-linger 影响系统级行为，属于要征求同意的操作。
      notes.push(
        '注意：你的账户没开 linger，登出后服务会被杀掉。\n'
        + `  想让它常驻，跑：loginctl enable-linger ${os.userInfo().username}`,
      );
    }

    return {
      registrationPath: target,
      started: enabled.ok,
      message: enabled.ok ? '已注册并启动 systemd user unit' : `unit 已写入，但 enable 失败：${enabled.stderr}`,
      notes,
    };
  },

  async uninstall(ctx) {
    await run('systemctl', ['--user', 'disable', '--now', unitName(ctx)]);
    const removed = removeFile(unitPath(ctx));
    await run('systemctl', ['--user', 'daemon-reload']);
    return { removed, registrationPath: unitPath(ctx) };
  },

  async start(ctx) {
    if (!fs.existsSync(unitPath(ctx))) {
      return { ok: false, message: '还没安装。先跑 gpt-router install。' };
    }
    const r = await run('systemctl', ['--user', 'restart', unitName(ctx)]);
    return { ok: r.ok, message: r.ok ? null : r.stderr };
  },

  async stop(ctx) {
    const r = await run('systemctl', ['--user', 'stop', unitName(ctx)]);
    return { ok: r.ok, message: r.ok ? null : r.stderr };
  },

  async registered(ctx) {
    if (!fs.existsSync(unitPath(ctx))) return { installed: false, enabled: false };
    const r = await run('systemctl', ['--user', 'is-enabled', unitName(ctx)]);
    return { installed: true, enabled: r.stdout === 'enabled' };
  },
};
