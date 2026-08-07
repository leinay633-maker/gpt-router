'use strict';
/**
 * 配置校验器。纯函数：吃一个已解析的对象，吐 {errors, warnings} 数组。
 * 不读文件、不碰网络、不退出进程——这样才能单测。
 *
 * 设计原则：配置写错要在启动时就报清楚，而不是运行到某条路由时才炸。
 * 所以未知字段一律报错（拼错字段名是最高发的错误，静默忽略会退化成运行时故障），
 * 且一次性收集所有问题后统一打印，而不是撞到第一个就退。
 *
 * 每条错误带 JSON Pointer 定位和修复建议。
 */

const D = require('./defaults');

// ── 各层允许的字段。未知字段报错时用这些集合算「你是不是想写 X」。 ──
const ROOT_KEYS = new Set(['$schema', 'version', 'listen', 'log', 'secretsFile', 'builtins', 'upstreams', 'routes']);
const LISTEN_KEYS = new Set(['host', 'port', 'guardOrigin', 'requireToken', 'allowNonLoopback']);
const LOG_KEYS = new Set(['file', 'level', 'maskKeys', 'logBodies']);
const BUILTINS_KEYS = new Set(['stripModelSuffix', 'healthz', 'domainInfo']);
const DOMAIN_INFO_KEYS = new Set(['enabled', 'host', 'timeoutMs', 'failOpen']);
const UPSTREAM_KEYS = new Set(['protocol', 'host', 'port', 'pathPrefix']);
const AUTH_KEYS = new Set(['mode', 'envVar', 'secretKey', 'header', 'stripClientAuth', 'iKnowThisLeaksMyClientKey']);
const RETRY_KEYS = new Set(['maxRetries', 'backoffMs', 'statuses', 'onConnectionError', 'bodyPattern', 'bodyPatternStatuses', 'bodyPatternFlags']);
const ROUTE_KEYS = new Set([
  'name', 'default', 'match', 'matchRegex', 'adapter', 'upstream', 'auth',
  'allowModels', 'bodyOverrides', 'bodyOverridePaths', 'retry', 'timeoutMs',
  'countTokens', 'estimateBytesPerToken', 'required',
  // responses 专属
  'requestPath', 'modelMap', 'reasoningSummary', 'synthesizeStreamBoundaries',
]);
const RESPONSES_ONLY = ['requestPath', 'modelMap', 'reasoningSummary', 'synthesizeStreamBoundaries'];
const PASSTHROUGH_ONLY = ['bodyOverrides', 'bodyOverridePaths'];

/** Levenshtein 距离，用于「你是不是想写 X」建议。只在报错路径上跑，不在意性能。 */
function editDistance(a, b) {
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[n];
}

function suggest(unknown, allowed) {
  let best = null, bestDist = Infinity;
  for (const cand of allowed) {
    const d = editDistance(unknown.toLowerCase(), cand.toLowerCase());
    if (d < bestDist) { bestDist = d; best = cand; }
  }
  // 距离过大时不瞎猜；阈值随字段名长度放宽
  return bestDist <= Math.max(2, Math.floor(unknown.length / 3)) ? best : null;
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v) => Number.isInteger(v);
const isBool = (v) => typeof v === 'boolean';
const isNonEmptyString = (v) => typeof v === 'string' && v.length > 0;

class Ctx {
  constructor() {
    this.errors = [];
    this.warnings = [];
  }
  err(pointer, message, fix) {
    this.errors.push({ pointer, message, fix });
  }
  warn(pointer, message, fix) {
    this.warnings.push({ pointer, message, fix });
  }
  /** V2：未知字段一律报错，附最相近的合法名。 */
  unknownKeys(pointer, obj, allowed) {
    for (const key of Object.keys(obj)) {
      if (allowed.has(key)) continue;
      const hint = suggest(key, allowed);
      this.err(
        `${pointer}/${key}`,
        '未知字段',
        hint ? `你是不是想写 "${hint}"？` : `合法字段：${[...allowed].join(', ')}`,
      );
    }
  }
  type(pointer, value, pred, expected, fix) {
    if (value === undefined) return false;
    if (!pred(value)) {
      this.err(pointer, `类型应为 ${expected}，实际是 ${Array.isArray(value) ? 'array' : typeof value}`, fix);
      return false;
    }
    return true;
  }
  enum(pointer, value, allowed, fix) {
    if (value === undefined) return false;
    if (!allowed.includes(value)) {
      const hint = typeof value === 'string' ? suggest(value, new Set(allowed)) : null;
      this.err(
        pointer,
        `取值必须是 ${allowed.map((v) => JSON.stringify(v)).join(' | ')}，实际是 ${JSON.stringify(value)}`,
        hint ? `你是不是想写 "${hint}"？` : fix,
      );
      return false;
    }
    return true;
  }
}

/** V16：递归扫描所有字符串值，禁止凭证出现在 config.json 里。 */
function scanCredentials(ctx, node, pointer) {
  if (typeof node === 'string') {
    if (D.CREDENTIAL_VALUE_RE.test(node)) {
      ctx.err(pointer, '这个值看起来是一个凭证',
        '凭证不能写在 config.json 里。请放进 secretsFile 指向的 secrets.json，然后用 auth.secretKey 引用。');
    }
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => scanCredentials(ctx, v, `${pointer}/${i}`));
    return;
  }
  if (isPlainObject(node)) {
    for (const [k, v] of Object.entries(node)) {
      // 敏感键名下不允许出现字符串值（布尔开关如 requireToken 不算）
      if (typeof v === 'string' && D.CREDENTIAL_KEY_NAMES.has(k.toLowerCase())) {
        ctx.err(`${pointer}/${k}`, `字段名 "${k}" 暗示这里存放凭证`,
          '凭证不能写在 config.json 里。改用 auth.mode="secrets" + auth.secretKey，把值放到 secrets.json。');
      }
      scanCredentials(ctx, v, `${pointer}/${k}`);
    }
  }
}

function validateListen(ctx, listen) {
  if (listen === undefined) return;
  if (!ctx.type('/listen', listen, isPlainObject, 'object')) return;
  ctx.unknownKeys('/listen', listen, LISTEN_KEYS);

  const host = listen.host === undefined ? D.LISTEN.host : listen.host;
  const allowNonLoopback = listen.allowNonLoopback === undefined ? D.LISTEN.allowNonLoopback : listen.allowNonLoopback;
  const requireToken = listen.requireToken === undefined ? D.LISTEN.requireToken : listen.requireToken;

  ctx.type('/listen/guardOrigin', listen.guardOrigin, isBool, 'boolean');
  ctx.type('/listen/requireToken', listen.requireToken, isBool, 'boolean');
  ctx.type('/listen/allowNonLoopback', listen.allowNonLoopback, isBool, 'boolean');

  // V17：必须监听回环。非回环需要同时解锁并开启令牌校验。
  if (ctx.type('/listen/host', listen.host, isNonEmptyString, 'string')) {
    if (!D.LOOPBACK_HOSTS.has(host) && !allowNonLoopback) {
      ctx.err('/listen/host', `"${host}" 不是回环地址`,
        '监听非回环地址会把你的上游额度暴露给整个网络。确实需要请同时设 listen.allowNonLoopback=true 与 listen.requireToken=true。');
    }
  }
  if (allowNonLoopback && !requireToken) {
    ctx.err('/listen/allowNonLoopback', '解锁了非回环监听但没有开启令牌校验',
      '设 listen.requireToken=true，并在 secrets.json 里放 ROUTER_TOKEN。');
  }

  // V18：低端口在三平台都需要特权，直接挡掉。
  if (ctx.type('/listen/port', listen.port, isInt, 'integer')) {
    if (listen.port < 1024 || listen.port > 65535) {
      ctx.err('/listen/port', `端口 ${listen.port} 超出允许范围`, '请使用 1024–65535 之间的端口（低端口需要管理员权限）。');
    }
  }
}

function validateLog(ctx, log) {
  if (log === undefined) return;
  if (!ctx.type('/log', log, isPlainObject, 'object')) return;
  ctx.unknownKeys('/log', log, LOG_KEYS);
  ctx.type('/log/file', log.file, isNonEmptyString, 'string');
  ctx.enum('/log/level', log.level, D.LOG_LEVELS);
  ctx.type('/log/maskKeys', log.maskKeys, isBool, 'boolean');
  if (ctx.type('/log/logBodies', log.logBodies, isBool, 'boolean') && log.logBodies === true) {
    ctx.warn('/log/logBodies', '已开启请求体日志，你的 prompt 会被明文写入日志文件',
      '仅用于临时调试，排查完请关掉。');
  }
}

function validateBuiltins(ctx, builtins) {
  if (builtins === undefined) return;
  if (!ctx.type('/builtins', builtins, isPlainObject, 'object')) return;
  ctx.unknownKeys('/builtins', builtins, BUILTINS_KEYS);
  ctx.type('/builtins/stripModelSuffix', builtins.stripModelSuffix, isBool, 'boolean');
  ctx.type('/builtins/healthz', builtins.healthz, isBool, 'boolean');

  const di = builtins.domainInfo;
  if (di === undefined) return;
  if (!ctx.type('/builtins/domainInfo', di, isPlainObject, 'object')) return;
  ctx.unknownKeys('/builtins/domainInfo', di, DOMAIN_INFO_KEYS);
  ctx.type('/builtins/domainInfo/enabled', di.enabled, isBool, 'boolean');
  ctx.type('/builtins/domainInfo/failOpen', di.failOpen, isBool, 'boolean');
  if (ctx.type('/builtins/domainInfo/host', di.host, isNonEmptyString, 'string')) {
    checkBareHost(ctx, '/builtins/domainInfo/host', di.host);
  }
  if (ctx.type('/builtins/domainInfo/timeoutMs', di.timeoutMs, isInt, 'integer') && di.timeoutMs <= 0) {
    ctx.err('/builtins/domainInfo/timeoutMs', '必须是正整数');
  }
}

/** V10：host 必须是裸主机名。填 "https://api.x.com" 是最常见的错误，专门检出并给改法。 */
function checkBareHost(ctx, pointer, host) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(host)) {
    const bare = host.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/.*$/, '');
    ctx.err(pointer, `不能包含协议前缀："${host}"`,
      `改成 "${bare}"，协议写在同级的 "protocol" 字段里。`);
    return false;
  }
  if (host.includes('/')) {
    ctx.err(pointer, `不能包含路径："${host}"`, '路径请写在 "pathPrefix" 字段里。');
    return false;
  }
  return true;
}

function validateUpstreams(ctx, upstreams) {
  if (upstreams === undefined) return new Set();
  if (!ctx.type('/upstreams', upstreams, isPlainObject, 'object')) return new Set();

  const names = new Set();
  for (const [name, up] of Object.entries(upstreams)) {
    const p = `/upstreams/${name}`;
    names.add(name);
    if (!ctx.type(p, up, isPlainObject, 'object')) continue;
    ctx.unknownKeys(p, up, UPSTREAM_KEYS);

    if (up.host === undefined) {
      ctx.err(`${p}/host`, '必填字段缺失', '填上游主机名，例如 "api.anthropic.com"。');
    } else if (ctx.type(`${p}/host`, up.host, isNonEmptyString, 'string')) {
      checkBareHost(ctx, `${p}/host`, up.host);
    }

    ctx.enum(`${p}/protocol`, up.protocol, D.PROTOCOLS);

    if (ctx.type(`${p}/port`, up.port, isInt, 'integer') && (up.port < 1 || up.port > 65535)) {
      ctx.err(`${p}/port`, `端口 ${up.port} 超出 1–65535`);
    }

    if (ctx.type(`${p}/pathPrefix`, up.pathPrefix, (v) => typeof v === 'string', 'string') && up.pathPrefix) {
      if (!up.pathPrefix.startsWith('/')) {
        ctx.err(`${p}/pathPrefix`, `"${up.pathPrefix}" 必须以 "/" 开头`);
      }
      if (up.pathPrefix.endsWith('/')) {
        ctx.err(`${p}/pathPrefix`, `"${up.pathPrefix}" 不能以 "/" 结尾`, '路径拼接时会自动加分隔符。');
      }
    }
  }
  return names;
}

function validateAuth(ctx, auth, pointer) {
  if (auth === undefined) {
    // V12：auth 必填，且 mode 不给默认值——安全语义不能隐式。
    ctx.err(pointer, '必填字段缺失',
      '每条路由都必须显式声明鉴权方式，例如 {"mode":"client","header":"inherit"}。');
    return null;
  }
  if (!ctx.type(pointer, auth, isPlainObject, 'object')) return null;
  ctx.unknownKeys(pointer, auth, AUTH_KEYS);

  if (auth.mode === undefined) {
    ctx.err(`${pointer}/mode`, '必填字段缺失',
      `取值之一：${D.AUTH_MODES.join(' | ')}。client=复用客户端凭证，env=从环境变量读，secrets=从 secrets.json 读，none=不带鉴权。`);
    return null;
  }
  if (!ctx.enum(`${pointer}/mode`, auth.mode, D.AUTH_MODES)) return null;

  const mode = auth.mode;

  // V13：mode 与其参数必须配套，多余的参数说明用户搞混了模式。
  if (mode === 'env' && !isNonEmptyString(auth.envVar)) {
    ctx.err(`${pointer}/envVar`, 'mode="env" 缺少 envVar', '填环境变量名，例如 "MY_UPSTREAM_KEY"。');
  }
  if (mode === 'secrets' && !isNonEmptyString(auth.secretKey)) {
    ctx.err(`${pointer}/secretKey`, 'mode="secrets" 缺少 secretKey', '填 secrets.json 里的键名，例如 "DEEPSEEK_KEY"。');
  }
  if (mode !== 'env' && auth.envVar !== undefined) {
    ctx.err(`${pointer}/envVar`, `mode="${mode}" 不使用 envVar`, '删掉它，或把 mode 改成 "env"。');
  }
  if (mode !== 'secrets' && auth.secretKey !== undefined) {
    ctx.err(`${pointer}/secretKey`, `mode="${mode}" 不使用 secretKey`, '删掉它，或把 mode 改成 "secrets"。');
  }

  ctx.enum(`${pointer}/header`, auth.header, D.AUTH_HEADERS);

  // V14：自带凭证却不说放哪个头是无意义的。
  if ((mode === 'env' || mode === 'secrets') && auth.header === 'inherit') {
    ctx.err(`${pointer}/header`, `mode="${mode}" 不能配 header="inherit"`,
      '既然用自己的凭证，就要指明放在哪个头里："authorization"（Bearer）或 "x-api-key"。');
  }

  // V15：这是把用户的 Claude Code 凭证泄给第三方上游的唯一路径，值得一道显式闸门。
  if (ctx.type(`${pointer}/stripClientAuth`, auth.stripClientAuth, isBool, 'boolean')) {
    if ((mode === 'env' || mode === 'secrets') && auth.stripClientAuth === false
        && auth.iKnowThisLeaksMyClientKey !== true) {
      ctx.err(`${pointer}/stripClientAuth`, '关闭它会把客户端凭证一起转发给这个上游',
        '这会让上游同时看到你的 Claude Code key。确实需要请显式加 "iKnowThisLeaksMyClientKey": true。');
    }
  }
  return mode;
}

function validateRetry(ctx, retry, pointer) {
  if (retry === undefined) return;
  if (!ctx.type(pointer, retry, isPlainObject, 'object')) return;
  ctx.unknownKeys(pointer, retry, RETRY_KEYS);

  const maxRetries = retry.maxRetries === undefined ? D.RETRY.maxRetries : retry.maxRetries;
  if (ctx.type(`${pointer}/maxRetries`, retry.maxRetries, isInt, 'integer') && retry.maxRetries < 0) {
    ctx.err(`${pointer}/maxRetries`, '不能为负数', '设 0 表示不重试。');
  }

  // V21：退避数组必须够长，否则运行时要靠隐式兜底值。
  if (ctx.type(`${pointer}/backoffMs`, retry.backoffMs, Array.isArray, 'array')) {
    if (retry.backoffMs.some((v) => !isInt(v) || v < 0)) {
      ctx.err(`${pointer}/backoffMs`, '所有元素必须是非负整数（毫秒）');
    }
    if (isInt(maxRetries) && retry.backoffMs.length < maxRetries + 1) {
      ctx.err(`${pointer}/backoffMs`,
        `长度 ${retry.backoffMs.length} 不足以覆盖 maxRetries=${maxRetries}`,
        `需要至少 ${maxRetries + 1} 个元素（下标 0 是首次尝试，不退避）。`);
    }
  }

  for (const field of ['statuses', 'bodyPatternStatuses']) {
    const v = retry[field];
    if (v === undefined) continue;
    if (!ctx.type(`${pointer}/${field}`, v, Array.isArray, 'array')) continue;
    if (v.some((s) => !isInt(s) || s < 400 || s > 599)) {
      ctx.err(`${pointer}/${field}`, '所有元素必须是 400–599 之间的整数状态码');
    }
  }

  ctx.type(`${pointer}/onConnectionError`, retry.onConnectionError, isBool, 'boolean');

  // V22：body 正则是上游特定补丁，编译必须通过，且要有配套状态码。
  if (retry.bodyPattern !== undefined && retry.bodyPattern !== null) {
    if (ctx.type(`${pointer}/bodyPattern`, retry.bodyPattern, isNonEmptyString, 'string')) {
      const flags = retry.bodyPatternFlags === undefined ? D.RETRY.bodyPatternFlags : retry.bodyPatternFlags;
      try {
        new RegExp(retry.bodyPattern, flags);
      } catch (e) {
        ctx.err(`${pointer}/bodyPattern`, `正则编译失败：${e.message}`);
      }
      const statuses = retry.bodyPatternStatuses === undefined ? D.RETRY.bodyPatternStatuses : retry.bodyPatternStatuses;
      if (!Array.isArray(statuses) || statuses.length === 0) {
        ctx.err(`${pointer}/bodyPatternStatuses`, 'bodyPattern 需要配套的状态码列表', '例如 [400]。');
      }
      ctx.warn(pointer, '按响应体正则重试是上游特定的临时补丁',
        '官方端点不需要它。如果你的上游需要，说明它在用非标准方式报告软错误。');
    }
  }
}

function validateRoute(ctx, route, index, upstreamNames) {
  const p = `/routes/${index}`;
  if (!ctx.type(p, route, isPlainObject, 'object')) return null;
  ctx.unknownKeys(p, route, ROUTE_KEYS);

  // V5：name 要出现在日志和 status 输出里，所以格式受限。
  if (route.name === undefined) {
    ctx.err(`${p}/name`, '必填字段缺失', '给这条路由起个名字，会出现在日志和 status 输出里。');
  } else if (ctx.type(`${p}/name`, route.name, isNonEmptyString, 'string')) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(route.name)) {
      ctx.err(`${p}/name`, `"${route.name}" 格式不合法`, '只能用小写字母、数字和连字符，且以字母或数字开头。');
    }
  }

  ctx.type(`${p}/default`, route.default, isBool, 'boolean');
  const isDefault = route.default === true;

  // V6：匹配条件与兜底路由互斥。
  const hasMatch = route.match !== undefined;
  const hasRegex = route.matchRegex !== undefined;
  if (hasMatch && hasRegex) {
    ctx.err(`${p}/matchRegex`, 'match 与 matchRegex 互斥', '二者只能用一个。');
  }
  if (isDefault && (hasMatch || hasRegex)) {
    ctx.err(`${p}/${hasMatch ? 'match' : 'matchRegex'}`, '兜底路由不能带匹配条件',
      '设了 default:true 就表示「其余全走这里」。想按模型名匹配请去掉 default。');
  }
  if (!isDefault && !hasMatch && !hasRegex) {
    ctx.err(p, '非兜底路由缺少匹配条件', '加 "match": {"model": ["gpt*"]}，或设 "default": true 作为兜底。');
  }

  if (hasMatch) {
    if (ctx.type(`${p}/match`, route.match, isPlainObject, 'object')) {
      ctx.unknownKeys(`${p}/match`, route.match, new Set(['model']));
      if (!ctx.type(`${p}/match/model`, route.match.model, Array.isArray, 'array',
        '写成数组，例如 ["gpt*"]。')) {
        // 类型已报错
      } else if (route.match.model.length === 0) {
        ctx.err(`${p}/match/model`, '不能为空数组');
      } else if (route.match.model.some((m) => !isNonEmptyString(m))) {
        ctx.err(`${p}/match/model`, '所有元素必须是非空字符串');
      }
    }
  }

  // V7：正则必须能编译。
  if (hasRegex && ctx.type(`${p}/matchRegex`, route.matchRegex, isNonEmptyString, 'string')) {
    try {
      new RegExp(route.matchRegex);
    } catch (e) {
      ctx.err(`${p}/matchRegex`, `正则编译失败：${e.message}`);
    }
  }

  // V8 / V9
  if (route.adapter === undefined) {
    ctx.err(`${p}/adapter`, '必填字段缺失', `取值之一：${D.ADAPTERS.join(' | ')}。`);
  }
  const adapter = ctx.enum(`${p}/adapter`, route.adapter, D.ADAPTERS) ? route.adapter : null;

  if (route.upstream === undefined) {
    ctx.err(`${p}/upstream`, '必填字段缺失',
      upstreamNames.size ? `可用上游：${[...upstreamNames].join(', ')}。` : '先在 /upstreams 里定义一个上游。');
  } else if (ctx.type(`${p}/upstream`, route.upstream, isNonEmptyString, 'string')) {
    if (!upstreamNames.has(route.upstream)) {
      const hint = suggest(route.upstream, upstreamNames);
      ctx.err(`${p}/upstream`, `"${route.upstream}" 未在 /upstreams 中定义`,
        hint ? `你是不是想写 "${hint}"？` : `可用上游：${[...upstreamNames].join(', ') || '（一个都没定义）'}。`);
    }
  }

  validateAuth(ctx, route.auth, `${p}/auth`);
  validateRetry(ctx, route.retry, `${p}/retry`);

  if (ctx.type(`${p}/timeoutMs`, route.timeoutMs, isInt, 'integer') && route.timeoutMs <= 0) {
    ctx.err(`${p}/timeoutMs`, '必须是正整数');
  }
  ctx.type(`${p}/required`, route.required, isBool, 'boolean');

  // V25
  ctx.enum(`${p}/countTokens`, route.countTokens, D.COUNT_TOKENS_STRATEGIES);
  if (ctx.type(`${p}/estimateBytesPerToken`, route.estimateBytesPerToken, isInt, 'integer')) {
    if (route.estimateBytesPerToken < 1 || route.estimateBytesPerToken > 100) {
      ctx.err(`${p}/estimateBytesPerToken`, '必须是 1–100 之间的整数');
    }
  }

  // V23 / V24：适配器专属字段配错了不生效，是静默陷阱，必须报错。
  if (adapter === 'passthrough') {
    for (const field of RESPONSES_ONLY) {
      if (route[field] !== undefined) {
        ctx.err(`${p}/${field}`, `这是 adapter="responses" 专属字段，在 passthrough 路由上不生效`,
          '删掉它，或把 adapter 改成 "responses"。');
      }
    }
  }
  if (adapter === 'responses') {
    for (const field of PASSTHROUGH_ONLY) {
      if (route[field] !== undefined) {
        ctx.err(`${p}/${field}`, `这是 adapter="passthrough" 专属字段，在 responses 路由上不生效`,
          'responses 适配器从零构造上游请求体，patch 不会传导过去。要调整推理档位请用 modelMap 里的 effort。');
      }
    }
  }

  // allowModels / modelMap
  let allowModels = null;
  if (route.allowModels !== undefined && route.allowModels !== null) {
    if (ctx.type(`${p}/allowModels`, route.allowModels, Array.isArray, 'array')) {
      if (route.allowModels.some((m) => !isNonEmptyString(m))) {
        ctx.err(`${p}/allowModels`, '所有元素必须是非空字符串');
      } else {
        allowModels = route.allowModels;
      }
    }
  }

  if (route.modelMap !== undefined) {
    if (ctx.type(`${p}/modelMap`, route.modelMap, isPlainObject, 'object')) {
      for (const [publicName, entry] of Object.entries(route.modelMap)) {
        const mp = `${p}/modelMap/${publicName}`;
        if (!ctx.type(mp, entry, isPlainObject, 'object')) continue;
        ctx.unknownKeys(mp, entry, new Set(['model', 'effort']));
        if (!isNonEmptyString(entry.model)) {
          ctx.err(`${mp}/model`, '必填字段缺失', '填上游认识的真实模型名。');
        }
        if (entry.effort !== undefined && !isNonEmptyString(entry.effort)) {
          ctx.err(`${mp}/effort`, '必须是非空字符串');
        }
        // V26：白名单与别名表自相矛盾的配置要挡住。
        if (allowModels && !allowModels.includes(publicName)) {
          ctx.err(mp, `别名 "${publicName}" 不在 allowModels 里，永远会被白名单拦掉`,
            `把它加进 allowModels，或从 modelMap 里删掉。`);
        }
        // V26 后半：别名对不上本路由的匹配条件时只是 warn，不阻止启动。
        if (hasMatch && Array.isArray(route.match?.model)) {
          const matched = route.match.model.some((pat) => matchesGlob(publicName, pat));
          if (!matched) {
            ctx.warn(mp, `别名 "${publicName}" 不满足本路由的 match 条件，永远不会命中`,
              `本路由匹配 ${JSON.stringify(route.match.model)}。`);
          }
        }
      }
    }
  }

  if (route.bodyOverrides !== undefined) {
    ctx.type(`${p}/bodyOverrides`, route.bodyOverrides, isPlainObject, 'object');
  }
  if (route.bodyOverridePaths !== undefined) {
    if (ctx.type(`${p}/bodyOverridePaths`, route.bodyOverridePaths, Array.isArray, 'array')) {
      if (route.bodyOverridePaths.some((s) => !isNonEmptyString(s))) {
        ctx.err(`${p}/bodyOverridePaths`, '所有元素必须是非空字符串（请求路径前缀）');
      }
    }
  }
  if (route.bodyOverridePaths !== undefined && route.bodyOverrides === undefined) {
    ctx.warn(`${p}/bodyOverridePaths`, '声明了生效路径但没有 bodyOverrides', '要么加上 bodyOverrides，要么删掉这个字段。');
  }

  if (adapter === 'responses' && route.requestPath !== undefined) {
    if (ctx.type(`${p}/requestPath`, route.requestPath, isNonEmptyString, 'string')
        && !route.requestPath.startsWith('/')) {
      ctx.err(`${p}/requestPath`, '必须以 "/" 开头');
    }
  }
  if (route.synthesizeStreamBoundaries !== undefined) {
    ctx.type(`${p}/synthesizeStreamBoundaries`, route.synthesizeStreamBoundaries, isBool, 'boolean');
  }
  if (route.reasoningSummary !== undefined) {
    ctx.type(`${p}/reasoningSummary`, route.reasoningSummary, isNonEmptyString, 'string');
  }

  return { name: route.name, isDefault };
}

/** 前缀 glob：只支持结尾的 `*`。够表达 "gpt*" 这类模型名前缀匹配。 */
function matchesGlob(value, pattern) {
  if (pattern.endsWith('*')) return value.startsWith(pattern.slice(0, -1));
  return value === pattern;
}

/**
 * 校验整份配置。
 * @param {unknown} cfg 已解析的配置对象
 * @returns {{errors: Array, warnings: Array}}
 */
function validate(cfg) {
  const ctx = new Ctx();

  if (!isPlainObject(cfg)) {
    ctx.err('', `配置根必须是一个对象，实际是 ${Array.isArray(cfg) ? 'array' : typeof cfg}`);
    return { errors: ctx.errors, warnings: ctx.warnings };
  }

  ctx.unknownKeys('', cfg, ROOT_KEYS);
  scanCredentials(ctx, cfg, '');

  // V1
  if (cfg.version === undefined) {
    ctx.err('/version', '必填字段缺失', `当前配置格式版本是 ${D.CONFIG_VERSION}，请加上 "version": ${D.CONFIG_VERSION}。`);
  } else if (cfg.version !== D.CONFIG_VERSION) {
    ctx.err('/version', `不支持的配置版本 ${JSON.stringify(cfg.version)}`,
      `本版 gpt-router 只认 version: ${D.CONFIG_VERSION}。`);
  }

  validateListen(ctx, cfg.listen);
  validateLog(ctx, cfg.log);
  validateBuiltins(ctx, cfg.builtins);
  if (cfg.secretsFile !== undefined) {
    ctx.type('/secretsFile', cfg.secretsFile, isNonEmptyString, 'string');
  }

  const upstreamNames = validateUpstreams(ctx, cfg.upstreams);

  // V3
  if (cfg.routes === undefined) {
    ctx.err('/routes', '必填字段缺失', '至少要有一条带 "default": true 的兜底路由。');
    return { errors: ctx.errors, warnings: ctx.warnings };
  }
  if (!ctx.type('/routes', cfg.routes, Array.isArray, 'array')) {
    return { errors: ctx.errors, warnings: ctx.warnings };
  }
  if (cfg.routes.length === 0) {
    ctx.err('/routes', '不能为空', '至少要有一条带 "default": true 的兜底路由。');
    return { errors: ctx.errors, warnings: ctx.warnings };
  }

  const seenNames = new Map();
  const defaults = [];
  const referencedUpstreams = new Set();

  cfg.routes.forEach((route, i) => {
    const info = validateRoute(ctx, route, i, upstreamNames);
    if (isPlainObject(route) && isNonEmptyString(route.upstream)) {
      referencedUpstreams.add(route.upstream);
    }
    if (!info) return;
    if (isNonEmptyString(info.name)) {
      if (seenNames.has(info.name)) {
        ctx.err(`/routes/${i}/name`, `路由名 "${info.name}" 与 /routes/${seenNames.get(info.name)} 重复`,
          '路由名必须唯一，它是日志和 status 里的标识。');
      } else {
        seenNames.set(info.name, i);
      }
    }
    if (info.isDefault) defaults.push({ index: i, name: info.name });
  });

  // V4：兜底路由必须恰好一条。
  if (defaults.length === 0) {
    ctx.err('/routes', '没有兜底路由，未匹配任何 match 条件的请求将无处可去',
      '给其中一条路由加 "default": true —— 通常是指向官方端点的那条。');
  } else if (defaults.length > 1) {
    ctx.err('/routes', `有 ${defaults.length} 条兜底路由：${defaults.map((d) => `/routes/${d.index}${d.name ? ` ("${d.name}")` : ''}`).join('、')}`,
      '只能有一条 default:true。');
  }

  // V11：定义了却没人用的上游只 warn，不阻止启动。
  const domainInfoHost = cfg.builtins?.domainInfo?.host;
  for (const name of upstreamNames) {
    if (!referencedUpstreams.has(name) && cfg.upstreams[name]?.host !== domainInfoHost) {
      ctx.warn(`/upstreams/${name}`, '定义了但没有任何路由引用它', '删掉它，或加一条指向它的路由。');
    }
  }

  return { errors: ctx.errors, warnings: ctx.warnings };
}

/** 把校验结果格式化成人可读的报告。 */
function formatReport(result, configPath) {
  const { errors, warnings } = result;
  const lines = [];

  if (errors.length) {
    lines.push('');
    lines.push(`gpt-router: 配置校验失败，${errors.length} 个问题${configPath ? `（${configPath}）` : ''}`);
    lines.push('');
    const width = Math.min(38, Math.max(...errors.map((e) => (e.pointer || '/').length)) + 2);
    for (const e of errors) {
      const ptr = (e.pointer || '/').padEnd(width);
      lines.push(`  ${ptr}${e.message}`);
      if (e.fix) lines.push(`  ${' '.repeat(width)}→ ${e.fix}`);
    }
    lines.push('');
    lines.push('未做任何监听。修好后可先跑 gpt-router check 验证。');
    lines.push('');
  }

  if (warnings.length) {
    if (!errors.length) lines.push('');
    lines.push(`${errors.length ? '另有 ' : 'gpt-router: '}${warnings.length} 条提醒：`);
    for (const w of warnings) {
      lines.push(`  ${w.pointer || '/'}  ${w.message}`);
      if (w.fix) lines.push(`      → ${w.fix}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

module.exports = { validate, formatReport, matchesGlob, editDistance, suggest };
