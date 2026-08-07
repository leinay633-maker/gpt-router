#!/usr/bin/env node
/**
 * verify-no-deps —— 把「零依赖」从口头承诺变成 CI 会红的断言。
 *
 * 零依赖是这个项目的实质优点：装机不需要 npm install，
 * 没有供应链面，node 装好就能跑。这种性质一旦破掉很难找回来，
 * 所以在 CI 里挡住，而不是靠 code review 时想起来。
 *
 * 检查三件事：
 *   1. package.json 的 dependencies / optionalDependencies / peerDependencies 为空
 *   2. package-lock.json（若存在）除根条目外没有别的包
 *   3. src/ 与 bin/ 里没有 require 非内置模块
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { builtinModules } = require('node:module');

const REPO = path.resolve(__dirname, '..');
const errors = [];

// ── 1. package.json ──
const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
  const names = Object.keys(pkg[field] || {});
  if (names.length) {
    errors.push(`package.json 的 ${field} 非空：${names.join(', ')}`);
  }
}

// ── 2. package-lock.json ──
const lockPath = path.join(REPO, 'package-lock.json');
if (fs.existsSync(lockPath)) {
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  const entries = Object.keys(lock.packages || {}).filter((k) => k !== '');
  if (entries.length) {
    errors.push(`package-lock.json 含 ${entries.length} 个第三方包：${entries.slice(0, 5).join(', ')}${entries.length > 5 ? ' …' : ''}`);
  }
}

// ── 3. 源码里的 require ──
const BUILTIN = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

function* walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(abs);
    else if (entry.name.endsWith('.js')) yield abs;
  }
}

const REQUIRE_RE = /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;

for (const dir of ['src', 'bin']) {
  for (const file of walk(path.join(REPO, dir))) {
    const text = fs.readFileSync(file, 'utf8');
    REQUIRE_RE.lastIndex = 0;
    let m;
    while ((m = REQUIRE_RE.exec(text)) !== null) {
      const spec = m[1];
      const isRelative = spec.startsWith('./') || spec.startsWith('../');
      if (isRelative || BUILTIN.has(spec)) continue;
      const line = text.slice(0, m.index).split('\n').length;
      errors.push(`${path.relative(REPO, file).replace(/\\/g, '/')}:${line} require 了非内置模块 '${spec}'`);
    }
  }
}

if (errors.length) {
  console.error('\nverify-no-deps: 零依赖约束被破坏\n');
  for (const e of errors) console.error(`  ${e}`);
  console.error('\ngpt-router 只使用 node 内置模块。如果确实需要新能力，请自行实现或重新考虑设计。\n');
  process.exit(1);
}

console.log('verify-no-deps: 通过（零第三方依赖）');
