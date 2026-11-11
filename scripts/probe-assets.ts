// 只读：看“图形资源”标签页的结构：文件输入框、已有图片、上传相关的脚本和表单
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { gotoPartner, openBrowser } from '../src/browser.js';

const subtab = process.argv[2] ?? 'screenshots';
const cfg = loadConfig();
const app = cfg.apps[0];
const { ctx, page } = await openBrowser(cfg, true);
try {
  await gotoPartner(page, `https://partner.steamgames.com/admin/game/editbyappid/${app.appid}?activetab=tab_graphicalassets&subtab=${subtab}`);
  await page.screenshot({ path: join(cfg.stateDir, 'inspect', `assets-${subtab}.png`), fullPage: true });
  const data = await page.evaluate(`(() => {
    const short = (s, n = 160) => (s || '').replace(/\\s+/g, ' ').trim().slice(0, n);
    const vis = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const ctxOf = (el) => { let p = el.parentElement; for (let i = 0; i < 4 && p; i++, p = p.parentElement) { const t = short(p.innerText, 100); if (t) return t; } return ''; };
    return {
      url: location.href,
      fileInputs: Array.from(document.querySelectorAll('input[type=file]')).map((e) => ({
        name: e.name, id: e.id, accept: e.accept, multiple: e.multiple, visible: vis(e),
        form: e.form ? { id: e.form.id, action: e.form.action, enctype: e.form.enctype } : null,
        onchange: short(e.getAttribute('onchange')), ctx: ctxOf(e) })),
      forms: Array.from(document.forms).map((f, i) => ({ i, id: f.id, action: f.action, enctype: f.enctype, n: f.elements.length,
        names: Array.from(f.elements).map((e) => e.name).filter(Boolean).filter((n) => !/\\[(english|french|italian|german|spanish|danish|ukrainian|russian|bulgarian|hungarian|indonesian|turkish|greek|norwegian|czech|japanese|polish|thai|swedish|schinese|tchinese|romanian|finnish|dutch|brazilian|portuguese|latam|vietnamese|arabic|koreana|malay)\\]$/.test(n) && !/supported_languages|sysreqs|category_|rgGenres/.test(n)).slice(0, 80) })),
      images: Array.from(document.querySelectorAll('img')).filter(vis).map((i) => ({ src: i.src, w: i.naturalWidth, h: i.naturalHeight, alt: i.alt, ctx: ctxOf(i) }))
        .filter((i) => !/\\/public\\/(images|shared)\\//.test(i.src)).slice(0, 60),
      dropzones: Array.from(document.querySelectorAll('[class*=drop i], [id*=drop i], [class*=upload i], [id*=upload i]')).filter(vis)
        .map((e) => ({ tag: e.tagName, id: e.id, cls: short(String(e.className), 80), text: short(e.innerText, 80) })).slice(0, 40),
      subtabs: Array.from(document.querySelectorAll('a[href*=subtab], [onclick*=subtab]')).map((a) => short((a.getAttribute('href') || a.getAttribute('onclick')) + ' | ' + a.innerText, 140)),
      scripts: Array.from(document.scripts).map((s) => s.src).filter(Boolean),
      inlineHints: Array.from(document.scripts).filter((s) => !s.src).map((s) => s.textContent)
        .flatMap((t) => (t.match(/[^;\\n]{0,80}(upload|ajax|screenshot|capsule|assets?)[^;\\n]{0,120}/gi) || [])).map((s) => short(s, 200)).slice(0, 60),
      text: short(document.querySelector('#tab_graphicalassets, [id*=graphicalassets]')?.innerText || '', 3000),
    };
  })()`);
  const out = join(cfg.stateDir, 'inspect', `probe-assets-${subtab}.json`);
  writeFileSync(out, JSON.stringify(data, null, 2));
  console.log(JSON.stringify(data, null, 1).slice(0, 20000));
} finally {
  await ctx.close();
}
