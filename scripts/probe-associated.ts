// 只读：读“所有关联程序包、DLC、试用版及工具”页面（apps/associated/<appid>），找试用版（Demo）的 App ID
// 用法：npx tsx scripts/probe-associated.ts [appid ...]（不写就用配置里的第一个 App）
import { mkdirSync, writeFileSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { gotoPartner, openBrowser } from '../src/browser.js';

const cfg = loadConfig();
const ids = process.argv.slice(2).length ? process.argv.slice(2) : [String(cfg.apps[0].appid)];
if (!ids.every((id) => /^[1-9]\d*$/.test(id))) throw new Error('请输入数字 App ID');
mkdirSync('.autosw/inspect', { recursive: true });
const { ctx, page } = await openBrowser(cfg, true);
try {
  for (const appid of ids) {
    await gotoPartner(page, `https://partner.steamgames.com/apps/associated/${appid}`);
    const data = await page.evaluate(`(() => ({
      url: location.href,
      title: document.title,
      warning: Array.from(document.querySelectorAll('div,p')).map((e) => (e.innerText || '').trim()).find((t) => /组织/.test(t) && t.length < 300) || null,
      sections: Array.from(document.querySelectorAll('h1,h2,h3,h4')).map((h) => (h.innerText || '').trim()).filter(Boolean),
      appLinks: Array.from(document.querySelectorAll('a')).map((a) => ({ text: (a.innerText || '').trim().slice(0, 80), href: a.href }))
        .filter((l) => /\\/apps\\/landing\\/|editbyappid|\\/admin\\/game\\//.test(l.href)),
    }))()`) as Record<string, unknown>;
    const out = `.autosw/inspect/probe-associated-${appid}.json`;
    writeFileSync(out, JSON.stringify(data, null, 1));
    console.log(`已写入 ${out}`);
  }
} finally {
  await ctx.close();
}
