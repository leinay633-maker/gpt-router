'use strict';
/**
 * 选路：模型名 → 路由，并做命中后的准入检查。
 *
 * 顺序有讲究：先按公开名选路和查白名单，再解析别名。报错信息里出现的必须是
 * 用户在 /model 界面里看到的那个名字，而不是上游真名——否则用户根本对不上。
 */

const errors = require('./http/errors');

/**
 * 这条路由收不收这个模型？
 * @returns {{ok: true} | {ok: false, status: number, type: string, message: string}}
 */
function checkAdmission(route, model) {
  // 白名单：有些上游对不认识的模型名会静默降级到别的模型，而不是报错。
  // 那种情况下用户以为在用 A 实际在用 B，本地挡住比事后发现好。
  if (route.allowModels && !route.allowModels.has(model)) {
    const allowed = [...route.allowModels].join(', ');
    return {
      ok: false,
      status: 400,
      type: errors.TYPES.invalidRequest,
      message: `路由 "${route.name}" 不接受模型 "${model}"；可用：${allowed}`,
    };
  }

  // 声明了自带凭证但取不到值：503 而不是拿空 key 去打上游换一个看不懂的 401。
  if (route.degraded) {
    return {
      ok: false,
      status: 503,
      type: errors.TYPES.api,
      message: `路由 "${route.name}" 当前不可用：${route.degradedReason}`,
    };
  }

  return { ok: true };
}

/**
 * 把 bodyOverrides 打进请求体。
 *
 * 用途是在路由层钉死某些参数（比如推理档位），避免会话级设置把它改掉。
 * 只做一层浅合并——嵌套深了就该在上游配置里解决，不该由代理猜。
 */
function applyBodyOverrides(route, parsed, body, requestUrl) {
  if (!route.bodyOverrides) return { parsed, body, changed: false };

  if (route.bodyOverridePaths) {
    const hit = route.bodyOverridePaths.some((p) => requestUrl === p || requestUrl.startsWith(`${p}?`));
    if (!hit) return { parsed, body, changed: false };
  }

  if (!parsed) return { parsed, body, changed: false };

  const merged = { ...parsed };
  for (const [k, v] of Object.entries(route.bodyOverrides)) {
    merged[k] = (v && typeof v === 'object' && !Array.isArray(v))
      ? { ...(parsed[k] || {}), ...v }
      : v;
  }
  return { parsed: merged, body: Buffer.from(JSON.stringify(merged), 'utf8'), changed: true };
}

module.exports = { checkAdmission, applyBodyOverrides };
