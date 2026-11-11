// 只读：读后台删除图片用到的函数源码，以及页面上所有调用它们的元素（宣传图、库资源、截图）
import { writeFileSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { gotoPartner, openBrowser } from '../src/browser.js';

const cfg = loadConfig();
const app = cfg.apps[0];
const { ctx, page } = await openBrowser(cfg, true);
try {
  const out: Record<string, unknown> = {};
  for (const subtab of ['store', 'library', 'screenshots']) {
    await gotoPartner(page, `https://partner.steamgames.com/admin/game/editbyappid/${app.appid}?activetab=tab_graphicalassets&subtab=${subtab}`);
    out[subtab] = await page.evaluate(`(() => {
      const fns = ['SubmitQuickMessageUpdate', 'SubmitQuickMessageUpdateAjax', 'ShowConfirmDialog'].map((f) => [f, String(window[f]).slice(0, 3000)]);
      const calls = Array.from(document.querySelectorAll('[onclick], a[href^="javascript"]'))
        .filter((e) => /SubmitQuickMessageUpdate|DeleteGraphicalAssets|DeleteScreenshot|quickupdate/i.test(e.outerHTML))
        .map((e) => ({ text: (e.innerText || '').trim().slice(0, 40), call: e.getAttribute('onclick') || e.getAttribute('href') }));
      const shots = Array.from(document.querySelectorAll('.screenshot_actual')).slice(0, 3).map((e) => e.outerHTML.slice(0, 1500));
      return { url: location.href, fns, calls, shots };
    })()`);
  }
  writeFileSync('.autosw/inspect/probe-delete2.json', JSON.stringify(out, null, 1));
  console.log('已写入 .autosw/inspect/probe-delete2.json');
} finally {
  await ctx.close();
}
