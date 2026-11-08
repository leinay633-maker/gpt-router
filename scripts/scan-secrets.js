#!/usr/bin/env node
/**
 * scan-secrets —— 发布前凭证自查。
 *
 * 防止真实的 API key、本机用户名和内网地址跟着代码进仓库。
 *
 * 用法：
 *   node scripts/scan-secrets.js            扫所有 git 跟踪的文件
 *   node scripts/scan-secrets.js --staged   只扫已暂存内容（pre-commit hook 用）
 *   node scripts/scan-secrets.js --all      扫工作区全部文件（含未跟踪，跳过 .gitignore 命中项）
 *   node scripts/scan-secrets.js --history  扫全部提交历史（发布前最后一道）
 *
 * 命中即退出码 1，并打印文件、行号、脱敏后的上下文。
 */
'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');

// 扫描器自身必然包含这些模式的字面量，否则无法描述它们；扫的时候跳过自己。
const SELF = path.relative(REPO, __filename).replace(/\\/g, '/');

/**
 * 每条规则：name 说明、re 正则、hint 命中后该怎么办。
 *
 * 设计取向：宁可precise也不要宽泛到被人关掉。例如不用裸 `Bearer`
 * ——文档里描述鉴权头时会正常出现这个词——而是要求它后面跟着足够长的
 * token 才算命中。占位符（sk-...、<your-key>）因此天然不会误报。
 */
const RULES = [
  {
    name: 'api-key-sk',
    re: /\bsk-[A-Za-z0-9_-]{16,}/g,
    hint: '看起来是真实 API key。移到 secrets.json（已被 .gitignore 忽略），代码里用 auth.secretKey 引用。',
  },
  {
    name: 'bearer-token',
    re: /\bBearer\s+[A-Za-z0-9._-]{16,}/g,
    hint: '硬编码的 Bearer token。鉴权凭证只能来自 secrets.json 或环境变量。',
  },
  {
    name: 'github-token',
    re: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}/g,
    hint: 'GitHub token。立刻在 GitHub 设置里吊销，再从文件里删掉。',
  },
  {
    name: 'slack-token',
    re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
    hint: 'Slack token。立刻吊销。',
  },
  {
    name: 'private-key-block',
    re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g,
    hint: '私钥。绝不入库。',
  },
];

/**
 * 本机用户名、自己用的上游、公司内网域名这类词不能写进这个公开文件，否则扫描器本身就把它们公开了。
 * 写进 scripts/.scan-secrets.local（已被 .gitignore 忽略）：一行一个正则，不分大小写，# 开头是注释。
 * 没有这个文件时只跑上面的通用规则，比如在 CI 上。
 */
function loadLocalRules() {
  let text;
  try {
    text = fs.readFileSync(path.join(__dirname, '.scan-secrets.local'), 'utf8');
  } catch {
    return [];
  }
  return text.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => ({ name: 'local-list', re: new RegExp(line, 'gi'), hint: '命中本机词表 scripts/.scan-secrets.local。' }));
}

RULES.push(...loadLocalRules());

const MAX_BYTES = 2 * 1024 * 1024; // 超过就当二进制/生成物跳过

function git(args) {
  return execFileSync('git', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function listFiles(mode) {
  if (mode === 'staged') {
    return git(['diff', '--cached', '--name-only', '--diff-filter=ACMR']).split('\n').filter(Boolean);
  }
  if (mode === 'all') {
    // -c 跟踪的 + -o 未跟踪的，--exclude-standard 让 .gitignore 生效
    return git(['ls-files', '-co', '--exclude-standard']).split('\n').filter(Boolean);
  }
  return git(['ls-files']).split('\n').filter(Boolean);
}

/** 暂存内容可能与工作区不同；pre-commit 必须看将要提交的那份。 */
function readStaged(file) {
  try {
    return execFileSync('git', ['show', `:${file}`], { cwd: REPO, encoding: 'utf8', maxBuffer: MAX_BYTES });
  } catch {
    return null;
  }
}

function readWorktree(file) {
  const abs = path.join(REPO, file);
  try {
    if (fs.statSync(abs).size > MAX_BYTES) return null;
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

// 用转义写法而不是字面 NUL 字节：后者会让 git 把这个文件本身判成二进制，
// 于是它的 diff 就再也看不见了。
const NUL = String.fromCharCode(0);
const looksBinary = (text) => text.includes(NUL);

/** 命中内容只显示首尾各 4 字符，避免把密钥又抄进 CI 日志一遍。 */
function mask(hit) {
  if (hit.length <= 12) return hit;
  return `${hit.slice(0, 4)}…${hit.slice(-4)} (${hit.length} 字符)`;
}

function scanText(file, text, findings) {
  if (looksBinary(text)) return;
  const lines = text.split(/\r?\n/);
  for (const rule of RULES) {
    for (let i = 0; i < lines.length; i++) {
      rule.re.lastIndex = 0;
      let m;
      while ((m = rule.re.exec(lines[i])) !== null) {
        findings.push({ file, line: i + 1, rule: rule.name, hit: m[0], hint: rule.hint });
        if (m[0].length === 0) break; // 防御零宽匹配死循环
      }
    }
  }
}

function scanHistory(findings) {
  const revs = git(['rev-list', '--all']).split('\n').filter(Boolean);
  if (!revs.length) return;
  for (const rev of revs) {
    let patch;
    try {
      patch = execFileSync('git', ['show', '--format=', '--unified=0', rev], {
        cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      });
    } catch {
      continue;
    }
    // 只看新增行，删除行说明已经清理过了
    const added = patch.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'));
    scanText(`commit ${rev.slice(0, 8)}`, added.join('\n'), findings);
  }
}

function main() {
  const argv = process.argv.slice(2);
  const mode = argv.includes('--staged') ? 'staged'
    : argv.includes('--all') ? 'all'
    : argv.includes('--history') ? 'history'
    : 'tracked';

  const findings = [];

  if (mode === 'history') {
    scanHistory(findings);
  } else {
    for (const file of listFiles(mode)) {
      if (file === SELF) continue;
      const text = mode === 'staged' ? readStaged(file) : readWorktree(file);
      if (text === null) continue;
      scanText(file, text, findings);
    }
  }

  if (!findings.length) {
    console.log(`scan-secrets: 干净（模式 ${mode}，${RULES.length} 条规则）`);
    return 0;
  }

  console.error(`\nscan-secrets: 发现 ${findings.length} 处可疑内容（模式 ${mode}）\n`);
  const byRule = new Map();
  for (const f of findings) {
    if (!byRule.has(f.rule)) byRule.set(f.rule, []);
    byRule.get(f.rule).push(f);
  }
  for (const [rule, list] of byRule) {
    console.error(`  [${rule}] ${list[0].hint}`);
    for (const f of list.slice(0, 20)) {
      console.error(`      ${f.file}:${f.line}  ${mask(f.hit)}`);
    }
    if (list.length > 20) console.error(`      …另有 ${list.length - 20} 处`);
    console.error('');
  }
  console.error('提交已中止。确认为误报可加 --no-verify 跳过，但请先真的确认过。\n');
  return 1;
}

process.exit(main());
