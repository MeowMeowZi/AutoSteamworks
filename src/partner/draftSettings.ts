import { createHash } from 'node:crypto';
import type { Page } from 'playwright-core';
import type { AppConfig, Config } from '../config.js';
import { gotoPartner } from '../browser.js';
import { logoMatches, matchingShots, type DraftValue } from '../local/draftSettings.js';
import { openAssetsPage } from './assets.js';
import { storeEditUrl } from './store.js';

const languageIds = ['english', 'german', 'french', 'italian', 'koreana', 'spanish', 'schinese', 'tchinese', 'russian', 'thai',
  'japanese', 'portuguese', 'polish', 'danish', 'dutch', 'finnish', 'norwegian', 'swedish', 'hungarian', 'czech', 'romanian',
  'turkish', 'brazilian', 'bulgarian', 'greek', 'arabic', 'ukrainian', 'latam', 'vietnamese', '', 'indonesian', 'malay'];

async function survey(page: Page, url: string, descriptions: Record<string, string>) {
  async function openDescription() {
    await gotoPartner(page, url);
    const tab = page.getByText(/^(生成式人工智能\s*[（(]AI[）)]|Generative (?:Artificial Intelligence|AI).*)$/i).first();
    await tab.click({ timeout: 15000 }).catch(() => { throw new Error('无法打开内容调查的 AI 栏目，请在 Steamworks 确认调查草稿可以访问'); });
    const heading = page.getByRole('heading', { name: /^(商店页面描述|Store Page Description)/i });
    const block = heading.locator('xpath=ancestor::div[.//textarea and .//select][1]');
    await block.locator('textarea').waitFor({ timeout: 8000 }).catch(() => { throw new Error('内容调查没有显示 AI 商店页面描述，请在 Steamworks 核对本栏已有回答'); });
    return { language: block.locator('select'), text: block.locator('textarea') };
  }
  const edit = await openDescription();
  let different = false;
  for (const [lang, text] of Object.entries(descriptions)) {
    await edit.language.selectOption(String(languageIds.indexOf(lang)));
    if (await edit.text.inputValue() === text) continue;
    different = true;
    await edit.text.fill(text);
    await edit.text.blur();
  }
  if (!different) return false;
  // 只保存本栏目。下一页是分级发布页，不操作该页。
  const save = page.getByRole('button', { name: /^(保存并继续|保存更改|继续查看\s*发布分级|Save (?:Changes|and Continue)|Continue to .*Publish)/i });
  if (await save.count() !== 1 || !(await save.isEnabled())) throw new Error('AI 栏目暂时无法保存，请核对 Steamworks 显示的必填问题');
  await save.click();
  await edit.text.waitFor({ state: 'hidden' });
  const check = await openDescription();
  for (const [lang, text] of Object.entries(descriptions)) {
    await check.language.selectOption(String(languageIds.indexOf(lang)));
    if (await check.text.inputValue() !== text) throw new Error('重新打开内容调查后，' + lang + ' 披露文案未保存');
  }
  return true;
}

async function clientIcon(page: Page, url: string, appid: number, v: Extract<DraftValue, { kind: 'icon' }>) {
  await gotoPartner(page, url);
  const form = page.locator('form').filter({ has: page.locator(`input[name=requestType][value="${v.requestType}"]`) });
  if (await form.count() !== 1 || await form.locator('[name=appID]').inputValue() !== String(appid)) throw new Error('找不到此 App 对应的图标上传表单');
  const img = form.locator(v.requestType === 'icon' ? '#appIconFull' : '#appIco');
  async function currentPath() {
    if (await img.count() === 0) return '';
    const src = await img.getAttribute('src');
    return src ? new URL(src, url).pathname : '';
  }
  // Steam 用原始 PNG 的 SHA-1 命名生成的 ICO，回读时可能多一层 /gfxproxy/appgfx 前缀。
  const shortcutPath = v.requestType === 'clienticon'
    ? `/apps/${appid}/${createHash('sha1').update(v.bytes).digest('hex')}.ico` : undefined;
  if (shortcutPath && (await currentPath()).toLowerCase().endsWith(shortcutPath)) return false;
  const file = form.locator('input[type=file][name=image]');
  if (await file.count() !== 1) throw new Error('后台缺少图标文件输入框');
  if (v.requestType === 'clienticon') await form.locator('[name=addappicon]').uncheck();
  await file.setInputFiles({ name: v.filename, mimeType: v.requestType === 'icon' ? 'image/jpeg' : 'image/png', buffer: v.bytes });
  const action = await form.evaluate(f => (f as HTMLFormElement).action);
  if (new URL(action).origin !== new URL(url).origin) throw new Error('图标表单的保存地址有误');
  const [response] = await Promise.all([
    page.waitForResponse(r => r.url() === action && r.request().method() === 'POST'),
    form.locator('[type=submit]').click(),
  ]);
  if (!response.ok()) throw new Error('图标上传失败（HTTP ' + response.status() + '）');
  // 后台 iframe 的回调先替换预览，再从新打开的客户端图片页核对同一资源。
  const result = await response.text();
  const parsed = await page.evaluate((body) => {
    try { return JSON.parse(body); } catch { return JSON.parse(new DOMParser().parseFromString(body, 'text/html').body.textContent || '{}'); }
  }, result);
  const saved = parsed.images?.[v.requestType];
  if (typeof saved !== 'string' || !saved) throw new Error('后台未返回此图标的保存结果');
  await gotoPartner(page, url);
  const path = await currentPath();
  if (shortcutPath && /\/apps\/\d+\/[\da-f]{40}\.ico$/i.test(path)) {
    if (!path.toLowerCase().endsWith(shortcutPath)) throw new Error('回读的快捷方式图标未匹配此 App 的本地 PNG 指纹');
  } else if (!path || path !== new URL(decodeURIComponent(saved), url).pathname) {
    throw new Error('重新打开客户端图片页后，图标与上传结果不一致');
  }
  return true;
}

async function storeSetting(page: Page, c: Config, app: AppConfig, v: Extract<DraftValue, { kind: 'category' | 'logo' }>) {
  async function read() {
    await openAssetsPage(page, c, app);
    const raw = await page.locator('input[name=serialized_app_data]').inputValue();
    return JSON.parse(raw).assets ?? {};
  }
  const before = await read();
  let fields: Record<string, string>;
  if (v.kind === 'logo') {
    if (logoMatches(before.library_logo?.logo_position, v)) return false;
    if (!before.library_logo?.image?.english || !before.library_hero?.image?.english) throw new Error('库徽标放置需要先上传英文基础徽标和库主页图');
    const prefix = 'app[assets][library_logo][logo_position]';
    fields = { [prefix + '[pinned_position]']: v.anchor, [prefix + '[width_pct]']: String(v.width), [prefix + '[height_pct]']: String(v.height) };
  } else {
    const matches = matchingShots(before, v.sha1);
    if (matches.length !== 1) throw new Error(matches.length ? '后台存在多张相同截图，无法确定应修改哪一张' : '后台未找到此原图，请先勾选上传对应截图');
    const field = `app[assets][screenshots][${matches[0][0]}][category]`;
    const select = page.locator(`select[name="${field}"]`);
    if (!(await select.locator(`option[value="${v.category}"]`).count())) throw new Error('后台没有对应的截图分类选项');
    if (await select.inputValue() === v.category) return false;
    fields = { [field]: v.category };
  }
  const form = page.locator(c.formSelector);
  const action = await form.evaluate(f => (f as HTMLFormElement).action);
  if (new URL(action).origin !== new URL(page.url()).origin) throw new Error('草稿表单的保存地址有误');
  const status = await form.evaluate(async (el, fields) => {
    const form = el as HTMLFormElement;
    const body = new FormData();
    body.set('sessionid', (form.elements.namedItem('sessionid') as HTMLInputElement).value);
    body.set('json', '1');
    for (const [key, value] of Object.entries(fields)) body.set(key, value);
    return (await fetch(form.action, { method: 'POST', body, credentials: 'same-origin' })).status;
  }, fields);
  if (status < 200 || status >= 300) throw new Error('保存失败（HTTP ' + status + '）');
  const after = await read();
  if (v.kind === 'logo' ? !logoMatches(after.library_logo?.logo_position, v)
    : !(matchingShots(after, v.sha1).some(([, s]) => (s as any).category === v.category))) throw new Error('重新读取商店草稿后，设置与预期不一致');
  return true;
}

export async function applyDraftSetting(page: Page, c: Config, app: AppConfig, value: DraftValue) {
  const origin = new URL(storeEditUrl(c, app)).origin;
  if (value.kind === 'survey') return survey(page, `${origin}/contentsurvey/edit/${app.appid}/`, value.descriptions);
  if (value.kind === 'icon') return clientIcon(page, `${origin}/apps/clientimages/${app.appid}`, app.appid, value);
  return storeSetting(page, c, app, value);
}
