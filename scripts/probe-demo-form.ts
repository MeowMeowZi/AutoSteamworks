// 只读：对比正式版和 Demo 的商店编辑页（#gameform 字段名、serialized_app_data 的键、图片槽位、页签）
// 用法：npx tsx scripts/probe-demo-form.ts <正式版 appid> <Demo appid>
import { mkdirSync, writeFileSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { gotoPartner, openBrowser } from '../src/browser.js';

const appids = process.argv.slice(2);
if (appids.length !== 2 || !appids.every((id) => /^[1-9]\d*$/.test(id))) throw new Error('请输入正式版和 Demo 的数字 App ID');
mkdirSync('.autosw/inspect', { recursive: true });
const cfg = loadConfig();
const { ctx, page } = await openBrowser(cfg, true);
const result: Record<string, unknown> = {};
try {
  for (const appid of appids) {
    await gotoPartner(page, `https://partner.steamgames.com/admin/game/editbyappid/${appid}`);
    result[appid] = await page.evaluate(`(() => {
      const form = document.querySelector('#gameform');
      const names = form ? Array.from(new Set(Array.from(form.elements).map((e) => e.name).filter(Boolean))) : [];
      // 去掉语言后缀，得到字段“形状”
      const shapes = Array.from(new Set(names.map((n) => n.replace(/\\[(english|schinese|[a-z]+)\\]$/, '[*]').replace(/\\[\\d+\\]/g, '[#]')))).sort();
      let sad = null; try { sad = JSON.parse((document.querySelector('[name="serialized_app_data"]') || {}).value || 'null'); } catch {}
      return {
        url: location.href,
        title: document.title,
        hasForm: !!form,
        action: form && form.action,
        fieldCount: names.length,
        shapes,
        tabs: Array.from(document.querySelectorAll('[id^="tab_"], .tab, .tabs a')).map((t) => (t.id || '') + ':' + (t.innerText || '').trim().slice(0, 30)).slice(0, 40),
        imageTypes: typeof g_ImageTypes !== 'undefined' ? Object.keys(g_ImageTypes) : null,
        sadKeys: sad ? Object.keys(sad) : null,
        assetKeys: sad && sad.assets ? Object.keys(sad.assets) : null,
        contentKeys: sad && sad.content ? Object.keys(sad.content) : null,
        parentHints: (document.body.innerText.match(/.{0,60}(试用版|Demo|demo|父|基础游戏|parent).{0,60}/g) || []).slice(0, 30),
      };
    })()`);
  }
} finally {
  writeFileSync('.autosw/inspect/probe-demo-form.json', JSON.stringify(result, null, 1));
  console.log('已写入 .autosw/inspect/probe-demo-form.json');
  await ctx.close();
}
