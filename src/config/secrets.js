'use strict';
/**
 * secrets 读取。
 *
 * 凭证只有三个来源：客户端请求自带、环境变量、这个文件。文件格式是扁平 KV，
 * 不嵌套——嵌套只会让「凭证到底从哪来的」这个问题更难回答。
 *
 * 与原实现的一处有意差异：原来 JSON 解析失败会静默降级成 {}（见旧
 * gpt-router.js:41-44），症状是路由莫名返回 503，极难查。这里改成硬报错。
 * 文件不存在则不是错误——只有当某条路由真的引用了 secrets 时才由校验层追究。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** 展开 ~ 前缀。三平台一致，不用 %APPDATA%。 */
function expandHome(p) {
  if (typeof p !== 'string') return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

class SecretsError extends Error {
  constructor(message, fix) {
    super(message);
    this.name = 'SecretsError';
    this.fix = fix;
  }
}

/**
 * 读 secrets 文件。
 * @returns {{values: Record<string,string>, warnings: string[], exists: boolean}}
 */
function loadSecrets(secretsPath) {
  const abs = expandHome(secretsPath);
  const warnings = [];

  let raw;
  try {
    raw = fs.readFileSync(abs, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') {
      return { values: {}, warnings, exists: false, path: abs };
    }
    if (e.code === 'EACCES') {
      throw new SecretsError(`无权读取 ${abs}`, '检查文件权限。');
    }
    throw new SecretsError(`读取 ${abs} 失败：${e.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    // 静默降级会变成「莫名 503」，所以这里必须硬失败。
    throw new SecretsError(
      `${abs} 不是合法 JSON：${e.message}`,
      '修好 JSON 语法。格式是扁平的键值对，例如 {"DEEPSEEK_KEY": "sk-..."}。',
    );
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SecretsError(
      `${abs} 的内容必须是一个对象`,
      '格式是扁平的键值对，例如 {"DEEPSEEK_KEY": "sk-..."}。',
    );
  }

  const values = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v !== 'string') {
      throw new SecretsError(
        `${abs} 里 "${k}" 的值不是字符串`,
        '所有凭证都必须是字符串。',
      );
    }
    if (v.length === 0) {
      warnings.push(`secrets.json 里 "${k}" 是空字符串，引用它的路由会被标记为不可用`);
      continue;
    }
    values[k] = v;
  }

  // POSIX 上提醒过宽的权限。Windows 用 ACL，模式位没意义，跳过。
  if (process.platform !== 'win32') {
    try {
      const mode = fs.statSync(abs).mode & 0o777;
      if (mode & 0o077) {
        warnings.push(
          `${abs} 的权限是 ${mode.toString(8)}，同机其他用户可读。建议 chmod 600。`,
        );
      }
    } catch {
      // 权限查不到不影响功能
    }
  }

  return { values, warnings, exists: true, path: abs };
}

/**
 * 按路由的 auth 配置解析出该用的凭证。
 *
 * 返回 null 表示「这条路由声明了自带凭证，但值取不到」——调用方据此把路由
 * 标记为 degraded，命中时返回 503，而不是拿空 key 去打上游。
 *
 * @param {object} auth 路由的 auth 配置
 * @param {Record<string,string>} secrets loadSecrets 的 values
 * @param {Record<string,string|undefined>} env 环境变量，默认 process.env
 * @returns {{key: string|null, source: string, missing: string|null}}
 */
function resolveAuthKey(auth, secrets, env = process.env) {
  switch (auth.mode) {
    case 'client':
      // 运行时才从请求头拿，配置期没有值可解析。
      return { key: null, source: 'client', missing: null };
    case 'none':
      return { key: null, source: 'none', missing: null };
    case 'env': {
      const v = env[auth.envVar];
      return v
        ? { key: v, source: `env:${auth.envVar}`, missing: null }
        : { key: null, source: `env:${auth.envVar}`, missing: `环境变量 ${auth.envVar} 未设置` };
    }
    case 'secrets': {
      const v = secrets[auth.secretKey];
      return v
        ? { key: v, source: `secrets:${auth.secretKey}`, missing: null }
        : { key: null, source: `secrets:${auth.secretKey}`, missing: `secrets.json 里没有 "${auth.secretKey}"` };
    }
    default:
      // 校验层已挡住非法 mode，走到这里说明是内部错误。
      return { key: null, source: 'unknown', missing: `未知的 auth.mode: ${auth.mode}` };
  }
}

module.exports = { loadSecrets, resolveAuthKey, expandHome, SecretsError };
