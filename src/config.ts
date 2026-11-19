// 项目配置：steam.config.yaml 的唯一读写入口。
// 默认值（DEFAULTS）和继承规则（App 自己的 → 顶层 → 默认）只写在这里；
// loadConfig 给同步用（全部算好），readSettings / writeSettings 给网页设置页用（保留“空 = 跟随项目”），
// addAppLanguages / createConfig 是另外两种写入。写入都用 YAML Document，保留注释。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import YAML from 'yaml';
import { STEAM_LANGS } from './local/storeFiles.js';

export interface DepotConfig {
  id: number;
  /** 本地内容目录（绝对路径） */
  contentRoot: string;
  exclude: string[];
}

export interface BuildConfig {
  /** 构建完成后设为该分支的 live 版本（不能是 default 分支，这是 Steam 的限制） */
  setLive?: string;
  depots: DepotConfig[];
}

export interface StoreConfig {
  /** 存成单独 .bbcode 文件的本地化字段（路径写法见 README，支持 * 通配），其余放 <语言>/_fields.yaml */
  files: string[];
  /** 不同步的字段 name（支持 * 通配），在内置忽略列表之外追加 */
  ignoreFields: string[];
}

export interface AssetsConfig {
  /** 本地图片目录（绝对路径） */
  dir: string;
  /** 截图是否适合所有年龄（Steam 要求每张截图都要声明）。未设置时不允许上传截图 */
  screenshotsAllAges?: boolean;
}

export interface AppConfig {
  key: string;
  appid: number;
  name?: string;
  /** 要同步的商店语言（Steam API 名）。其他语言的字段不拉取、不推送 */
  languages: string[];
  /** 该 App 本地商店内容的目录（绝对路径） */
  storeDir: string;
  store: StoreConfig;
  assets: AssetsConfig;
  build?: BuildConfig;
  /**
   * 继承的 App（Demo → 正式版，配置里写 inherits: <key>）。只有一层。
   * 本地文本和图片没单独写的就用它的（规则见 local/storeFiles.ts 的 readLocal 和 local/imageCells.ts 的 scanCells）
   */
  inherits?: AppConfig;
  /** 商店 itemid（编辑页地址里的数字）。添加 Demo 时写入，关联到正式版要用 */
  itemid?: number;
  /** 快照文件：上次拉取 / 推送时线上的值 */
  snapshotFile: string;
}

export interface Config {
  /** 配置文件的绝对路径 */
  file: string;
  root: string;
  stateDir: string;
  /** 浏览器配置文件目录（里面有登录 Cookie） */
  profileDir: string;
  browserChannel: string;
  /** 商店编辑页地址，{appid} 会被替换 */
  storeEditUrl: string;
  /** 商店编辑页上承载所有数据的表单 */
  formSelector: string;
  /** 两次页面加载之间的间隔（毫秒），避免请求太频繁 */
  delayMs: number;
  steamcmdPath: string;
  steamUser?: string;
  apps: AppConfig[];
}

export const CONFIG_NAME = 'steam.config.yaml';

/** 工具自己的全局目录（项目列表、共用的登录信息）。测试时用 AUTOSW_HOME 指到临时目录 */
export const appHome = () => process.env.AUTOSW_HOME ?? join(homedir(), '.autosteamworks');

export const DEFAULT_STORE_EDIT_URL = 'https://partner.steamgames.com/admin/game/editbyappid/{appid}';
export const DEFAULT_STORE_FILES = ['about', 'short_description', 'legal', 'earlyaccess.*', 'sections.*.content'];

/** 配置里没写时用的值。别处不要再写一遍 */
export const DEFAULTS = {
  languages: ['english'],
  browserChannel: 'msedge',
  delayMs: 1500,
  storeEditUrl: DEFAULT_STORE_EDIT_URL,
  formSelector: '#gameform',
  storeFiles: DEFAULT_STORE_FILES,
  stateDir: '.autosw',
  steamcmdPath: 'steamcmd',
};

/** 所有项目共用的登录目录 */
export const sharedProfileDir = () => join(appHome(), 'profile');

/** 没有配置文件时（网页上直接登录）用的浏览器设置 */
export const defaultBrowser = (): Pick<Config, 'profileDir' | 'browserChannel'> =>
  ({ profileDir: sharedProfileDir(), browserChannel: DEFAULTS.browserChannel });

// ---------------- 继承规则（raw = YAML 解析出来的原始对象） ----------------

type Raw = any;
const readRaw = (file: string): Raw => YAML.parse(readFileSync(file, 'utf8')) ?? {};

// 继承的 App（Demo）没写的项先跟它继承的 App（正式版），再跟顶层
const parentOf = (raw: Raw, key: string): string | undefined => raw.apps?.[key]?.inherits;
const topLanguages = (raw: Raw): string[] => raw.languages ?? DEFAULTS.languages;
const appLanguages = (raw: Raw, key: string): string[] => {
  const p = parentOf(raw, key);
  return raw.apps?.[key]?.languages ?? (p ? appLanguages(raw, p) : topLanguages(raw));
};
/** App 自己的 → 继承的 App → 顶层 assets.screenshotsAllAges；都没写是 undefined */
const appScreenshotsAllAges = (raw: Raw, key: string): boolean | undefined => {
  const p = parentOf(raw, key);
  return raw.apps?.[key]?.assets?.screenshotsAllAges ?? (p ? appScreenshotsAllAges(raw, p) : raw.assets?.screenshotsAllAges);
};
const appStoreFiles = (raw: Raw, key: string): string[] => {
  const p = parentOf(raw, key);
  return raw.apps?.[key]?.store?.files ?? (p ? appStoreFiles(raw, p) : raw.store?.files ?? DEFAULTS.storeFiles);
};
/** 顶层的、继承的 App 的、App 自己的合在一起 */
const appIgnoreFields = (raw: Raw, key: string): string[] => {
  const p = parentOf(raw, key);
  return [...new Set([...(p ? appIgnoreFields(raw, p) : raw.store?.ignoreFields ?? []), ...(raw.apps?.[key]?.store?.ignoreFields ?? [])])];
};

/** inherits 只能指向配置里另一个、自己不继承的 App（只有一层，不能指向自己） */
function checkInherits(raw: Raw) {
  for (const [key, a] of Object.entries<any>(raw.apps ?? {})) {
    const p = a?.inherits;
    if (p === undefined) continue;
    if (p === key) throw new Error(`apps.${key}.inherits 不能指向自己`);
    if (!raw.apps?.[p]) throw new Error(`apps.${key}.inherits 指向的 App“${p}”不存在`);
    if (raw.apps[p]?.inherits) throw new Error(`apps.${key}.inherits 指向的“${p}”自己也继承了别的 App，只支持一层`);
  }
}

// ---------------- 读：给同步用 ----------------

export function loadConfig(path = CONFIG_NAME): Config {
  const file = resolve(path);
  if (!existsSync(file)) {
    throw new Error(`找不到配置文件 ${file}，可以先运行 \`npm run autosw -- init\``);
  }
  const raw = readRaw(file);
  const root = dirname(file);
  const abs = (p: string) => resolve(root, p);
  checkInherits(raw);
  const stateDir = abs(raw.stateDir ?? DEFAULTS.stateDir);

  const apps: AppConfig[] = Object.entries<any>(raw.apps ?? {}).map(([key, a]) => {
    if (!a?.appid) throw new Error(`apps.${key} 缺少 appid`);
    return {
      key,
      appid: Number(a.appid),
      name: a.name,
      itemid: a.itemid ? Number(a.itemid) : undefined,
      snapshotFile: join(stateDir, 'snapshots', `${key}.json`),
      languages: appLanguages(raw, key),
      storeDir: abs(a.store?.dir ?? `apps/${key}/store`),
      store: { files: appStoreFiles(raw, key), ignoreFields: appIgnoreFields(raw, key) },
      assets: {
        dir: abs(a.assets?.dir ?? `apps/${key}/assets`),
        screenshotsAllAges: appScreenshotsAllAges(raw, key),
      },
      build: a.build && {
        setLive: a.build.setLive,
        depots: (a.build.depots ?? []).map((d: any) => ({
          id: Number(d.id),
          contentRoot: abs(d.contentRoot),
          exclude: d.exclude ?? [],
        })),
      },
    };
  });
  if (apps.length === 0) throw new Error('配置里没有任何 apps');
  for (const app of apps) {
    const p = raw.apps[app.key].inherits;
    if (p) app.inherits = apps.find((x) => x.key === p);
  }

  // 默认所有游戏项目共用一个登录（同一个 Steamworks 账号）；项目里已有旧的 profile 时继续用它
  const legacyProfile = join(stateDir, 'profile');
  const profileDir = raw.browser?.profileDir ? abs(raw.browser.profileDir)
    : existsSync(legacyProfile) ? legacyProfile : sharedProfileDir();
  return {
    file,
    root,
    stateDir,
    profileDir,
    browserChannel: raw.browser?.channel ?? DEFAULTS.browserChannel,
    storeEditUrl: raw.partner?.storeEditUrl ?? DEFAULTS.storeEditUrl,
    formSelector: raw.partner?.formSelector ?? DEFAULTS.formSelector,
    delayMs: raw.partner?.delayMs ?? DEFAULTS.delayMs,
    steamcmdPath: raw.steamcmd?.path ?? DEFAULTS.steamcmdPath,
    steamUser: raw.steamcmd?.user,
    apps,
  };
}

/** 按 key 或 appid 选 App；不传就是全部。继承别人的 App（Demo）排在后面：拉取 Demo 时要用正式版的本地文件 */
export function selectApps(cfg: Config, keys: string[]): AppConfig[] {
  const picked = keys.length === 0 ? cfg.apps : keys.map((k) => {
    const app = cfg.apps.find((a) => a.key === k || String(a.appid) === k);
    if (!app) throw new Error(`未知 App: ${k}（可用: ${cfg.apps.map((a) => a.key).join(', ')}）`);
    return app;
  });
  return [...picked].sort((a, b) => Number(!!a.inherits) - Number(!!b.inherits));
}

export function globToRegex(glob: string) {
  return new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
}

// ---------------- 校验 ----------------

export const KEY_RE = /^[a-z0-9_-]+$/;

export function checkLanguages(langs: unknown): string[] {
  if (!Array.isArray(langs) || !langs.length) throw new Error('至少选择一种语言');
  const bad = langs.filter((l) => !STEAM_LANGS.includes(l));
  if (bad.length) throw new Error(`不认识的语言：${bad.join(', ')}`);
  return langs as string[];
}

export function checkAppid(v: unknown): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new Error('appid 必须是正整数（在 Steamworks 后台 App 名称旁边能看到）');
  return n;
}

// ---------------- 写：新项目、拉取时追加语言 ----------------

export interface NewConfig {
  name: string;
  appid: number;
  languages: string[];
  /** App 在配置里的 key，也是 apps/<key>/ 目录名 */
  key?: string;
}

/** 网页上初始化项目时生成最小的配置文件。返回 App 的 key */
export function createConfig(file: string, o: NewConfig): string {
  if (existsSync(file)) throw new Error(`${file} 已经存在`);
  const key = o.key || 'game';
  if (!KEY_RE.test(key)) throw new Error('App 标识只能用小写字母、数字、- 和 _');
  if (!o.name?.trim()) throw new Error('请填写游戏名称');
  const doc = new YAML.Document({
    browser: { channel: DEFAULTS.browserChannel },
    languages: checkLanguages(o.languages),
    apps: { [key]: { appid: checkAppid(o.appid), name: o.name.trim() } },
  });
  doc.commentBefore = ' AutoSteamworks 配置（可以在网页的“设置”里修改）。路径都相对于本文件所在的目录。';
  writeFileSync(file, doc.toString({ lineWidth: 0 }));
  return key;
}

/**
 * 往某个 App 的同步语言里追加语言（拉取时发现后台勾选了本地没同步的语言）。
 * App 自己写了 languages 就加到它那里；没写时，项目只有这一个 App 就加到顶层 languages，
 * 否则给这个 App 单独写一份（免得影响试玩版、DLC 等其他 App）。
 */
export function addAppLanguages(file: string, appKey: string, add: string[]) {
  const doc = YAML.parseDocument(readFileSync(file, 'utf8'));
  const raw = doc.toJS() ?? {};
  const merge = (list: string[]) => [...list, ...add.filter((l) => !list.includes(l))];
  const own: string[] | undefined = raw.apps?.[appKey]?.languages;
  if (own) doc.setIn(['apps', appKey, 'languages'], merge(own));
  else if (Object.keys(raw.apps ?? {}).length <= 1) doc.set('languages', merge(topLanguages(raw)));
  else doc.setIn(['apps', appKey, 'languages'], merge(appLanguages(raw, appKey)));
  writeFileSync(file, doc.toString({ lineWidth: 0 }));
}

export interface NewDemo { appid: number; itemid: number; name?: string }

/**
 * 给 parentKey 这个 App 加一个 Demo：apps.<key> = { appid, itemid, name, inherits: parentKey }，
 * key 用 demo（已被占用时 demo2、demo3…）。同一个 appid 已经在配置里时报错。返回新 App 的 key
 */
export function addDemoApp(file: string, parentKey: string, d: NewDemo): string {
  const doc = YAML.parseDocument(readFileSync(file, 'utf8'));
  const raw = doc.toJS() ?? {};
  const apps = raw.apps ?? {};
  if (!apps[parentKey]) throw new Error(`没有 App“${parentKey}”`);
  if (apps[parentKey].inherits) throw new Error(`“${parentKey}”本身就是 Demo，不能再给它加 Demo`);
  const appid = checkAppid(d.appid), itemid = checkAppid(d.itemid);
  const dup = Object.entries<any>(apps).find(([, a]) => Number(a?.appid) === appid);
  if (dup) throw new Error(`App ID ${appid} 已经在这个项目里了（apps.${dup[0]}）`);
  let key = 'demo';
  for (let n = 2; apps[key]; n++) key = `demo${n}`;
  const entry: Record<string, unknown> = { appid, itemid };
  if (d.name?.trim()) entry.name = d.name.trim();
  entry.inherits = parentKey;
  doc.setIn(['apps', key], doc.createNode(entry));
  writeFileSync(file, doc.toString({ lineWidth: 0 }));
  loadConfig(file);
  return key;
}

// ---------------- 设置页 ----------------

export interface AppSettings {
  key: string;
  name: string;
  appid: number;
  /** 空数组 = 跟随项目的语言 */
  languages: string[];
  /** 实际生效的值（App 自己的，没有就用顶层的）：true / false / null（未设置）。保存时写到 App 下面 */
  screenshotsAllAges: boolean | null;
  /** 继承的 App 的 key（Demo）。设置页上只显示，不能改；保存时原样保留 */
  inherits?: string;
}

export interface Settings {
  languages: string[];
  browser: string;
  delayMs: number;
  /** 顶层的忽略字段（App 自己的 store.ignoreFields 不在设置页上，保存时原样保留） */
  ignoreFields: string[];
  apps: AppSettings[];
}

export function readSettings(config: string): Settings {
  const raw = readRaw(config);
  return {
    languages: topLanguages(raw),
    browser: raw.browser?.channel ?? DEFAULTS.browserChannel,
    delayMs: raw.partner?.delayMs ?? DEFAULTS.delayMs,
    ignoreFields: raw.store?.ignoreFields ?? [],
    apps: Object.entries<any>(raw.apps ?? {}).map(([key, a]) => ({
      key,
      name: a?.name ?? '',
      appid: Number(a?.appid ?? 0),
      languages: a?.languages ?? [],
      screenshotsAllAges: appScreenshotsAllAges(raw, key) ?? null,
      inherits: a?.inherits,
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
  const oldApps = readRaw(config).apps ?? {};
  const old = Object.keys(oldApps);
  for (const k of old.filter((k) => !keys.includes(k))) {
    const child = keys.find((c) => oldApps[c]?.inherits === k);
    if (child) throw new Error(`“${child}”继承了“${k}”，要删除“${k}”请先删除“${child}”`);
    del(['apps', k]);
  }
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
  writeFileSync(config, doc.toString({ lineWidth: 0 }));
  loadConfig(config); // 写完再整体校验一次
}
