'use strict';
/**
 * 三个平台模块共用的小工具。
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

/** 极简模板渲染：{{KEY}} → value。不引模板引擎，零依赖是硬约束。 */
function render(templateName, vars) {
  const file = path.join(__dirname, 'templates', templateName);
  let text = fs.readFileSync(file, 'utf8');
  for (const [k, v] of Object.entries(vars)) {
    text = text.replaceAll(`{{${k}}}`, String(v));
  }
  const leftover = text.match(/\{\{[A-Z_]+\}\}/g);
  if (leftover) {
    // 模板占位符没填全就写出去，故障会推迟到服务启动时才暴露，很难查。
    throw new Error(`模板 ${templateName} 有未替换的占位符：${leftover.join(', ')}`);
  }
  return text;
}

/** 写文件并确保父目录存在。 */
function writeFile(target, content, mode) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, mode ? { mode } : undefined);
  return target;
}

function removeFile(target) {
  try {
    fs.unlinkSync(target);
    return true;
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
}

/**
 * 跑一个外部命令。
 * 不抛异常，把结果交给调用方判断——安装流程里很多命令"失败也能继续"
 * （比如卸载时目标本来就不存在）。
 */
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, ...opts }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err ? (err.code ?? 1) : 0,
        stdout: (stdout || '').trim(),
        stderr: (stderr || '').trim(),
        error: err || null,
      });
    });
  });
}

/** 日志文件路径。stdout/stderr 分开，便于区分"服务自己的日志"和"崩溃栈"。 */
function logPaths(ctx) {
  return {
    stdout: path.join(ctx.home, 'supervisor.out.log'),
    stderr: path.join(ctx.home, 'supervisor.err.log'),
  };
}

module.exports = { render, writeFile, removeFile, run, logPaths };
