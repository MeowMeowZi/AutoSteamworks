// 只读：找后台图形资源页上“删除图片”的入口（按钮、onclick、相关全局函数、外部脚本地址）
import { writeFileSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { gotoPartner, openBrowser } from '../src/browser.js';

const [subtab = 'store'] = process.argv.slice(2);
const cfg = loadConfig();
const app = cfg.apps[0];
const { ctx, page } = await openBrowser(cfg, true);
try {
  await gotoPartner(page, `https://partner.steamgames.com/admin/game/editbyappid/${app.appid}?activetab=tab_graphicalassets&subtab=${subtab}`);
  const data = await page.evaluate(`(() => {
    const scripts = Array.from(document.scripts).filter((s) => s.src).map((s) => s.src);
    const inline = Array.from(document.scripts).filter((s) => !s.src).map((s) => s.textContent).join('\\n');
    const grabAll = (re, n = 500) => { const out = []; let m; const r = new RegExp(re.source, 'gi'); while ((m = r.exec(inline)) && out.length < 10) out.push(inline.slice(Math.max(0, m.index - 150), m.index + n)); return out; };
    const els = Array.from(document.querySelectorAll('[onclick], a[href^="javascript"], button, .btn_small, .btnv6_blue_hoverfade'))
      .filter((e) => /delete|remove|删除|移除/i.test(e.outerHTML)).slice(0, 40)
      .map((e) => ({ text: (e.innerText || '').trim().slice(0, 40), html: e.outerHTML.slice(0, 400), parent: (e.parentElement && e.parentElement.outerHTML || '').slice(0, 600) }));
    const fns = Object.keys(window).filter((k) => /delete|remove/i.test(k) && typeof window[k] === 'function').map((k) => [k, String(window[k]).slice(0, 2500)]);
    return { url: location.href, scripts, els, fns, inlineHits: grabAll(/delete|remove/) };
  })()`);
  const out = `.autosw/inspect/probe-delete-${subtab}.json`;
  writeFileSync(out, JSON.stringify(data, null, 1));
  console.log(`已写入 ${out}`);
} finally {
  await ctx.close();
}
