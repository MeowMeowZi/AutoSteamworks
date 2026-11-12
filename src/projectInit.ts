// 新项目初始化：配置文件、图片收件箱、规则文件、AI 指引、.gitignore。
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CONFIG_NAME, createConfig, type NewConfig } from './config.js';
import { INBOX } from './local/inbox.js';
import { ensureAiPointer, RULES_TEMPLATE } from './aiRules.js';

/** 在项目文件夹里生成 steam.config.yaml、STEAM_RULES.md，并把 .autosw/ 加进 .gitignore。返回生成了哪些文件 */
export function initProject(config: string, o: NewConfig): string[] {
  const dir = dirname(config);
  const key = createConfig(config, o);
  const made = [CONFIG_NAME];
  // 图片收件箱：图片随便丢进来，网页上点“整理”自动分到各目录
  mkdirSync(join(dir, 'apps', key, 'assets', INBOX), { recursive: true });
  made.push(`apps/${key}/assets/${INBOX}/（图片丢这里，自动整理）`);

  const rules = join(dir, 'STEAM_RULES.md');
  if (!existsSync(rules)) { copyFileSync(RULES_TEMPLATE, rules); made.push('STEAM_RULES.md'); }
  for (const f of ensureAiPointer(dir)) made.push(`${f}（加了指向 STEAM_RULES.md 的说明）`);
  if (ensureGitignore(dir)) made.push('.gitignore（加了 .autosw/）');
  return made;
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
