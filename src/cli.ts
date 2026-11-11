import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import type { Page } from 'playwright-core';
import { loadConfig, selectApps, type AppConfig, type Config } from './config.js';
import { openBrowser, isLoginPage, hasLoginCookie, sleep, PARTNER_HOME } from './browser.js';
import { loadStorePage, storeEditUrl } from './partner/store.js';
import { hasLocal, readLocal, readSnapshot, splitLocalized } from './local/storeFiles.js';
import { localEdits } from './sync.js';
import { lint } from './lint.js';
import { runBuild } from './build/steampipe.js';
import { assetsApp, diffApp, pullApp, display, DRAFT_NOTE, preview, printChange, pushApp } from './ops.js';

const program = new Command('autosw')
  .description('把本地文件同步到 Steamworks 后台')
  .option('-c, --config <path>', '配置文件', 'steam.config.yaml');

const cfg = (): Config => loadConfig(program.opts().config);

const log = (line: string) => console.log(line);

/** 打开浏览器，依次处理每个 App */
async function eachApp(keys: string[], headed: boolean, fn: (page: Page, app: AppConfig, c: Config) => Promise<void>) {
  const c = cfg();
  const apps = selectApps(c, keys);
  const { ctx, page } = await openBrowser(c, !headed);
  try {
    for (const app of apps) {
      console.log(`\n■ ${app.key} (${app.appid}) [${app.languages.join(', ')}]`);
      await fn(page, app, c);
    }
  } finally {
    await ctx.close();
  }
}

program.command('init').description('在当前目录生成示例配置 steam.config.yaml 和给 AI 看的规则 STEAM_RULES.md').action(() => {
  const tpl: [string, string][] = [
    ['steam.config.yaml', join(import.meta.dirname, '..', 'steam.config.example.yaml')],
    ['STEAM_RULES.md', join(import.meta.dirname, '..', 'templates', 'STEAM_RULES.md')],
  ];
  for (const [dst, src] of tpl) {
    if (existsSync(dst)) { console.log(`${dst} 已存在，未覆盖`); continue; }
    copyFileSync(src, dst);
    console.log(`已生成 ${dst}`);
  }
  // 快照、上传记录不该进游戏项目的 git；旧版的登录 Cookie 也可能在这里
  const gi = '.gitignore';
  const text = existsSync(gi) ? readFileSync(gi, 'utf8') : '';
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  if (!lines.some((l) => l === '.autosw/' || l === '.autosw' || l === '/.autosw/')) {
    appendFileSync(gi, (text && !text.endsWith('\n') ? '\n' : '') + '# AutoSteamworks 的本地状态\n.autosw/\n');
    console.log('已把 .autosw/ 加进 .gitignore');
  }
  console.log('请在 steam.config.yaml 里填入 appid，在 STEAM_RULES.md 末尾填写本项目的风格和术语表');
});

program.command('apps').description('列出配置中的 App').action(() => {
  for (const a of cfg().apps) {
    console.log(`${a.key.padEnd(16)} ${String(a.appid).padEnd(10)} ${a.languages.join(',')}  ${a.build ? `depots: ${a.build.depots.map((d) => d.id).join(',')}` : ''}`);
  }
});

program.command('login').description('打开浏览器手动登录 Steamworks，保存会话').action(async () => {
  const c = cfg();
  const { ctx, page } = await openBrowser(c, false);
  await page.goto(PARTNER_HOME);
  console.log('请在弹出的浏览器里登录 Steamworks（包括 Steam Guard），登录成功后会自动检测并保存（最多等 10 分钟）…');
  const deadline = Date.now() + 10 * 60_000;
  let ok = false;
  while (!ok && Date.now() < deadline && ctx.pages().length > 0) {
    await sleep(2000);
    ok = (await hasLoginCookie(ctx)) && !isLoginPage(page.url());
  }
  if (ok) await sleep(3000); // 让 Steam 完成重定向、写完剩下的 Cookie
  await ctx.close().catch(() => {});
  console.log(ok ? `✓ 登录成功，会话已保存在 ${c.profileDir}` : '✗ 仍然是未登录状态，请重试');
  process.exitCode = ok ? 0 : 1;
});

program.command('inspect <app>')
  .description('导出商店编辑页上的所有字段和截图，用来排查问题')
  .option('--headed', '显示浏览器窗口')
  .action(async (key: string, o) => {
    await eachApp([key], !!o.headed, async (page, app, c) => {
      const info = await loadStorePage(page, c, app);
      const dir = join(c.stateDir, 'inspect');
      mkdirSync(dir, { recursive: true });
      const base = join(dir, app.key);
      writeFileSync(base + '.json', JSON.stringify(info, null, 2));
      await page.screenshot({ path: base + '.png', fullPage: true });
      const localized = info.filter((f) => splitLocalized(f.key));
      const filled = info.filter((f) => f.value !== '' && f.value !== false);
      console.log(`URL: ${storeEditUrl(c, app)}\n实际: ${page.url()}`);
      console.log(`字段 ${info.length} 个（本地化 ${localized.length}，有值 ${filled.length}）\n有值的字段:`);
      for (const f of filled) console.log(`  ${display(f.key).padEnd(56)} ${preview(f.value)}`);
      console.log(`\n完整列表已保存到 ${base}.json，截图 ${base}.png`);
    });
  });

program.command('pull [apps...]').description('把后台的商店内容拉到本地')
  .option('-f, --force', '即使本地有未推送的改动也覆盖')
  .option('--headed', '显示浏览器窗口')
  .action(async (keys: string[], o) => {
    await eachApp(keys, !!o.headed, async (page, app, c) => {
      await pullApp(page, c, app, { force: !!o.force }, log);
    });
  });

program.command('status [apps...]').description('（离线）列出本地相对上次同步的改动')
  .action((keys: string[]) => {
    const c = cfg();
    for (const app of selectApps(c, keys)) {
      const base = readSnapshot(c, app);
      if (!hasLocal(app) || !base) { console.log(`${app.key}: 尚未 pull`); continue; }
      const edits = localEdits(readLocal(app), base);
      console.log(`${app.key}: ${edits.length ? edits.length + ' 处改动' : '无改动'}`);
      edits.forEach((k) => console.log('  ↑ ' + display(k)));
    }
  });

program.command('check [apps...]').description('（离线）按规则检查本地商店文本，并列出未上传的改动；有错误时退出码为 1')
  .action((keys: string[]) => {
    const c = cfg();
    let errors = 0;
    for (const app of selectApps(c, keys)) {
      if (!hasLocal(app)) { console.log(`${app.key}: 尚未 pull`); continue; }
      const local = readLocal(app);
      const issues = lint(app, local);
      const base = readSnapshot(c, app);
      const edits = base ? localEdits(local, base) : [];
      console.log(`${app.key}: ${issues.length ? issues.length + ' 个问题' : '规则检查通过'}，${edits.length} 处未上传的改动`);
      for (const i of issues) console.log(`  ${i.level === 'error' ? '✗' : '⚠'} ${display(i.key)}  ${i.msg}`);
      edits.forEach((k) => console.log('  ↑ ' + display(k)));
      errors += issues.filter((i) => i.level === 'error').length;
    }
    process.exitCode = errors ? 1 : 0;
  });

program.command('diff [apps...]').description('对比 本地 / 线上 / 上次同步 三方')
  .option('--headed', '显示浏览器窗口')
  .action(async (keys: string[], o) => {
    await eachApp(keys, !!o.headed, async (page, app, c) => {
      const changes = await diffApp(page, c, app);
      if (!changes) return console.log('  尚未 pull');
      if (!changes.length) console.log('  ✓ 已同步');
      changes.forEach((ch) => printChange(log, ch, true));
    });
  });

program.command('push [apps...]').description('把本地改动保存到后台（不发布）')
  .option('-n, --dry-run', '只显示将要修改的内容')
  .option('-f, --force', '冲突时以本地为准')
  .option('--headed', '显示浏览器窗口')
  .action(async (keys: string[], o) => {
    let failed = false, pushed = false;
    await eachApp(keys, !!o.headed, async (page, app, c) => {
      const r = await pushApp(page, c, app, { dryRun: !!o.dryRun, force: !!o.force }, log);
      failed ||= r.failed;
      pushed ||= r.pushed;
    });
    if (pushed) console.log('\n' + DRAFT_NOTE);
    process.exitCode = failed ? 1 : 0;
  });

program.command('assets [apps...]').description('上传新增或改过的图片（宣传图、库资源、截图）')
  .option('-n, --dry-run', '只按尺寸识别类型，不上传')
  .option('-f, --force', '忽略上传记录，全部重新上传')
  .option('--headed', '显示浏览器窗口')
  .action(async (keys: string[], o) => {
    let failed = false, uploaded = false;
    await eachApp(keys, !!o.headed, async (page, app, c) => {
      const r = await assetsApp(page, c, app, { dryRun: !!o.dryRun, force: !!o.force }, log);
      failed ||= r.failed;
      uploaded ||= r.pushed;
    });
    if (uploaded) console.log('\n' + DRAFT_NOTE);
    process.exitCode = failed ? 1 : 0;
  });

program.command('build <app>').description('通过 steamcmd / SteamPipe 上传构建')
  .option('-d, --desc <text>', '构建描述', `autosw ${new Date().toISOString()}`)
  .option('--preview', '预览模式：只扫描文件，不实际上传')
  .option('-n, --dry-run', '只生成 VDF，不运行 steamcmd')
  .action(async (key: string, o) => {
    const c = cfg();
    const [app] = selectApps(c, [key]);
    await runBuild(c, app, { desc: o.desc, preview: !!o.preview, dryRun: !!o.dryRun });
  });

program.command('ui').description('打开本地后台网页：查看本地内容和改动，勾选后一键上传')
  .option('-p, --port <port>', '端口', '5180')
  .option('--no-open', '不自动打开浏览器')
  .action(async (o) => {
    cfg(); // 先校验配置
    const { startUi } = await import('./ui/server.js');
    const { url } = await startUi(program.opts().config, Number(o.port));
    console.log(`后台网页已启动：${url}\n本地文件改动（编辑器或 AI 修改）会自动刷新到网页上。按 Ctrl+C 退出。`);
    if (o.open) {
      const { spawn } = await import('node:child_process');
      const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]];
      spawn(cmd, args as string[], { stdio: 'ignore', detached: true }).unref();
    }
  });

program.parseAsync().catch((e) => {
  console.error(`错误: ${e instanceof Error ? e.message : e}`);
  process.exitCode = 1;
});
