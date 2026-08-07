'use strict';
/**
 * 配置加载：读文件 → 填默认值 → 校验 → 解析凭证 → 产出运行时用的规范化对象。
 *
 * 所有可能失败的事都在这里做完，且都在 listen() 之前。服务器拿到的是一个
 * 已经确定可用的对象，运行时不再需要判断「这个字段有没有配」。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const D = require('./defaults');
const { validate, formatReport, matchesGlob } = require('./validate');
const { loadSecrets, resolveAuthKey, expandHome, SecretsError } = require('./secrets');

/** 配置根目录。GPT_ROUTER_HOME 可覆盖，三平台一致。 */
function routerHome() {
  return process.env.GPT_ROUTER_HOME
    ? expandHome(process.env.GPT_ROUTER_HOME)
    : path.join(os.homedir(), '.gpt-router');
}

const configPathOf = (home = routerHome()) => path.join(home, 'config.json');

class ConfigError extends Error {
  constructor(message, report) {
    super(message);
    this.name = 'ConfigError';
    this.report = report;
    this.exitCode = 78; // EX_CONFIG
  }
}

/** 只在两层对象上做浅合并：用户给了就用用户的，否则用默认值。 */
function withDefaults(userValue, defaults) {
  return { ...defaults, ...(userValue || {}) };
}

function normalizeUpstream(name, raw) {
  const protocol = raw.protocol || D.UPSTREAM.protocol;
  return {
    name,
    protocol,
    host: raw.host,
    port: raw.port === undefined ? D.PORT_BY_PROTOCOL[protocol] : raw.port,
    pathPrefix: raw.pathPrefix === undefined ? D.UPSTREAM.pathPrefix : raw.pathPrefix,
  };
}

function normalizeRetry(raw) {
  const r = withDefaults(raw, D.RETRY);
  return {
    maxRetries: r.maxRetries,
    backoffMs: r.backoffMs,
    statuses: new Set(r.statuses),
    onConnectionError: r.onConnectionError,
    bodyPattern: r.bodyPattern ? new RegExp(r.bodyPattern, r.bodyPatternFlags) : null,
    bodyPatternStatuses: new Set(r.bodyPatternStatuses),
  };
}

function normalizeRoute(raw, upstreams, secrets, env) {
  const adapter = raw.adapter;
  const auth = { ...raw.auth };
  if (auth.stripClientAuth === undefined) {
    // env/secrets 模式默认剥离客户端凭证，避免把 CC 的 key 泄给第三方上游。
    auth.stripClientAuth = (auth.mode === 'env' || auth.mode === 'secrets')
      ? D.ROUTE.stripClientAuth
      : false;
  }

  const resolved = resolveAuthKey(auth, secrets, env);

  const route = {
    name: raw.name,
    isDefault: raw.default === true,
    adapter,
    upstream: upstreams[raw.upstream],
    auth,
    // 运行时凭证。mode=client 时为 null，届时从请求头取。
    key: resolved.key,
    keySource: resolved.source,
    // 声明了自带凭证但取不到值 → 命中即 503，而不是拿空 key 去打上游。
    degraded: Boolean(resolved.missing),
    degradedReason: resolved.missing,
    required: raw.required === true,

    matchPatterns: raw.match?.model || null,
    matchRegex: raw.matchRegex ? new RegExp(raw.matchRegex) : null,
    allowModels: raw.allowModels ? new Set(raw.allowModels) : null,

    retry: normalizeRetry(raw.retry),
    timeoutMs: raw.timeoutMs === undefined ? D.ROUTE.timeoutMs : raw.timeoutMs,

    countTokens: raw.countTokens === undefined
      ? D.COUNT_TOKENS_BY_ADAPTER[adapter]
      : raw.countTokens,
    estimateBytesPerToken: raw.estimateBytesPerToken === undefined
      ? D.RESPONSES.estimateBytesPerToken
      : raw.estimateBytesPerToken,
  };

  if (adapter === 'passthrough') {
    route.bodyOverrides = raw.bodyOverrides || null;
    route.bodyOverridePaths = raw.bodyOverridePaths || null;
  } else {
    route.requestPath = raw.requestPath === undefined ? D.RESPONSES.requestPath : raw.requestPath;
    route.modelMap = raw.modelMap || {};
    route.reasoningSummary = raw.reasoningSummary === undefined
      ? D.RESPONSES.reasoningSummary
      : raw.reasoningSummary;
    route.synthesizeStreamBoundaries = raw.synthesizeStreamBoundaries === undefined
      ? D.RESPONSES.synthesizeStreamBoundaries
      : raw.synthesizeStreamBoundaries;
  }

  return route;
}

/** 这条路由收不收这个模型名。 */
function routeAccepts(route, model) {
  if (route.isDefault) return true;
  if (route.matchRegex) return route.matchRegex.test(model);
  if (route.matchPatterns) return route.matchPatterns.some((p) => matchesGlob(model, p));
  return false;
}

/**
 * 从磁盘加载并规范化配置。
 *
 * @param {object} [opts]
 * @param {string} [opts.configPath] 配置文件路径，默认 ~/.gpt-router/config.json
 * @param {Record<string,string>} [opts.env] 环境变量，测试时可注入
 * @returns {object} 规范化后的运行时配置
 * @throws {ConfigError} 文件缺失、JSON 语法错误、或校验不通过
 */
function loadConfig(opts = {}) {
  const home = routerHome();
  const configPath = opts.configPath ? expandHome(opts.configPath) : configPathOf(home);
  const env = opts.env || process.env;

  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') {
      throw new ConfigError(
        `找不到配置文件：${configPath}`,
        `\ngpt-router: 还没有配置文件（${configPath}）\n\n`
        + '跑 gpt-router install 会从模板生成一份，或者手动把 config.example.json 复制过去。\n',
      );
    }
    throw new ConfigError(`读取 ${configPath} 失败：${e.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new ConfigError(
      `${configPath} 不是合法 JSON`,
      `\ngpt-router: 配置文件语法错误（${configPath}）\n\n  ${e.message}\n\n`
      + '常见原因：多余的逗号、缺引号、注释没删。JSON 不支持注释。\n',
    );
  }

  const result = validate(parsed);
  if (result.errors.length) {
    throw new ConfigError(`配置校验失败（${result.errors.length} 个问题）`, formatReport(result, configPath));
  }

  // secrets 要在校验通过后读——校验失败时没必要碰凭证文件。
  const secretsPath = parsed.secretsFile || path.join(home, 'secrets.json');
  let secretsResult;
  try {
    secretsResult = loadSecrets(secretsPath);
  } catch (e) {
    if (e instanceof SecretsError) {
      throw new ConfigError(e.message, `\ngpt-router: ${e.message}\n${e.fix ? `\n  → ${e.fix}\n` : ''}`);
    }
    throw e;
  }

  const upstreams = {};
  for (const [name, up] of Object.entries(parsed.upstreams || {})) {
    upstreams[name] = normalizeUpstream(name, up);
  }

  const routes = parsed.routes.map((r) => normalizeRoute(r, upstreams, secretsResult.values, env));

  // V19：声明 required 的路由取不到凭证 → 启动直接失败，而不是静默 degraded。
  const fatal = routes.filter((r) => r.degraded && r.required);
  if (fatal.length) {
    const lines = fatal.map((r) => `  路由 "${r.name}"：${r.degradedReason}`);
    throw new ConfigError(
      '必需的凭证缺失',
      `\ngpt-router: 以下路由声明了 required:true 但凭证取不到\n\n${lines.join('\n')}\n\n`
      + '补上凭证，或把该路由的 required 改成 false（届时命中会返回 503）。\n',
    );
  }

  const listen = withDefaults(parsed.listen, D.LISTEN);

  // 日志默认跟随实际 home，而不是写死的 ~/.gpt-router。
  //
  // config.example.json 里 log.file 是字面量 "~/.gpt-router/router.log"，
  // 而 ~ 只展开成 homedir，不认 GPT_ROUTER_HOME。照搬那个值的话，任何自定义
  // home 的实例都会把日志写进默认目录——多实例互相污染，隔离测试也会在
  // 真实目录里留下文件。所以示例里那个值等价于"用默认位置"，按实际 home 解析。
  const log = withDefaults(parsed.log, D.LOG);
  if (log.file === D.LOG.file) {
    log.file = path.join(home, 'router.log');
  }
  const builtins = {
    ...withDefaults(parsed.builtins, { stripModelSuffix: D.BUILTINS.stripModelSuffix, healthz: D.BUILTINS.healthz }),
    domainInfo: withDefaults(parsed.builtins?.domainInfo, D.BUILTINS.domainInfo),
  };

  const warnings = [
    ...result.warnings.map((w) => `${w.pointer || '/'} ${w.message}`),
    ...secretsResult.warnings,
    ...routes.filter((r) => r.degraded).map((r) => `路由 "${r.name}" 不可用：${r.degradedReason}（命中时返回 503）`),
  ];

  return {
    configPath,
    home,
    version: parsed.version,
    listen,
    log: { ...log, file: expandHome(log.file) },
    builtins,
    secretsPath: secretsResult.path,
    upstreams,
    routes,
    defaultRoute: routes.find((r) => r.isDefault),
    warnings,
    /** 按模型名选路：数组顺序即优先级，首个命中生效。 */
    pickRoute(model) {
      for (const route of routes) {
        if (!route.isDefault && routeAccepts(route, model)) return route;
      }
      return this.defaultRoute;
    },
  };
}

module.exports = { loadConfig, routerHome, configPathOf, routeAccepts, ConfigError, expandHome };
