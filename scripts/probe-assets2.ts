// 只读：查看图形资源页上和上传相关的全局变量、初始化代码、协议确认逻辑
import { loadConfig } from '../src/config.js';
import { gotoPartner, openBrowser } from '../src/browser.js';

const cfg = loadConfig();
const app = cfg.apps[0];
const { ctx, page } = await openBrowser(cfg, true);
try {
  await gotoPartner(page, `https://partner.steamgames.com/admin/game/editbyappid/${app.appid}?activetab=tab_graphicalassets&subtab=store`);
  const data = await page.evaluate(`(() => {
    const inline = Array.from(document.scripts).filter((s) => !s.src).map((s) => s.textContent).join('\\n');
    const grab = (re, n = 600) => { const i = inline.search(re); return i < 0 ? null : inline.slice(Math.max(0, i - 100), i + n); };
    return {
      types: typeof g_ImageTypes !== 'undefined' && g_ImageTypes ? g_ImageTypes.map((t) => [t.name, t.width + 'x' + t.height, t.tab, t.localized, t.path]) : null,
      hasSession: typeof g_sessionID === 'string' && g_sessionID.length > 0,
      fns: ['UploadImages', 'IsImageTypeValid', 'DetermineImageType', 'AgreeToBaseAssetsUpload', 'ShowImageConfirmationDialog'].map((f) => [f, typeof window[f]]),
      init: grab(/InitImageTypes\\s*\\(/, 300),
      agree: grab(/function AgreeToBaseAssetsUpload|AgreeToBaseAssetsUpload\\s*=/, 1500),
      prevent: grab(/bPreventStoreAssetUploads/, 500),
      src: ['AgreeToBaseAssetsUpload','ShowImageConfirmationDialog'].map((f) => [f, String(window[f]).slice(0, 1200)]),
    };
  })()`);
  console.log(JSON.stringify(data, null, 1));
} finally {
  await ctx.close();
}
