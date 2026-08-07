#!/usr/bin/env node
'use strict';
/**
 * gpt-router 的唯一入口。package.json 的 bin 指向这里。
 */

const { main } = require('../src/cli');

main(process.argv.slice(2))
  .then((code) => {
    // null 表示这个命令要常驻（run / _keepalive / logs -f），别退出
    if (code !== null && code !== undefined) process.exit(code);
  })
  .catch((e) => {
    process.stderr.write(`gpt-router: ${e && e.stack ? e.stack : e}\n`);
    process.exit(1);
  });
