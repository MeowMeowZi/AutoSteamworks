import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { createTwoFilesPatch } from 'diff';
import type { Page } from 'playwright-core';
import { loadConfig, selectApps, type AppConfig, type Config } from './config.js';
import { openBrowser, isLoginPage, hasLoginCookie, sleep, PARTNER_HOME } from './browser.js';
import type { FieldValue } from './partner/form.js';
import { fetchRemote, loadStorePage, pushStore, storeEditUrl } from './partner/store.js';
import { hasLocal, readLocal, readSnapshot, splitLocalized, writeLocal, writeSnapshot } from './local/storeFiles.js';
import { localEdits, threeWay, type Change } from './sync.js';
import { runBuild } from './build/steampipe.js';
import { openAssetsPage, uploadAssets } from './partner/assets.js';
import { assetStates, readManifest, scanAssets, writeManifest } from './local/assetFiles.js';

const program = new Command('autosw')
  .description('把本地文件同步到 Steamworks 后台')
  .option('-c, --config <path>', '配置文件', 'steam.config.yaml');

const cfg = (): Config => loadConfig(program.opts().config);

const preview = (v: FieldValue | undefined) => {
  if (v === undefined) return '∅';
  const s = JSON.stringify(v);
  return s.length > 60 ? s.slice(0, 60) + '…' : s;
};

/** 把字段 name 显示成本地文件里的写法，方便对照 */
const display = (key: string) => {
  const loc = splitLocalized(key);
  return loc ? `${loc.lang}/${loc.path}` : key;
};

function printChange(c: Change, verbose: boolean) {
  const tag = { local: '↑ 本地改动', remote: '↓ 线上改动', conflict: '⚠ 冲突', gone: '✗ 线上无此字段' }[c.kind];
  console.log(`  ${tag}  ${display(c.key)}`);
  if (!verbose) return;
  if (typeof c.local === 'string' && typeof c.remote === 'string') {
    const patch = createTwoFilesPatch('remote', 'local', c.remote.replace(/\r\n/g, '\n') + '\n', c.local + '\n', '', '', { context: 2 });
    console.log(patch.split('\n').slice(3).map((l) => '      ' + l).join('\n'));
  } else {
    console.log(`      线上: ${preview(c.remote)}\n      本地: ${preview(c.local)}`);
  }
}

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

program.command('init').description('在当前目录生成示例配置 steam.config.yaml').action(() => {
  if (existsSync('steam.config.yaml')) return console.log('steam.config.yaml 已存在，未覆盖');
  copyFileSync(join(import.meta.dirname, '..', 'steam.config.example.yaml'), 'steam.config.yaml');
  console.log('已生成 steam.config.yaml，请填入你的 appid');
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
  console.log(ok ? '✓ 登录成功，会话已保存在 .autosw/profile' : '✗ 仍然是未登录状态，请重试');
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
      const base = readSnapshot(c, app);
      if (hasLocal(app) && base && !o.force) {
        const edits = localEdits(readLocal(app), base);
        if (edits.length) {
          console.log(`  跳过：本地有 ${edits.length} 个未推送的改动（${edits.slice(0, 3).map(display).join(', ')}…），先 push 或加 --force`);
          return;
        }
      }
      const fields = await fetchRemote(page, c, app);
      writeLocal(app, fields);
      writeSnapshot(c, app, fields);
      console.log(`  ✓ ${Object.keys(fields).length} 个字段 → ${app.storeDir}`);
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

program.command('diff [apps...]').description('对比 本地 / 线上 / 上次同步 三方')
  .option('--headed', '显示浏览器窗口')
  .action(async (keys: string[], o) => {
    await eachApp(keys, !!o.headed, async (page, app, c) => {
      const base = readSnapshot(c, app);
      if (!hasLocal(app) || !base) return console.log('  尚未 pull');
      const changes = threeWay(readLocal(app), await fetchRemote(page, c, app), base);
      if (!changes.length) console.log('  ✓ 已同步');
      changes.forEach((ch) => printChange(ch, true));
    });
  });

program.command('push [apps...]').description('把本地改动保存到后台（不发布）')
  .option('-n, --dry-run', '只显示将要修改的内容')
  .option('-f, --force', '冲突时以本地为准')
  .option('--headed', '显示浏览器窗口')
  .action(async (keys: string[], o) => {
    let failed = false, pushed = false;
    await eachApp(keys, !!o.headed, async (page, app, c) => {
      const base = readSnapshot(c, app);
      if (!hasLocal(app) || !base) return console.log('  尚未 pull，跳过（必须先 pull 才能安全地推送）');
      const changes = threeWay(readLocal(app), await fetchRemote(page, c, app), base);
      changes.filter((ch) => ch.kind !== 'local').forEach((ch) => printChange(ch, false));
      const toPush = changes.filter((ch) => ch.kind === 'local' || (o.force && ch.kind === 'conflict'));
      if (!toPush.length) return console.log('  没有需要推送的改动');
      toPush.forEach((ch) => printChange(ch, !!o.dryRun));
      if (o.dryRun) return;

      const r = await pushStore(page, c, app, toPush.map((ch) => [ch.key, ch.local!]));
      // 只把成功保存的字段写进快照；其他字段保持原来的基准，否则会误把线上改动当成本地改动
      const snap = { ...base };
      for (const k of r.saved) snap[k] = r.after[k];
      writeSnapshot(c, app, snap);
      pushed ||= r.saved.length > 0;
      console.log(`  ✓ 已保存 ${r.saved.length} 个字段（HTTP ${r.status}）`);
      if (r.missing.length) console.log(`  ✗ 页面上找不到: ${r.missing.map(display).join(', ')}`);
      if (r.notPersisted.length) console.log(`  ✗ 提交了但重新加载后值不对: ${r.notPersisted.map(display).join(', ')}`);
      if (r.missing.length || r.notPersisted.length) failed = true;
    });
    if (pushed) console.log('\n提醒：改动已保存为草稿，要在 Steamworks 的“发布”页面发布后才会在商店生效。');
    process.exitCode = failed ? 1 : 0;
  });

program.command('assets [apps...]').description('上传新增或改过的图片（宣传图、库资源、截图）')
  .option('-n, --dry-run', '只按尺寸识别类型，不上传')
  .option('-f, --force', '忽略上传记录，全部重新上传')
  .option('--headed', '显示浏览器窗口')
  .action(async (keys: string[], o) => {
    let failed = false, uploaded = false;
    await eachApp(keys, !!o.headed, async (page, app, c) => {
      const { assets, warnings } = scanAssets(app);
      warnings.forEach((w) => console.log(`  ⚠ ${w}`));
      if (!assets.length) return console.log(`  ${app.assets.dir} 下没有图片`);
      const manifest = readManifest(c, app);
      const states = assetStates(assets, manifest);
      const todo = states.filter((s) => o.force || s.state !== 'same');
      console.log(`  共 ${assets.length} 张，需要上传 ${todo.length} 张`);
      if (!todo.length) return;

      const hasShots = todo.some((s) => s.asset.tab === 'screenshot');
      if (hasShots && app.assets.screenshotsAllAges === undefined) {
        failed = true;
        return console.log('  ✗ 有截图要上传，但配置里没设置 assets.screenshotsAllAges（Steam 要求声明截图是否适合所有年龄）');
      }
      if (!o.dryRun && todo.some((s) => s.asset.tab !== 'screenshot')) {
        console.log('  ℹ Steam 规定：基础宣传图只能包含游戏美术、游戏名称和官方副标题；宣传更新/活动的文字要作为替代艺术作品上传。');
      }

      await openAssetsPage(page, c, app);
      const results = await uploadAssets(page, c, todo.map((s) => ({ ...s.asset, expectChange: s.state !== 'same' })), { allAges: app.assets.screenshotsAllAges, dryRun: !!o.dryRun });
      for (const [i, r] of results.entries()) {
        const s = todo[i];
        const note = s.state === 'changed' ? '（已修改）' : '';
        if (!r.ok) {
          failed = true;
          console.log(`  ✗ ${r.rel}${note}  ${r.error}${r.status ? ` (HTTP ${r.status})` : ''}`);
          if (r.body) console.log(`      ${r.body.slice(0, 300).replace(/\s+/g, ' ')}`);
          continue;
        }
        const where = s.asset.lang && r.key?.endsWith('|' + s.asset.lang) ? ` [${s.asset.lang}]` : '';
        console.log(`  ${o.dryRun ? '→' : '✓'} ${r.rel}${note}  ${r.type} ${r.size}${where}${r.verified ? '（已核对）' : ''}`);
        if (r.warning) console.log(`      ⚠ ${r.warning}`);
        if (o.dryRun) continue;
        uploaded = true;
        manifest[r.rel] = { hash: s.asset.hash, type: r.type, uploadedAt: new Date().toISOString() };
        if (s.state === 'changed' && s.asset.tab === 'screenshot') {
          console.log('      ⚠ 截图改动会作为一张新截图上传，旧的那张需要在后台手动删除');
        }
      }
      if (!o.dryRun) writeManifest(c, app, manifest);
    });
    if (uploaded) console.log('\n提醒：图片已保存为草稿，要在 Steamworks 的“发布”页面发布后才会在商店生效。');
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

program.parseAsync().catch((e) => {
  console.error(`错误: ${e instanceof Error ? e.message : e}`);
  process.exitCode = 1;
});
