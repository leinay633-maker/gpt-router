'use strict';
/**
 * 配置默认值的单一来源。
 *
 * 校验器和运行时都从这里取默认值，避免「校验时按 A 判定、运行时按 B 执行」
 * 这种最难查的漂移。
 *
 * 一个有意的例外：auth.mode 没有默认值。鉴权是安全语义，
 * 隐式默认会让人在不知情的情况下把凭证转发给第三方上游。必须显式写。
 */

/** 配置格式版本。不兼容改动时递增，并在 load.js 里给迁移提示。 */
const CONFIG_VERSION = 1;

const LISTEN = {
  host: '127.0.0.1',
  port: 8402,
  guardOrigin: true,
  requireToken: false,
  allowNonLoopback: false,
};

const LOG = {
  file: '~/.gpt-router/router.log',
  level: 'info',
  maskKeys: true,
  logBodies: false,
};

const BUILTINS = {
  // Claude Code 用 "claude-sonnet-5[1m]" 这种后缀表达 1M 上下文，
  // 但上游只认裸模型名（1M 实际靠 anthropic-beta header 生效）。
  // 这是客户端通用行为，与挂哪个上游无关，所以默认开。
  stripModelSuffix: true,
  healthz: true,
  domainInfo: {
    enabled: true,
    // CC 在 WebFetch 前会 GET /api/web/domain_info，期望 {"can_fetch":true}。
    // 这个端点只存在于官方域且无需鉴权；转发给别的上游会拿到 200 空 body，
    // CC 解析不到 can_fetch 就报「Unable to verify if domain is safe to fetch」,
    // 看起来像网络问题，实际是路由错投。
    host: 'api.anthropic.com',
    timeoutMs: 15000,
    // 预检拿不到就放行，让真实抓取自己决定成败，而不是把 WebFetch 整体卡死。
    failOpen: true,
  },
};

const UPSTREAM = {
  protocol: 'https',
  pathPrefix: '',
};

/** protocol 决定端口默认值。 */
const PORT_BY_PROTOCOL = { https: 443, http: 80 };

const RETRY = {
  maxRetries: 5, // 首次 + 5 次重试
  backoffMs: [0, 400, 800, 1600, 3200, 6400],
  statuses: [429, 502, 503, 504],
  onConnectionError: true,
  // 按响应 body 正则重试，是上游特定的怪毛病补丁。官方端点永不需要，
  // 所以默认关——留着是给那些会在 200 之外返回间歇性软错误的中转站用的。
  bodyPattern: null,
  bodyPatternStatuses: [400],
  bodyPatternFlags: 'i',
};

const ROUTE = {
  timeoutMs: 900000,
  required: false,
  stripClientAuth: true,
};

/**
 * countTokens 按适配器给不同默认值，这个差异是协议本质而非偏好：
 * Anthropic Messages 线有 /v1/messages/count_tokens 端点，
 * OpenAI Responses 线没有，只能本地粗估。
 */
const COUNT_TOKENS_BY_ADAPTER = {
  passthrough: 'forward',
  responses: 'estimate',
};

const RESPONSES = {
  requestPath: '/v1/responses',
  reasoningSummary: 'auto',
  estimateBytesPerToken: 4,
  // 有些 Responses 实现不发 response.created / response.completed，
  // 开启后首事件即合成 message_start、流末即合成 message_stop。
  synthesizeStreamBoundaries: true,
};

const LOG_LEVELS = ['error', 'warn', 'info', 'debug'];
const AUTH_MODES = ['client', 'env', 'secrets', 'none'];
const AUTH_HEADERS = ['authorization', 'x-api-key', 'inherit'];
const ADAPTERS = ['passthrough', 'responses'];
const COUNT_TOKENS_STRATEGIES = ['estimate', 'forward', 'reject'];
const PROTOCOLS = ['http', 'https'];

/** 配置里的凭证扫描：命中即硬报错，把「secrets 不进 config」变成机器强制。 */
const CREDENTIAL_VALUE_RE = /^(?:sk-[A-Za-z0-9_-]{16,}|Bearer\s+\S{16,}|(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}|xox[baprs]-[A-Za-z0-9-]{10,})/;
const CREDENTIAL_KEY_NAMES = new Set(['key', 'apikey', 'api_key', 'token', 'secret', 'password', 'authtoken', 'auth_token']);

/** 回环地址白名单。listen.host 必须是其中之一，除非显式解锁。 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

module.exports = {
  CONFIG_VERSION,
  LISTEN,
  LOG,
  BUILTINS,
  UPSTREAM,
  PORT_BY_PROTOCOL,
  RETRY,
  ROUTE,
  COUNT_TOKENS_BY_ADAPTER,
  RESPONSES,
  LOG_LEVELS,
  AUTH_MODES,
  AUTH_HEADERS,
  ADAPTERS,
  COUNT_TOKENS_STRATEGIES,
  PROTOCOLS,
  CREDENTIAL_VALUE_RE,
  CREDENTIAL_KEY_NAMES,
  LOOPBACK_HOSTS,
};
