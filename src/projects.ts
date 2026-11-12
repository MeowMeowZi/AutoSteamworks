// 项目列表：网页上添加的游戏项目（~/.autosteamworks/projects.json）、按 App ID 新建项目。
// 配置文件的读写在 config.ts，初始化在 projectInit.ts，AI 规则在 aiRules.ts。
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { appHome, checkAppid, CONFIG_NAME, loadConfig } from './config.js';
import { initProject } from './projectInit.js';

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
