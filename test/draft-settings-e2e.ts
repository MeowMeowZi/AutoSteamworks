import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright-core';
import { openSurveyDescription } from '../src/partner/draftSettings.js';
import { startUi } from '../src/ui/server.js';
import { png } from './png.js';

const ws = mkdtempSync(join(tmpdir(), 'autosw-draft-'));
process.env.AUTOSW_HOME = join(ws, 'home');
const shot = png(1920, 1080);
const sha = createHash('sha1').update(shot).digest('hex');
const shots = [{ english: 'other/ss_other.jpg', category: 'gamemenu' }, { english: `${sha}/ss_${sha}.jpg`, category: '' }];
const assets = { library_logo: { image: { english: 'logo.png' }, logo_position: {} as Record<string, string> },
  library_hero: { image: { english: 'hero.png' } }, screenshots: shots };
const disclosures: Record<string, string> = { '2': 'Conserver cette traduction' };
const icons: Record<string, string> = {};
const posts: string[] = [];
let rejectIcon = true;
let rejectShortcut = false;
let surveyAccess: 'direct' | 'viaLanding' | 'unavailable' = 'direct';
let surveyLinkVisits = 0;
const server = createServer(async (req, res) => {
  const path = new URL(req.url!, 'http://localhost').pathname;
  const html = (str: string) => res.writeHead(200, { 'content-type': 'text/html;charset=utf-8' }).end(str);
  if (req.method === 'POST') {
    posts.push(path);
    if (path === '/survey/save') {
      let s = '';
      for await (const chunk of req) s += chunk;
      Object.assign(disclosures, JSON.parse(s));
      return res.end('ok');
    }
    const chunks: Buffer[] = [];
    for await (const ch of req) chunks.push(ch);
    const fd = await new Request('http://localhost', { method: 'POST', body: Buffer.concat(chunks), headers: { 'content-type': req.headers['content-type']! } }).formData();
    if (path === '/save') {
      assert.equal(fd.get('sessionid'), 'test');
      assert.equal(fd.get('app[name]'), null, '只保存指定字段');
      for (const [name, val] of fd) {
        const match = name.match(/^app\[assets\]\[screenshots\]\[(\d+)\]\[category\]$/);
        if (match) shots[Number(match[1])].category = String(val);
        const pos = name.match(/^app\[assets\]\[library_logo\]\[logo_position\]\[(\w+)\]$/);
        if (pos) assets.library_logo.logo_position[pos[1]] = String(val);
      }
      return res.end('{}');
    }
    if (path === '/images/upload') {
      assert.equal(fd.get('addappicon'), null, '单独上传快捷方式时保留独立应用图标');
      const type = String(fd.get('requestType'));
      const file = fd.get('image') as File;
      assert.equal(file.name, type === 'clienticon' ? 'shortcut.png' : 'app.jpg');
      const hash = createHash('sha1').update(Buffer.from(await file.arrayBuffer())).digest('hex');
      const src = type === 'clienticon' ? `/apps/100/${hash}.ico` : '/icons/icon.jpg';
      if (type === 'clienticon') {
        if (!rejectShortcut) icons[type] = '/gfxproxy/appgfx' + src + '?v=1';
      } else if (!rejectIcon) icons[type] = src;
      return html(JSON.stringify({ images: { [type]: src } }));
    }
    return res.writeHead(404).end();
  }
  if (path === '/apps/landing/100') return html(`<p>您当前视图中所设置的组织并没有此应用的正确权限</p>
    <a href="/contentsurvey/edit/200/">其他应用</a><a href="/contentsurvey/edit/100/">内容调查</a>`);
  if (path === '/contentsurvey/edit/100/') {
    const viaLanding = req.headers.referer === origin + '/apps/landing/100';
    if (viaLanding) surveyLinkVisits++;
    if (surveyAccess === 'unavailable' || (surveyAccess === 'viaLanding' && !viaLanding))
      return html('<p>我们无法加载此应用的内容调查。这是我方的问题。</p>');
    return html(`<div role="button" tabindex="0" onclick="this.hidden=true;panel.hidden=false"><div>
    <div>栏目未完成</div><div>已选择的主题：1</div></div>生成式人工智能（AI）</div>
    <section id="panel" hidden><div><h1>商店页面描述 *</h1><select id="lang"><option value="0">英语</option><option value="6">简体中文</option></select><textarea id="desc"></textarea></div>
    <button id="save">保存并继续</button></section><script>
    const values=${JSON.stringify(disclosures)};desc.value=values[lang.value]||'';
    lang.onchange=()=>desc.value=values[lang.value]||'';desc.oninput=()=>values[lang.value]=desc.value;
    save.onclick=async()=>{await fetch('/survey/save',{method:'POST',body:JSON.stringify(values)});panel.hidden=true};
    </script>`);
  }
  if (path === '/apps/clientimages/100') return html(['clienticon', 'icon'].map(type => `<form action="/images/upload" method="post" enctype="multipart/form-data" target="answer">
    <input name="requestType" type="hidden" value="${type}"><input name="appID" type="hidden" value="100">
    <img id="${type === 'icon' ? 'appIconFull' : 'appIco'}" src="${icons[type] || '/placeholder.jpg'}">
    ${type === 'clienticon' ? '<input type="checkbox" name="addappicon" checked>' : ''}
    <input name="image" type="file"><input type="submit"></form>`).join('') + '<iframe name="answer"></iframe>');
  if (path === '/store/100') return html(`<form action="/save" id="gameform">
    <input type="hidden" name="sessionid" value="test"><input type="hidden" name="app[name]" value="example">
    <input type="hidden" name="serialized_app_data" value="${JSON.stringify({ assets }).replace(/"/g, '&quot;')}">
    ${shots.map((s, i) => `<select name="app[assets][screenshots][${i}][category]">${['', 'gameplay', 'gamemenu'].map(cat => `<option value="${cat}" ${cat === s.category ? 'selected' : ''}>${cat}</option>`).join('')}</select>`).join('')}
    </form><script>var g_sessionID='test',g_ImageTypes=[{name:'Screenshot',tab:'screenshot',path:'screenshot|assets|screenshots|',width:1920,height:1080}];function IsImageTypeValid(){return true}</script>`);
  res.writeHead(404).end();
});
await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok));
const origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
const project = join(ws, 'steam.config.yaml');
writeFileSync(project, `browser: { profileDir: profile }\npartner: {storeEditUrl: '${origin}/store/{appid}', delayMs: 0}\nlanguages: [english, schinese]\napps: { game: { appid: 100, assets: { screenshotsAllAges: true } } }`);
const put = (name: string, bytes: string | Buffer) => {
  const path = join(ws, 'apps/game', name);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, bytes);
};
put('store/_steamworks.yaml', 'aiDescription: { english: "Artwork", schinese: "宣传美术" }\nscreenshotCategories: { shot.png: gameplay }\nlogoPlacement: { anchor: BottomLeft, width: 22, height: 32 }');
put('assets/screenshots/shot.png', shot);
put('assets/client-icons/shortcut.png', png(256, 256));
const ui = await startUi({ port: 0, open: project });
const browser = await chromium.launch({ channel: 'msedge' });
try {
  const page = await browser.newPage();
  const edit = await openSurveyDescription(page, origin, 100);
  assert.ok(await edit.text.isVisible());
  assert.equal(surveyLinkVisits, 0, '直接打开成功时不需要再访问应用管理页');
  surveyAccess = 'unavailable';
  await assert.rejects(openSurveyDescription(page, origin, 100), /Steamworks 未能加载.*当前机构权限不符/);
  assert.equal(surveyLinkVisits, 1);
  assert.deepEqual(posts, [], '调查不可访问时不提交');
  surveyAccess = 'viaLanding';
  const jpg = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = canvas.height = 184; return canvas.toDataURL('image/jpeg').split(',')[1]; });
  put('assets/client-icons/app.jpg', Buffer.from(jpg, 'base64'));
  page.on('dialog', dialog => dialog.accept());
  await page.goto(ui.url);
  await page.locator('button[data-tab=draft]').click();
  const rows = page.locator('#main [data-pick]');
  assert.equal(await rows.count(), 5);
  await page.locator('[data-pickall="1"]').click();
  await page.locator('[data-upload=dry]').click();
  await page.locator('.result.dry').waitFor();
  assert.match(await page.locator('.result.dry').innerText(), /宣传美术/);
  assert.deepEqual(posts, []);
  await page.locator('[data-upload=real]').click();
  await page.locator('.result.fail').waitFor();
  assert.match(await page.locator('.result.fail').innerText(), /图标与上传结果不一致/);
  assert.match(await page.locator('#log').textContent() ?? '', /从此 App 的管理页重新进入.*正在填写 english.*正在填写 schinese.*正在提交 AI 描述.*正在重新打开调查草稿/s);
  assert.deepEqual(disclosures, { '0': 'Artwork', '6': '宣传美术', '2': 'Conserver cette traduction' });
  assert.equal(surveyLinkVisits, 3, '填写与保存后回读都能从目标 App 的内容调查链接进入');
  assert.equal(posts.filter(s => s === '/survey/save').length, 1, '重开调查不会重复提交');
  assert.deepEqual(shots.map(x => x.category), ['gamemenu', 'gameplay']);
  assert.deepEqual(assets.library_logo.logo_position, { pinned_position: 'BottomLeft', width_pct: '22', height_pct: '32' });
  assert.equal(posts.filter(s => s === '/save').length, 2, '已有截图没有重传');
  assert.equal(await rows.evaluateAll(es => es.filter(e => (e as HTMLInputElement).checked).length), 1, '仅核对失败的图标仍待推送');
  rejectIcon = false;
  await page.locator('[data-upload=real]').click();
  await page.locator('.result.ok').waitFor();
  assert.equal(posts.filter(s => s === '/images/upload').length, 3, '重试只传失败的一项');
  assert.equal(await rows.evaluateAll(es => es.filter(e => (e as HTMLInputElement).checked).length), 0);

  // 模拟旧版本误报后用户再次核对，已保存的同一张 PNG 应只读回，不发新的上传请求。
  const shortcut = page.locator('[data-pick="again:@draft/clienticon"]');
  await shortcut.check();
  await page.locator('[data-upload=real]').click();
  await page.locator('.result.ok').getByText(/快捷方式图标：后台已有相同设置/).waitFor();
  assert.equal(posts.filter(s => s === '/images/upload').length, 3);

  // 另一个 App 的同名 ICO、以及本 App 的旧 ICO 都不能算核对成功。
  const correct = icons.clienticon;
  for (const wrong of [correct.replace('/apps/100/', '/apps/200/'), correct.replace(/[a-f0-9]{40}/, '0'.repeat(40))]) {
    icons.clienticon = wrong;
    rejectShortcut = true;
    await page.locator('[data-dismiss]').click();
    await shortcut.check();
    await page.locator('[data-upload=real]').click();
    await page.locator('.result.fail').getByText(/快捷方式图标.*未匹配/).waitFor();
  }
  assert.equal(posts.filter(s => s === '/images/upload').length, 5);
  console.log('✓ 内容调查、截图类别、库徽标放置与客户端图标端到端测试通过');
} finally {
  await browser.close();
  ui.close(); server.closeAllConnections(); server.close();
  rmSync(ws, { recursive: true, force: true });
}
