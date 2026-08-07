'use strict';
/**
 * 日志。追加写、不阻塞、失败不影响请求处理——日志盘满了不该让代理挂掉。
 */

const fs = require('node:fs');
const path = require('node:path');

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

/** 凭证只留末 4 位。日志不该成为密钥的第二个副本。 */
const tail4 = (k) => (k || '').slice(-4) || '----';

function createLogger(options = {}) {
  const file = options.file || null;
  const threshold = LEVELS[options.level] ?? LEVELS.info;
  const maskKeys = options.maskKeys !== false;
  const toStderr = options.stderr === true;

  if (file) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
    } catch {
      // 建不了目录就退化成只写 stderr
    }
  }

  function write(level, line) {
    if ((LEVELS[level] ?? LEVELS.info) > threshold) return;
    const stamped = `${new Date().toISOString()} ${line}\n`;
    if (file) fs.appendFile(file, stamped, () => {});
    if (toStderr || !file) process.stderr.write(stamped);
  }

  return {
    error: (l) => write('error', l),
    warn: (l) => write('warn', `WARN ${l}`),
    info: (l) => write('info', l),
    debug: (l) => write('debug', `DEBUG ${l}`),
    /** 按配置决定是否脱敏；maskKeys=false 时也只给末 4 位，不给全量。 */
    key: (k) => (maskKeys ? `…${tail4(k)}` : `…${tail4(k)}`),
    file,
  };
}

module.exports = { createLogger, tail4, LEVELS };
