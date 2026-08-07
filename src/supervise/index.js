'use strict';
/**
 * 平台监督层的分派入口。
 *
 * 关键抽象：不按平台区分"要不要 daemon"，而是让每个平台模块声明自己的
 * supervisor 类型：
 *
 *   'system'   —— launchd / systemd 自带 KeepAlive，进程崩了系统会拉起来。
 *                 这两个平台完全不需要我们的 daemon 层。
 *   'internal' —— Windows 没有等价机制，得自己看着子进程。
 *
 * 这样 cli.js 里没有任何 process.platform 判断，daemon.js 也不是散落各处的
 * Windows 特例，而是 windows.js 唯一引用的一个实现细节。
 */

const path = require('node:path');
const crypto = require('node:crypto');

const PLATFORMS = {
  win32: () => require('./windows'),
  darwin: () => require('./darwin'),
  linux: () => require('./linux'),
};

/** 服务标识。三平台共用，出现在 plist Label、systemd unit 名和 .lnk 名里。 */
const SERVICE_ID = 'gpt-router';

/**
 * 按 home 生成唯一的服务标识。
 *
 * 为什么不能所有实例共用 'gpt-router'：注册文件名（.lnk / plist Label /
 * unit 名）由它决定，两个不同 GPT_ROUTER_HOME 的实例会算出同一个路径，
 * 于是后装的那个**静默覆盖**先装的自启注册——先装的那个进程还在跑，所以
 * 当场看不出问题，直到重启机器才发现它再也不会自动起来了。
 *
 * 默认 home 保持裸名 'gpt-router'，这样绝大多数用户看到的文件名是干净的；
 * 只有用了自定义 home 的才追加指纹。
 */
function serviceIdFor(home, defaultHome) {
  if (!home || home === defaultHome) return SERVICE_ID;
  const digest = crypto.createHash('sha256')
    .update(path.resolve(home).toLowerCase())
    .digest('hex')
    .slice(0, 8);
  return `${SERVICE_ID}-${digest}`;
}

function unsupported(platform) {
  const err = new Error(
    `暂不支持 ${platform} 平台的自启安装。\n`
    + '你仍然可以手动跑 gpt-router run，再用自己的进程管理器看着它。',
  );
  err.unsupportedPlatform = true;
  throw err;
}

/** 取当前平台的监督模块。 */
function forPlatform(platform = process.platform) {
  const loader = PLATFORMS[platform];
  if (!loader) unsupported(platform);
  return loader();
}

/**
 * 组装平台模块需要的上下文。
 *
 * nodePath 用 process.execPath 而不是硬编码路径——原实现把
 * "C:\Program Files\nodejs\node.exe" 写死在启动器里，这在 nvm-windows、
 * fnm、winget、Scoop 装的 node 下全都是错的。
 */
function context(config) {
  const os = require('node:os');
  const defaultHome = path.join(os.homedir(), '.gpt-router');
  return {
    // 自定义 home 会带指纹，避免两个实例的注册文件互相覆盖
    serviceId: serviceIdFor(config.home, defaultHome),
    nodePath: process.execPath,
    entry: path.resolve(__dirname, '..', '..', 'bin', 'gpt-router.js'),
    home: config.home,
    configPath: config.configPath,
    logFile: config.log.file,
    port: config.listen.port,
    host: config.listen.host,
  };
}

module.exports = { forPlatform, context, serviceIdFor, SERVICE_ID, PLATFORMS };
