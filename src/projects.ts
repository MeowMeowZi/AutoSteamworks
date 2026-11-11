// 项目管理：网页上添加的游戏项目列表、新项目初始化、配置的读写（给网页的设置页用）。
// 配置文件仍然是 steam.config.yaml，网页只是把它做成表单；用 YAML Document 修改，保留注释。
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import YAML from 'yaml';
import { appHome, loadConfig } from './config.js';
import { STEAM_LANGS } from './local/storeFiles.js';
import { INBOX } from './local/inbox.js';

export const CONFIG_NAME = 'steam.config.yaml';
const PKG_ROOT = join(import.meta.dirname, '..');

// ---------------- 项目列表 ----------------

export interface ProjectRecord {
  /** steam.config.yaml 的绝对路径（还没初始化的项目也先记下将来的位置） */
  config: string;
  addedAt: string;
}

const registryPath = () => join(appHome(), 'projects.json');

export function listProjects(): ProjectRecord[] {
  const p = registryPath();
  if (!existsSync(p)) return [];
  try { return JSON.parse(readFileSync(p, 'utf8')).projects ?? []; } catch { return []; }
}

function saveProjects(list: ProjectRecord[]) {
  mkdirSync(appHome(), { recursive: true });
  writeFileSync(registryPath(), JSON.stringify({ projects: list }, null, 2));
}

/** 接受游戏项目文件夹或者配置文件路径，返回配置文件的绝对路径 */
export function configPathFor(input: string): string {
  const p = resolve(input.trim().replace(/^"|"$/g, ''));
  if (!existsSync(p)) throw new Error(`路径不存在：${p}`);
  if (statSync(p).isDirectory()) return join(p, CONFIG_NAME);
  if (/\.ya?ml$/i.test(p)) return p;
  throw new Error('请选择游戏项目的文件夹（或者其中的 steam.config.yaml）');
}

export function addProject(input: string): ProjectRecord {
  const config = configPathFor(input);
  const list = listProjects();
  const found = list.find((x) => x.config.toLowerCase() === config.toLowerCase());
  if (found) return found;
  const rec = { config, addedAt: new Date().toISOString() };
  saveProjects([...list, rec]);
  return rec;
}

/** 只从列表里移除，不删除任何文件 */
export function removeProject(config: string) {
  saveProjects(listProjects().filter((x) => x.config.toLowerCase() !== config.toLowerCase()));
}

/** 网页请求里带的项目必须在列表里，防止通过接口读写任意路径 */
export function requireProject(config: string | null | undefined): string {
  const rec = config && listProjects().find((x) => x.config.toLowerCase() === resolve(config).toLowerCase());
  if (!rec) throw new Error('未知项目，请先在“项目”页添加');
  return rec.config;
}

export function projectSummary(rec: ProjectRecord) {
  const dir = dirname(rec.config);
  const exists = existsSync(dir);
  const configured = existsSync(rec.config);
  let name = basename(dir), apps: { key: string; name?: string; appid: number }[] = [], error: string | undefined;
  if (configured) {
    try {
      const c = loadConfig(rec.config);
      apps = c.apps.map((a) => ({ key: a.key, name: a.name, appid: a.appid }));
      name = apps[0]?.name ?? name;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
  return { config: rec.config, dir, folder: basename(dir), name, exists, configured, apps, error };
}

// ---------------- 新项目初始化 ----------------

export interface InitOptions {
  name: string;
  appid: number;
  languages: string[];
  /** App 在配置里的 key，也是 apps/<key>/ 目录名 */
  key?: string;
}

const KEY_RE = /^[a-z0-9_-]+$/;

function checkLanguages(langs: unknown): string[] {
  if (!Array.isArray(langs) || !langs.length) throw new Error('至少选择一种语言');
  const bad = langs.filter((l) => !STEAM_LANGS.includes(l));
  if (bad.length) throw new Error(`不认识的语言：${bad.join(', ')}`);
  return langs as string[];
}

function checkAppid(v: unknown): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new Error('appid 必须是正整数（在 Steamworks 后台 App 名称旁边能看到）');
  return n;
}

/** 在项目文件夹里生成 steam.config.yaml、STEAM_RULES.md，并把 .autosw/ 加进 .gitignore。返回生成了哪些文件 */
export function initProject(config: string, o: InitOptions): string[] {
  if (existsSync(config)) throw new Error(`${config} 已经存在`);
  const dir = dirname(config);
  const key = o.key || 'game';
  if (!KEY_RE.test(key)) throw new Error('App 标识只能用小写字母、数字、- 和 _');
  if (!o.name?.trim()) throw new Error('请填写游戏名称');
  const doc = new YAML.Document({
    browser: { channel: 'msedge' },
    languages: checkLanguages(o.languages),
    apps: { [key]: { appid: checkAppid(o.appid), name: o.name.trim() } },
  });
  doc.commentBefore = ' AutoSteamworks 配置（可以在网页的“设置”里修改）。路径都相对于本文件所在的目录。';
  writeFileSync(config, doc.toString({ lineWidth: 0 }));
  const made = [CONFIG_NAME];
  // 图片收件箱：图片随便丢进来，网页上点“整理”自动分到各目录
  mkdirSync(join(dir, 'apps', key, 'assets', INBOX), { recursive: true });
  made.push(`apps/${key}/assets/${INBOX}/（图片丢这里，自动整理）`);

  const rules = join(dir, 'STEAM_RULES.md');
  if (!existsSync(rules)) { copyFileSync(join(PKG_ROOT, 'templates', 'STEAM_RULES.md'), rules); made.push('STEAM_RULES.md'); }
  for (const f of ensureAiPointer(dir)) made.push(`${f}（加了指向 STEAM_RULES.md 的说明）`);
  if (ensureGitignore(dir)) made.push('.gitignore（加了 .autosw/）');
  return made;
}

/**
 * 只用 App ID 新建项目时，项目文件夹放在这里（用户看得见的位置，方便往里丢图片、让 AI 改文件）。
 * 测试设了 AUTOSW_HOME 时放到它下面，避免碰到真实的用户目录。
 */
export const projectsRoot = () =>
  process.env.AUTOSW_PROJECTS ?? (process.env.AUTOSW_HOME ? join(process.env.AUTOSW_HOME, 'projects') : join(homedir(), 'AutoSteamworks'));

/** 只填 App ID（名称可选）：在 projectsRoot() 下建文件夹、初始化、加进列表。同一个 appid 已经有项目时直接返回那个 */
export function createProjectByAppid(o: { appid: unknown; name?: string; languages?: string[] }): { config: string; made: string[]; existed: boolean } {
  const appid = checkAppid(o.appid);
  for (const rec of listProjects()) {
    if (projectSummary(rec).apps.some((a) => a.appid === appid)) return { config: rec.config, made: [], existed: true };
  }
  const name = o.name?.trim() || `App ${appid}`;
  const safe = (o.name ?? '').trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/[. ]+$/, '');
  const dir = join(projectsRoot(), safe ? `${appid} ${safe}` : String(appid));
  const config = join(dir, CONFIG_NAME);
  mkdirSync(dir, { recursive: true });
  // 以前建过又从列表里移除了：配置还在，重新加进列表就行
  const made = existsSync(config) ? [] : initProject(config, { name, appid, languages: o.languages?.length ? o.languages : ['english', 'schinese'] });
  addProject(dir);
  return { config, made, existed: !made.length };
}

/** 快照、上传记录不该进游戏项目的 git。返回是否改了文件 */
export function ensureGitignore(dir: string): boolean {
  const gi = join(dir, '.gitignore');
  const text = existsSync(gi) ? readFileSync(gi, 'utf8') : '';
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  if (lines.some((l) => l === '.autosw/' || l === '.autosw' || l === '/.autosw/')) return false;
  appendFileSync(gi, (text && !text.endsWith('\n') ? '\n' : '') + '# AutoSteamworks 的本地状态\n.autosw/\n');
  return true;
}

// ---------------- 设置页：配置的读写 ----------------

export interface AppSettings {
  key: string;
  name: string;
  appid: number;
  /** 空数组 = 跟随项目的语言 */
  languages: string[];
  /** true / false / null（未设置） */
  screenshotsAllAges: boolean | null;
}

export interface Settings {
  languages: string[];
  browser: string;
  delayMs: number;
  ignoreFields: string[];
  apps: AppSettings[];
}

export function readSettings(config: string): Settings {
  const raw = YAML.parse(readFileSync(config, 'utf8')) ?? {};
  return {
    languages: raw.languages ?? ['english'],
    browser: raw.browser?.channel ?? 'msedge',
    delayMs: raw.partner?.delayMs ?? 1500,
    ignoreFields: raw.store?.ignoreFields ?? [],
    apps: Object.entries<any>(raw.apps ?? {}).map(([key, a]) => ({
      key,
      name: a?.name ?? '',
      appid: Number(a?.appid ?? 0),
      languages: a?.languages ?? [],
      screenshotsAllAges: a?.assets?.screenshotsAllAges ?? null,
    })),
  };
}

/** 把网页提交的设置写回配置。只改这些项，其他内容（构建配置、注释）原样保留 */
export function writeSettings(config: string, s: Settings) {
  const doc = YAML.parseDocument(readFileSync(config, 'utf8'));
  // deleteIn 在路径不存在时会抛错
  const del = (path: (string | number)[]) => { if (doc.hasIn(path)) doc.deleteIn(path); };
  doc.set('languages', checkLanguages(s.languages));
  if (!['msedge', 'chrome'].includes(s.browser)) throw new Error('浏览器只能是 msedge 或 chrome');
  doc.setIn(['browser', 'channel'], s.browser);
  const delay = Number(s.delayMs);
  if (!Number.isFinite(delay) || delay < 0) throw new Error('请求间隔必须是非负数');
  doc.setIn(['partner', 'delayMs'], delay);
  doc.setIn(['store', 'ignoreFields'], (s.ignoreFields ?? []).map((x) => String(x).trim()).filter(Boolean));

  if (!s.apps?.length) throw new Error('至少要有一个 App');
  const keys = s.apps.map((a) => a.key);
  if (new Set(keys).size !== keys.length) throw new Error('App 标识不能重复');
  const old = Object.keys(YAML.parse(readFileSync(config, 'utf8'))?.apps ?? {});
  for (const k of old.filter((k) => !keys.includes(k))) del(['apps', k]);
  for (const a of s.apps) {
    if (!KEY_RE.test(a.key)) throw new Error(`App 标识“${a.key}”只能用小写字母、数字、- 和 _`);
    doc.setIn(['apps', a.key, 'appid'], checkAppid(a.appid));
    if (a.name?.trim()) doc.setIn(['apps', a.key, 'name'], a.name.trim()); else del(['apps', a.key, 'name']);
    if (a.languages?.length) doc.setIn(['apps', a.key, 'languages'], checkLanguages(a.languages)); else del(['apps', a.key, 'languages']);
    if (a.screenshotsAllAges === null || a.screenshotsAllAges === undefined) del(['apps', a.key, 'assets', 'screenshotsAllAges']);
    else doc.setIn(['apps', a.key, 'assets', 'screenshotsAllAges'], !!a.screenshotsAllAges);
    // 删掉 screenshotsAllAges 后 assets 变成空的就整个删掉
    const assets = doc.getIn(['apps', a.key, 'assets']) as any;
    if (assets && YAML.isMap(assets) && assets.items.length === 0) del(['apps', a.key, 'assets']);
  }
  const text = doc.toString({ lineWidth: 0 });
  writeFileSync(config, text);
  loadConfig(config); // 写完再整体校验一次
}

// ---------------- AI 规则文件 ----------------

export const rulesPath = (config: string) => join(dirname(config), 'STEAM_RULES.md');

const templateRules = () => readFileSync(join(PKG_ROOT, 'templates', 'STEAM_RULES.md'), 'utf8').replace(/\r\n/g, '\n');
/** 规则文件里由用户（或 AI）填写的部分从这个标题开始，升级模板时原样保留 */
const STYLE_HEADING = '## 本项目的风格';
const generalPart = (text: string) => {
  const i = text.indexOf(STYLE_HEADING);
  return (i < 0 ? text : text.slice(0, i)).replace(/\r\n/g, '\n').trim();
};

export function readRules(config: string): { path: string; text: string; exists: boolean; outdated: boolean } {
  const path = rulesPath(config);
  const exists = existsSync(path);
  const text = exists ? readFileSync(path, 'utf8') : templateRules();
  return { path, exists, text, outdated: exists && generalPart(text) !== generalPart(templateRules()) };
}

export function writeRules(config: string, text: string) {
  writeFileSync(rulesPath(config), text);
}

/** 把规则文件的通用部分换成最新模板，保留“本项目的风格”一节；旧文件没有这一节时，把旧内容整个附在末尾 */
export function upgradeRules(config: string): string {
  const path = rulesPath(config);
  const tpl = templateRules();
  const old = existsSync(path) ? readFileSync(path, 'utf8').replace(/\r\n/g, '\n') : '';
  let text = tpl;
  if (old) {
    const i = old.indexOf(STYLE_HEADING);
    text = i >= 0
      ? tpl.slice(0, tpl.indexOf(STYLE_HEADING)) + old.slice(i)
      : tpl.trimEnd() + '\n\n## 旧规则文件的内容（请整理到上面后删除这一节）\n\n' + old;
  }
  writeFileSync(path, text);
  ensureAiPointer(dirname(config));
  return text;
}

const POINTER = `
## Steam 商店（AutoSteamworks）

修改 Steam 商店相关内容（steam.config.yaml、apps/*/store、apps/*/assets）前，先完整阅读 STEAM_RULES.md，并遵守里面的规则。
`;

/**
 * Claude Code 每次会自动读 CLAUDE.md，但不会自己去读 STEAM_RULES.md，所以在 CLAUDE.md 里加一段指引。
 * AGENTS.md（其他 AI 工具用的）存在时也加。返回改了哪些文件
 */
export function ensureAiPointer(dir: string): string[] {
  const changed: string[] = [];
  for (const name of ['CLAUDE.md', 'AGENTS.md']) {
    const p = join(dir, name);
    if (!existsSync(p)) {
      if (name === 'CLAUDE.md') { writeFileSync(p, POINTER.trimStart()); changed.push(name); }
      continue;
    }
    const text = readFileSync(p, 'utf8');
    if (text.includes('STEAM_RULES.md')) continue;
    appendFileSync(p, (text && !text.endsWith('\n') ? '\n' : '') + POINTER);
    changed.push(name);
  }
  return changed;
}

/**
 * 网页上“复制给 AI”的内容：本项目的现状 + 完整的规则。
 * 粘贴到游戏项目里的 AI 对话，AI 不用自己找文件也知道该做什么。
 */
export function aiPrompt(config: string): string {
  const dir = dirname(config);
  const rules = readRules(config);
  const check = `node "${join(PKG_ROOT, 'bin', 'autosw.js')}" -c "${config}" check`;
  const lines: string[] = [];
  let title = basename(dir);
  try {
    const c = loadConfig(config);
    title = c.apps[0]?.name || title;
    for (const a of c.apps) {
      const pulled = existsSync(join(a.storeDir, '_common.yaml'));
      lines.push(`- App \`${a.key}\`：appid ${a.appid}${a.name ? `，${a.name}` : ''}，语言 ${a.languages.join(', ')}；`
        + `商店文本在 ${a.storeDir}（${pulled ? '已从后台拉取' : '还没从后台拉取，写商店文本前要先请我在网页上点“从后台拉取”'}）；图片目录 ${a.assets.dir}`);
    }
  } catch (e) {
    lines.push(existsSync(config) ? `- 配置文件有错误：${(e as Error).message}` : '- 还没有配置文件，请我先在 AutoSteamworks 网页上初始化这个项目');
  }
  return [
    `你现在帮我在游戏项目「${title}」里准备 Steam 商店的内容。这个项目用 AutoSteamworks 把本地文件同步到 Steamworks 后台：你只改本地文件，上传由我在网页上完成。`,
    '',
    '项目信息：',
    `- 项目文件夹：${dir}`,
    `- 配置文件：${config}`,
    ...lines,
    `- 规则文件：${rules.path}`,
    `- 检查命令（改完必须运行）：${check}`,
    `- 整理图片命令（把 待分类/ 里的图片放到对应目录，先加 -n 演练）：${check.replace(/ check$/, ' sort-images')}`,
    '',
    '这次的任务：先完整阅读下面的规则，然后按“工作流程”从第 1 步开始，把能从项目资料里得到的配置、商店文本和图片都准备好。需要我提供的信息（appid、构建账号、价格、发售日期等）就直接问我，不要编。',
    '',
    '========== 以下是 STEAM_RULES.md ==========',
    '',
    rules.text.replace(/\r\n/g, '\n').trimEnd(),
  ].join('\n');
}
