'use strict';
/**
 * KeepAlive 守护。只有 Windows 用得上——launchd 和 systemd 自带这个能力。
 *
 * 修掉了原实现的一个真 bug：原来对任何退出码都重启，而服务在端口被占用时
 * 会 exit(0) 表示"已有实例在跑，我主动退出"。两者一撞就是每 3 秒 spawn
 * 一次的无限循环，日志刷满，而用户看到的现象是"装了但没跑"。
 *
 * 所以这里只在非零退出码时重启，并加崩溃循环熔断。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const RESTART_DELAY_MS = 3000;
/** 连续快速失败超过这个次数就停下，别无限重试。 */
const MAX_RAPID_FAILURES = 5;
/** 活过这个时长就认为启动成功，重置失败计数。 */
const HEALTHY_UPTIME_MS = 30000;

function keepalive(options = {}) {
  const home = options.home;
  const logFile = path.join(home, 'supervisor.err.log');
  const entry = options.entry || path.resolve(__dirname, '..', 'bin', 'gpt-router.js');

  const log = (line) => {
    fs.appendFile(logFile, `${new Date().toISOString()} keepalive: ${line}\n`, () => {});
  };

  // pid 文件是 stop/uninstall 精确定位本 home 实例的唯一依据——命令行里
  // 没有 home（它是环境变量），没有它就只能靠模糊匹配命令行，那样会误杀
  // 别的 home 下正在服务的实例。
  const pidFile = path.join(home, 'keepalive.pid');
  try {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(pidFile, String(process.pid));
  } catch (e) {
    log(`写 pid 文件失败（stop/uninstall 将无法精确定位本实例）：${e.message}`);
  }
  const cleanupPid = () => {
    try { fs.unlinkSync(pidFile); } catch { /* 已经没了就算了 */ }
  };
  process.on('exit', cleanupPid);
  // SIGTERM 下 'exit' 不一定触发，显式兜一层
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));

  let rapidFailures = 0;

  function start() {
    const startedAt = Date.now();
    log('启动 gpt-router run');

    const child = spawn(process.execPath, [entry, 'run'], {
      stdio: ['ignore', 'ignore', 'ignore'],
      windowsHide: true,
      env: { ...process.env, GPT_ROUTER_HOME: home },
    });

    child.on('exit', (code, signal) => {
      const uptime = Date.now() - startedAt;

      // 退出码 0 = 服务主动退出（通常是端口已被占用，已有实例在跑）。
      // 重启它就是无限循环——这正是原实现的 bug。
      if (code === 0) {
        log('gpt-router 正常退出（可能已有实例在跑），守护也退出');
        process.exit(0);
      }

      if (uptime >= HEALTHY_UPTIME_MS) {
        rapidFailures = 0; // 活够久了，之前的失败不算连续
      } else {
        rapidFailures++;
      }

      if (rapidFailures >= MAX_RAPID_FAILURES) {
        log(`连续 ${rapidFailures} 次快速失败（最后一次 code=${code} signal=${signal}），停止重试。`
          + ' 请检查配置：gpt-router check');
        process.exit(1);
      }

      log(`gpt-router 退出 code=${code} signal=${signal} uptime=${Math.round(uptime / 1000)}s，`
        + `${RESTART_DELAY_MS / 1000} 秒后重启（连续失败 ${rapidFailures}/${MAX_RAPID_FAILURES}）`);
      setTimeout(start, RESTART_DELAY_MS);
    });

    child.on('error', (e) => {
      rapidFailures++;
      log(`spawn 失败：${e.message}`);
      if (rapidFailures >= MAX_RAPID_FAILURES) {
        log('反复 spawn 失败，停止重试');
        process.exit(1);
      }
      setTimeout(start, RESTART_DELAY_MS);
    });
  }

  start();
}

module.exports = { keepalive, RESTART_DELAY_MS, MAX_RAPID_FAILURES, HEALTHY_UPTIME_MS };
