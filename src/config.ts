import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import YAML from 'yaml';

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

/** 工具自己的全局目录（项目列表、共用的登录信息）。测试时用 AUTOSW_HOME 指到临时目录 */
export const appHome = () => process.env.AUTOSW_HOME ?? join(homedir(), '.autosteamworks');

export const DEFAULT_STORE_EDIT_URL = 'https://partner.steamgames.com/admin/game/editbyappid/{appid}';
export const DEFAULT_STORE_FILES = ['about', 'short_description', 'legal', 'earlyaccess.*', 'sections.*.content'];

export function loadConfig(path = 'steam.config.yaml'): Config {
  const file = resolve(path);
  if (!existsSync(file)) {
    throw new Error(`找不到配置文件 ${file}，可以先运行 \`npm run autosw -- init\``);
  }
  const raw = YAML.parse(readFileSync(file, 'utf8')) ?? {};
  const root = dirname(file);
  const abs = (p: string) => resolve(root, p);

  const defStore = raw.store ?? {};
  const apps: AppConfig[] = Object.entries<any>(raw.apps ?? {}).map(([key, a]) => {
    if (!a?.appid) throw new Error(`apps.${key} 缺少 appid`);
    const store = a.store ?? {};
    return {
      key,
      appid: Number(a.appid),
      name: a.name,
      languages: a.languages ?? raw.languages ?? ['english'],
      storeDir: abs(store.dir ?? `apps/${key}/store`),
      store: {
        files: store.files ?? defStore.files ?? DEFAULT_STORE_FILES,
        ignoreFields: [...(defStore.ignoreFields ?? []), ...(store.ignoreFields ?? [])],
      },
      assets: {
        dir: abs(a.assets?.dir ?? `apps/${key}/assets`),
        screenshotsAllAges: a.assets?.screenshotsAllAges ?? raw.assets?.screenshotsAllAges,
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

  const stateDir = abs(raw.stateDir ?? '.autosw');
  // 默认所有游戏项目共用一个登录（同一个 Steamworks 账号）；项目里已有旧的 profile 时继续用它
  const legacyProfile = join(stateDir, 'profile');
  const profileDir = raw.browser?.profileDir ? abs(raw.browser.profileDir)
    : existsSync(legacyProfile) ? legacyProfile : join(appHome(), 'profile');
  return {
    file,
    root,
    stateDir,
    profileDir,
    browserChannel: raw.browser?.channel ?? 'msedge',
    storeEditUrl: raw.partner?.storeEditUrl ?? DEFAULT_STORE_EDIT_URL,
    formSelector: raw.partner?.formSelector ?? '#gameform',
    delayMs: raw.partner?.delayMs ?? 1500,
    steamcmdPath: raw.steamcmd?.path ?? 'steamcmd',
    steamUser: raw.steamcmd?.user,
    apps,
  };
}

export function selectApps(cfg: Config, keys: string[]): AppConfig[] {
  if (keys.length === 0) return cfg.apps;
  return keys.map((k) => {
    const app = cfg.apps.find((a) => a.key === k || String(a.appid) === k);
    if (!app) throw new Error(`未知 App: ${k}（可用: ${cfg.apps.map((a) => a.key).join(', ')}）`);
    return app;
  });
}

export function globToRegex(glob: string) {
  return new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
}

/**
 * 往某个 App 的同步语言里追加语言（拉取时发现后台勾选了本地没同步的语言）。用 YAML Document 修改，保留注释。
 * App 自己写了 languages 就加到它那里；没写时，项目只有这一个 App 就加到顶层 languages，
 * 否则给这个 App 单独写一份（免得影响试玩版、DLC 等其他 App）。
 */
export function addAppLanguages(file: string, appKey: string, add: string[]) {
  const doc = YAML.parseDocument(readFileSync(file, 'utf8'));
  const raw = doc.toJS() ?? {};
  const own: string[] | undefined = raw.apps?.[appKey]?.languages;
  const top: string[] = raw.languages ?? ['english'];
  if (own) doc.setIn(['apps', appKey, 'languages'], [...own, ...add.filter((l) => !own.includes(l))]);
  else if (Object.keys(raw.apps ?? {}).length <= 1) doc.set('languages', [...top, ...add.filter((l) => !top.includes(l))]);
  else doc.setIn(['apps', appKey, 'languages'], [...top, ...add.filter((l) => !top.includes(l))]);
  writeFileSync(file, doc.toString({ lineWidth: 0 }));
}
