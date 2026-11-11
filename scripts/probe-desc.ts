// 只读：看描述页上的文本编辑器是什么结构（textarea / 隐藏字段 / contenteditable），以及本地化按钮
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { gotoPartner, openBrowser } from '../src/browser.js';

const cfg = loadConfig();
const app = cfg.apps[0];
const { ctx, page } = await openBrowser(cfg, true);
try {
  await gotoPartner(page, `https://partner.steamgames.com/admin/game/editbyappid/${app.appid}?activetab=tab_description`);
  const data = await page.evaluate(`(() => {
    const short = (s) => (s || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
    const desc = (el) => ({ tag: el.tagName.toLowerCase(), type: el.type, name: el.name || null, id: el.id || null,
      cls: (el.className && el.className.baseVal === undefined ? el.className : '').slice(0, 80),
      form: Array.from(document.forms).indexOf(el.form), visible: !!(el.offsetWidth || el.offsetHeight), len: (el.value || el.innerText || '').length,
      value: short(el.value !== undefined ? el.value : el.innerText) });
    return {
      textareas: Array.from(document.querySelectorAll('textarea')).map(desc),
      editable: Array.from(document.querySelectorAll('[contenteditable=true]')).map(desc),
      hidden: Array.from(document.querySelectorAll('input[type=hidden]')).filter((e) => e.name && !/^sessionid$/.test(e.name)).map(desc),
      forms: Array.from(document.forms).map((f, i) => ({ i, id: f.id, action: f.action, method: f.method, n: f.elements.length })),
      locButtons: Array.from(document.querySelectorAll('#downloadLocButton, button')).filter((b) => /本地化|locali/i.test(b.innerText)).map((b) => ({ id: b.id, text: short(b.innerText), onclick: short(b.getAttribute('onclick')) })),
      tabs: Array.from(document.querySelectorAll('[id^=tab_], a[href*=activetab]')).map((t) => short(t.id + ' ' + (t.getAttribute('href') || '') + ' ' + t.innerText)).slice(0, 30),
      langSelectors: Array.from(document.querySelectorAll('select')).filter((s) => Array.from(s.options).some((o) => o.value === 'schinese')).map((s) => ({ name: s.name, id: s.id, onchange: short(s.getAttribute('onchange')), value: s.value })),
    };
  })()`);
  const out = join(cfg.stateDir, 'inspect', 'probe-desc.json');
  writeFileSync(out, JSON.stringify(data, null, 2));
  console.log(JSON.stringify(data, null, 1).slice(0, 12000));
} finally {
  await ctx.close();
}
