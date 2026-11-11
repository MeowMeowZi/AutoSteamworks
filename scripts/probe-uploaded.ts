// 只读：在图形资源页的 HTML 里找已上传图片的痕迹（img、背景图、数据属性、脚本里的数据）
import { loadConfig } from '../src/config.js';
import { gotoPartner, openBrowser } from '../src/browser.js';

const [subtab = 'store', lang = ''] = process.argv.slice(2);
const cfg = loadConfig();
const app = cfg.apps[0];
const { ctx, page } = await openBrowser(cfg, true);
try {
  await gotoPartner(page, `https://partner.steamgames.com/admin/game/editbyappid/${app.appid}?activetab=tab_graphicalassets&subtab=${subtab}${lang ? '&l=' + lang : ''}`);
  const data = await page.evaluate(`(() => {
    const html = document.documentElement.outerHTML;
    const hits = [];
    const re = /[^"'\\s(]*(header_image|header|capsule)[^"'\\s)]*\\.(png|jpg|jpeg|webp)[^"'\\s)]*/gi;
    let m; while ((m = re.exec(html)) && hits.length < 40) hits.push(html.slice(Math.max(0, m.index - 200), m.index + m[0].length + 80).replace(/\\s+/g, ' '));
    const sections = Array.from(document.querySelectorAll('*')).filter((e) => e.children.length < 40 && /形象图片/.test(e.textContent || '') && (e.textContent || '').length < 1500)
      .slice(-3).map((e) => (e.innerText || '').replace(/\\s+/g, ' ').slice(0, 800));
    const langBtns = Array.from(document.querySelectorAll('[onclick*=anguage], .imagelanguagebutton, select')).filter((e) => /schinese|简体/.test(e.outerHTML)).slice(0, 8).map((e) => e.outerHTML.slice(0, 300));
    return { url: location.href, hits, sections, langBtns };
  })()`);
  console.log(JSON.stringify(data, null, 1));
} finally {
  await ctx.close();
}
