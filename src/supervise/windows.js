'use strict';
/**
 * Windows：启动文件夹快捷方式 + VBS 无窗口启动器 + 内部 KeepAlive。
 *
 * 为什么不用计划任务：企业策略下常被禁用、/rl highest 会引入 UAC 提示、
 * 卸载残留更难清。启动文件夹是纯用户态的一个文件。
 *
 * 为什么保留 VBS 这一层：它是唯一可靠的无窗口启动手段。PowerShell 的
 * -WindowStyle Hidden 和快捷方式的 WindowStyle=7 都只是最小化，node 控制台
 * 仍会闪一下。
 */

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { render, writeFile, removeFile, run, logPaths } = require('./shared');

const launcherPath = (ctx) => path.join(ctx.home, 'launcher.vbs');
const pidPath = (ctx) => path.join(ctx.home, 'keepalive.pid');
const startupDir = () => path.join(
  os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows',
  'Start Menu', 'Programs', 'Startup',
);
const shortcutPath = (ctx) => path.join(startupDir(), `${ctx.serviceId}.lnk`);

/** 读 pid 文件。文件不存在、内容不是正整数，都当作"没有在跑的实例"。 */
function readPid(ctx) {
  try {
    const n = Number(fs.readFileSync(pidPath(ctx), 'utf8').trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * 跑一段 PowerShell。
 *
 * 必须走 -EncodedCommand（UTF-16LE + Base64）而不是拼裸字符串：路径里含
 * 中文时，命令行会被按本地代码页（GBK 等）解码，中文变乱码，脚本随即失败。
 * 编码后传递绕开了整个代码页问题。
 *
 * 出方向同样要治：PowerShell 默认按控制台代码页（中文 Windows 是 936/GBK）
 * 写 stdout/stderr，Node 按 UTF-8 读，中文报错就成了乱码。所以在脚本最前面
 * 把输出编码钉成 UTF-8。
 */
function powershell(script) {
  const prelude = '[Console]::OutputEncoding = [Text.Encoding]::UTF8\n';
  const encoded = Buffer.from(prelude + script, 'utf16le').toString('base64');
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded]);
}

/** PowerShell 单引号字符串里的转义：单引号自身翻倍。 */
const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

/**
 * 从 PowerShell 的 stderr 里提炼人能读的一行。
 *
 * -EncodedCommand 下 stderr 会混进 CLIXML 序列化包装（`#< CLIXML` 开头的
 * 一大段 XML）和进度记录，原样打给用户完全没法读。
 */
function cleanPsError(stderr) {
  const text = String(stderr || '')
    .replace(/#<\s*CLIXML/g, '')
    .replace(/<Objs[\s\S]*?<\/Objs>/g, '')
    .replace(/<[^>]+>/g, ' ');
  const line = text.split(/[\r\n]+/).map((s) => s.trim()).find(Boolean);
  return line || '未知原因';
}

/**
 * 建启动文件夹快捷方式。
 *
 * 这是全项目唯一 shell out 的地方——Node 没有内置写 .lnk 的能力，
 * 手写那个二进制格式不划算。
 *
 * 两个必须显式处理的坑：
 *
 * 1) COM 的 $sc.Save() 抛错时 PowerShell 进程**退出码仍是 0**，run() 的
 *    ok 会是 true。企业安全软件普遍拦截 Startup 目录下的 .lnk 创建
 *    （普通文件能写，偏偏拦快捷方式），于是 install 报"已注册登录自启"，
 *    实际什么都没建上。所以不能信退出码，只能事后验证文件真的存在。
 * 2) 加 $ErrorActionPreference = 'Stop' 让错误可捕获，把原始信息带回来，
 *    否则用户只看到一句"失败"，不知道是被拦了还是路径不对。
 */
async function createShortcut(ctx) {
  const target = shortcutPath(ctx);
  const script = [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    '  $ws = New-Object -ComObject WScript.Shell',
    `  $sc = $ws.CreateShortcut(${psQuote(target)})`,
    '  $sc.TargetPath = "wscript.exe"',
    `  $sc.Arguments = '"' + ${psQuote(launcherPath(ctx))} + '"'`,
    '  $sc.WindowStyle = 7',
    "  $sc.Description = 'gpt-router for Claude Code'",
    `  $sc.WorkingDirectory = ${psQuote(ctx.home)}`,
    '  $sc.Save()',
    '} catch {',
    '  [Console]::Error.WriteLine($_.Exception.Message)',
    '  exit 1',
    '}',
  ].join('\n');

  const r = await powershell(script);
  // 退出码不可信，以文件是否真的落地为准
  if (!fs.existsSync(target)) {
    return {
      ...r,
      ok: false,
      stderr: r.stderr ? cleanPsError(r.stderr) : '快捷方式未能落地（可能被安全软件拦截）',
    };
  }
  return { ...r, ok: true };
}

const RUN_KEY = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';

/**
 * 自启的兜底方案：注册表 HKCU\...\Run。
 *
 * 为什么需要兜底：企业安全软件常常只拦 Startup 目录下的 .lnk 创建
 * （同目录的普通文件反而能写），而 HKCU 的 Run 键是可写的。没有兜底时
 * install 会以为自己装好了，用户重启后发现服务没起来，却无从下手。
 *
 * 仍然优先用 .lnk：它是纯用户态的一个文件，卸载残留最好清，也更容易被
 * 用户自己在"任务管理器 → 启动"里看见和管理。
 */
async function createRunKey(ctx) {
  const value = `wscript.exe "${launcherPath(ctx)}"`;
  const script = [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    `  New-ItemProperty -Path ${psQuote(RUN_KEY)} -Name ${psQuote(ctx.serviceId)} `
      + `-Value ${psQuote(value)} -PropertyType String -Force | Out-Null`,
    '} catch {',
    '  [Console]::Error.WriteLine($_.Exception.Message)',
    '  exit 1',
    '}',
  ].join('\n');
  return powershell(script);
}

async function readRunKey(ctx) {
  // 用 PSObject 索引器而不是 $v.<name> 取值：serviceId 里若含连字符，
  // 点号取属性在 PowerShell 里不合法。
  const script = [
    `$v = Get-ItemProperty -Path ${psQuote(RUN_KEY)} -ErrorAction SilentlyContinue`,
    `if ($v -and $v.PSObject.Properties.Name -contains ${psQuote(ctx.serviceId)}) `
      + `{ $v.PSObject.Properties[${psQuote(ctx.serviceId)}].Value }`,
  ].join('\n');
  return powershell(script);
}

async function removeRunKey(ctx) {
  return powershell(
    `Remove-ItemProperty -Path ${psQuote(RUN_KEY)} -Name ${psQuote(ctx.serviceId)} `
    + '-Force -ErrorAction SilentlyContinue',
  );
}

async function launchDetached(ctx) {
  // 经 wscript 起 VBS，VBS 再起 node。这样进程脱离当前终端，
  // 关掉 shell 或重启 Claude Code 都不影响它。
  return powershell(
    `Start-Process wscript.exe -ArgumentList ('"' + ${psQuote(launcherPath(ctx))} + '"') -WindowStyle Hidden`,
  );
}

/**
 * 杀掉**本 home** 的 keepalive 进程及其子进程。
 *
 * 只认 pid 文件，不做命令行模糊匹配。曾经的实现是
 * `CommandLine -like '*gpt-router*'`，它会杀掉这台机器上所有命令行里带
 * "gpt-router" 的 node——包括用户另一份 GPT_ROUTER_HOME 下正在服务的实例，
 * 以及任何路径里凑巧含这个词的无关进程。install 里有一步"先清掉旧实例"，
 * 于是拿隔离 home 跑一次安装验证，就能把真在用的实例连带守护进程一起打死。
 *
 * home 不出现在命令行里（它是环境变量），所以精确定位只能靠 pid 文件。
 * 拿到 pid 后仍要复核进程身份：pid 会被系统复用，隔一段时间后同一个号
 * 可能已经是别的程序了。
 */
async function killRunning(ctx) {
  const pid = readPid(ctx);
  if (!pid) return { ok: true, stdout: '0', stderr: '', code: 0, killed: 0 };

  // 复核 + 连子进程一起杀：keepalive 自己会重启子进程，只杀父的话
  // 子进程会被 orphan 掉，端口一直占着。
  //
  // 变量名不能用 $pid——那是 PowerShell 的只读内置变量（当前 shell 自己的
  // PID）。赋值会被静默拒绝（只在 stderr 留一行），后面的复核于是拿
  // powershell.exe 自己去比 'node.exe'，永远不相等，函数一声不响地什么都
  // 不杀却返回成功。
  const script = [
    `$target = ${pid}`,
    "$p = Get-CimInstance Win32_Process -Filter \"ProcessId = $target\" -ErrorAction SilentlyContinue",
    // pid 复用防护：必须是 node，且命令行确实指向本 home 的入口
    `if (-not $p -or $p.Name -ne 'node.exe' -or $p.CommandLine -notlike ${psQuote(`*${ctx.entry}*`)}) { '0'; exit 0 }`,
    "$kids = Get-CimInstance Win32_Process -Filter \"ParentProcessId = $target\" -ErrorAction SilentlyContinue",
    // 先杀父：否则杀完子进程，keepalive 会立刻再拉起一个新的
    'Stop-Process -Id $target -Force -ErrorAction SilentlyContinue',
    '$kids | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }',
    // 父进程死后可能已经又 spawn 了一个，补一轮兜底
    "Get-CimInstance Win32_Process -Filter \"ParentProcessId = $target\" -ErrorAction SilentlyContinue "
      + '| ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }',
    "(1 + @($kids).Count)",
  ].join('\n');

  const r = await powershell(script);
  removeFile(pidPath(ctx));
  return { ...r, killed: Number(r.stdout) || 0 };
}

module.exports = {
  supervisor: 'internal',
  platformName: 'Windows (启动文件夹 + VBS)',

  registrationPath: shortcutPath,

  async preflight() {
    if (!fs.existsSync(startupDir())) {
      return { ok: false, message: `找不到启动文件夹：${startupDir()}` };
    }
    const ps = await run('powershell.exe', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major']);
    if (!ps.ok) {
      return { ok: false, message: '找不到 powershell.exe，无法创建启动快捷方式。' };
    }
    return { ok: true };
  },

  async install(ctx) {
    // 把当前 node 的真实路径烤进启动器
    const vbs = render('launcher.vbs.tmpl', {
      NODE: ctx.nodePath,
      ENTRY: ctx.entry,
    });
    // VBS 必须是 CRLF，wscript 对 LF-only 文件会解析失败
    writeFile(launcherPath(ctx), vbs.replace(/\r?\n/g, '\r\n'));

    // 先注册自启，再动进程。顺序反过来的话，注册失败时用户已经先丢了
    // 一个正在服务的实例——安装失败不该有副作用。
    let method = 'startup';
    let note = null;
    const shortcut = await createShortcut(ctx);
    if (!shortcut.ok) {
      // .lnk 被拦是企业环境的常态，降级到注册表 Run 键
      const runKey = await createRunKey(ctx);
      if (!runKey.ok) {
        return {
          registrationPath: shortcutPath(ctx),
          started: false,
          message: `自启注册失败。快捷方式：${shortcut.stderr}；`
            + `注册表：${cleanPsError(runKey.stderr)}`,
        };
      }
      method = 'runkey';
      note = `启动文件夹被拒（${shortcut.stderr}），已改用注册表 Run 键`;
    }

    await killRunning(ctx); // 重装时先清掉本 home 的旧实例
    const launched = await launchDetached(ctx);

    const where = method === 'runkey' ? `${RUN_KEY}\\${ctx.serviceId}` : shortcutPath(ctx);
    return {
      registrationPath: where,
      started: launched.ok,
      message: [
        launched.ok ? '已注册登录自启并启动' : `自启已注册，但启动失败：${launched.stderr}`,
        note,
      ].filter(Boolean).join('。'),
    };
  },

  async uninstall(ctx) {
    await killRunning(ctx);
    // 两种注册方式都清，不管当初用的是哪种。removed 要合并两边的结果，
    // 否则降级安装（注册表）卸载后会报"注册文件本来就不存在"。
    const lnkRemoved = removeFile(shortcutPath(ctx));
    const before = await readRunKey(ctx);
    const hadRunKey = Boolean(before.ok && before.stdout);
    if (hadRunKey) await removeRunKey(ctx);
    removeFile(launcherPath(ctx));
    removeFile(pidPath(ctx));
    return {
      removed: lnkRemoved || hadRunKey,
      registrationPath: lnkRemoved
        ? shortcutPath(ctx)
        : `${RUN_KEY}\\${ctx.serviceId}`,
    };
  },

  async start(ctx) {
    if (!fs.existsSync(launcherPath(ctx))) {
      return { ok: false, message: '还没安装。先跑 gpt-router install。' };
    }
    const r = await launchDetached(ctx);
    return { ok: r.ok, message: r.ok ? null : r.stderr };
  },

  async stop(ctx) {
    const r = await killRunning(ctx);
    if (!r.ok) return { ok: false, message: cleanPsError(r.stderr) };
    // 一个都没杀掉时别报"已停止"——本来没在跑，和复核没通过，都该说清楚
    if (r.killed === 0) {
      return { ok: true, message: '没有在跑的实例（本 home 下没有 pid 记录）' };
    }
    return { ok: true, message: null };
  },

  async registered(ctx) {
    // 两种注册方式都算"已装"——只查 .lnk 的话，降级到注册表的安装会被
    // doctor 误报成"未注册自启"。
    if (fs.existsSync(shortcutPath(ctx))) {
      return { installed: true, enabled: true, method: 'startup' };
    }
    const runKey = await readRunKey(ctx);
    if (runKey.ok && runKey.stdout) {
      return { installed: true, enabled: true, method: 'runkey' };
    }
    return { installed: false, enabled: false, method: null };
  },

  // 供 daemon 层使用：node 路径失效时的自愈
  launcherPath,
  rewriteLauncher(ctx, nodePath) {
    const vbs = render('launcher.vbs.tmpl', { NODE: nodePath, ENTRY: ctx.entry });
    writeFile(launcherPath(ctx), vbs.replace(/\r?\n/g, '\r\n'));
  },
};
