// 切换机构 → 读关联项目页面（只读）→ 切回原机构。用后台自己的“切换 Steamworks 机构”表单，记录它发出的请求。
// 用法：npx tsx scripts/probe-org-switch.ts <目标机构 id> <appid ...>
import { writeFileSync } from 'node:fs';
import type { Page } from 'playwright-core';
import { loadConfig } from '../src/config.js';
import { gotoPartner, openBrowser, settle } from '../src/browser.js';

const [target, ...appids] = process.argv.slice(2);
const cfg = loadConfig();
const { ctx, page } = await openBrowser(cfg, true);
const requests: { method: string; url: string; body: string | null }[] = [];
page.on('request', (r) => {
  if (r.method() !== 'GET' || /publisher|partner/i.test(r.url())) requests.push({ method: r.method(), url: r.url(), body: r.postData() });
});

const currentOrg = (p: Page) => p.evaluate(`(document.querySelector('select[name="publisher"] option[selected]') || {}).value || null`) as Promise<string | null>;

async function switchTo(org: string) {
  const before = requests.length;
  await page.evaluate(`(() => {
    const sel = document.querySelector('select[name="publisher"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(sel, ${JSON.stringify(org)});
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    sel.form.requestSubmit();
  })()`);
  await page.waitForTimeout(4000);
  await settle(page);
  return requests.slice(before).filter((r) => r.method !== 'GET' || /publisher/i.test(r.url));
}

const log: Record<string, unknown> = {};
try {
  await gotoPartner(page, `https://partner.steamgames.com/apps/associated/${appids[0]}`);
  const original = await currentOrg(page);
  log.original = original;
  log.switchRequests = await switchTo(target);
  for (const appid of appids) {
    await gotoPartner(page, `https://partner.steamgames.com/apps/associated/${appid}`);
    log[appid] = await page.evaluate(`(() => ({
      org: (document.querySelector('select[name="publisher"] option[selected]') || {}).value || null,
      warning: /没有此应用的正确权限/.test(document.body.innerText),
      sections: Array.from(document.querySelectorAll('h1,h2,h3,h4')).map((h) => (h.innerText || '').trim()).filter(Boolean),
      appLinks: Array.from(document.querySelectorAll('a')).map((a) => ({ text: (a.innerText || '').trim().slice(0, 80), href: a.href }))
        .filter((l) => /\\/apps\\/landing\\/|editbyappid|\\/admin\\/game\\/|\\/apps\\/associated\\//.test(l.href)),
      text: document.body.innerText.slice(0, 6000),
      html: document.documentElement.outerHTML,
    }))()`);
  }
  if (original) {
    log.switchBackRequests = await switchTo(original);
    await gotoPartner(page, `https://partner.steamgames.com/apps/associated/${appids[0]}`);
    log.finalOrg = await currentOrg(page);
  }
} finally {
  writeFileSync('.autosw/inspect/probe-org-switch.json', JSON.stringify(log, null, 1));
  console.log('已写入 .autosw/inspect/probe-org-switch.json');
  await ctx.close();
}
