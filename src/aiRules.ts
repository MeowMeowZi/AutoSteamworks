// AI 规则：游戏项目里的 STEAM_RULES.md（读写、按模板升级）、CLAUDE.md / AGENTS.md 里的指引、网页上“复制给 AI”的内容。
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { loadConfig } from './config.js';

const PKG_ROOT = join(import.meta.dirname, '..');
export const RULES_TEMPLATE = join(PKG_ROOT, 'templates', 'STEAM_RULES.md');

export const rulesPath = (config: string) => join(dirname(config), 'STEAM_RULES.md');

const templateRules = () => readFileSync(RULES_TEMPLATE, 'utf8').replace(/\r\n/g, '\n');
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
