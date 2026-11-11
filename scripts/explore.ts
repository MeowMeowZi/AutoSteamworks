// 只读的探索脚本：打开一个后台页面，列出所有链接和机构选项，并截图。用法：tsx scripts/explore.ts <url> [名字]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { gotoPartner, openBrowser } from '../src/browser.js';

const [url, name = 'explore'] = process.argv.slice(2);
const cfg = loadConfig();
const { ctx, page } = await openBrowser(cfg, true);
try {
  await gotoPartner(page, url);
  const dir = join(cfg.stateDir, 'inspect');
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: join(dir, name + '.png'), fullPage: true });
  const data = await page.evaluate(`({
    title: document.title,
    links: Array.from(document.querySelectorAll('a[href]')).map((a) => [a.innerText.trim().replace(/\\s+/g, ' ').slice(0, 50), a.href]),
    publishers: Array.from(document.querySelectorAll('select[name=publisher] option')).map((o) => [o.value, o.innerText.trim(), o.selected]),
  })`) as { title: string; links: [string, string][]; publishers: [string, string, boolean][] };
  writeFileSync(join(dir, name + '.json'), JSON.stringify(data, null, 2));
  console.log(`实际 URL: ${page.url()}\n标题: ${data.title}\n机构:`);
  data.publishers.forEach(([v, t, s]) => console.log(`  ${s ? '*' : ' '} ${v} ${t}`));
  console.log('链接:');
  const seen = new Set<string>();
  for (const [t, h] of data.links) {
    if (!h.includes('partner.steamgames.com') || seen.has(h)) continue;
    seen.add(h);
    console.log(`  ${t.padEnd(30)} ${h}`);
  }
} finally {
  await ctx.close();
}
