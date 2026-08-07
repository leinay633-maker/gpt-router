#!/usr/bin/env node
'use strict';
/**
 * 测试入口。
 *
 * 为什么不直接 `node --test "test/**\/*.test.js"`：glob 模式是 Node 21 才支持的，
 * 而这个项目声明兼容 Node 18。在 18/20 上那句会报
 * "Could not find '.../test/**\/*.test.js'" —— 是 CI 抓到的，本地跑的是新版 node
 * 所以一直没暴露。
 *
 * 自己枚举文件再交给 node --test，各版本行为一致。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const TEST_DIR = __dirname;

const files = fs.readdirSync(TEST_DIR)
  .filter((f) => f.endsWith('.test.js'))
  .sort()
  .map((f) => path.join(TEST_DIR, f));

if (!files.length) {
  console.error('test/ 下没有找到 *.test.js');
  process.exit(1);
}

const extra = process.argv.slice(2);
const child = spawn(process.execPath, ['--test', ...extra, ...files], {
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
