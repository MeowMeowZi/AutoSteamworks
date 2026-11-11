import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppConfig, Config } from '../config.js';

/**
 * 通过 SteamPipe（steamcmd + app_build VDF）上传构建。这是 Valve 官方支持的流程。
 * 注意：steamcmd 用的是“构建账号”的账号密码 + Steam Guard，和浏览器会话无关。
 */

const q = (s: string | number) => `"${String(s).replace(/"/g, '')}"`;

export function renderAppBuildVdf(cfg: Config, app: AppConfig, opts: { desc: string; preview: boolean }) {
  const build = app.build!;
  const output = join(cfg.stateDir, 'build-output', app.key);
  const lines = [
    '"AppBuild"', '{',
    `  "AppID" ${q(app.appid)}`,
    `  "Desc" ${q(opts.desc)}`,
    `  "BuildOutput" ${q(output)}`,
    opts.preview ? '  "Preview" "1"' : '',
    build.setLive && !opts.preview ? `  "SetLive" ${q(build.setLive)}` : '',
    '  "Depots"', '  {',
  ];
  for (const d of build.depots) {
    lines.push(
      `    ${q(d.id)}`, '    {',
      `      "ContentRoot" ${q(d.contentRoot)}`,
      '      "FileMapping"', '      {',
      '        "LocalPath" "*"', '        "DepotPath" "."', '        "Recursive" "1"',
      '      }',
      ...d.exclude.map((e) => `      "FileExclusion" ${q(e)}`),
      '    }',
    );
  }
  lines.push('  }', '}');
  return { vdf: lines.filter(Boolean).join('\n') + '\n', output };
}

export async function runBuild(cfg: Config, app: AppConfig, opts: { desc: string; preview: boolean; dryRun: boolean }) {
  if (!app.build?.depots.length) throw new Error(`${app.key} 没有配置 build.depots`);
  for (const d of app.build.depots) {
    if (!existsSync(d.contentRoot)) throw new Error(`Depot ${d.id} 的内容目录不存在: ${d.contentRoot}`);
  }
  if (!cfg.steamUser) throw new Error('请在配置里设置 steamcmd.user（建议用一个专门的构建账号）');

  const { vdf, output } = renderAppBuildVdf(cfg, app, opts);
  mkdirSync(output, { recursive: true });
  const vdfPath = join(cfg.stateDir, 'builds', `app_build_${app.appid}.vdf`);
  mkdirSync(join(vdfPath, '..'), { recursive: true });
  writeFileSync(vdfPath, vdf);
  console.log(`已生成 ${vdfPath}\n${vdf}`);
  if (opts.dryRun) return;

  // stdio 继承当前终端：首次登录时 steamcmd 会提示输入密码 / Steam Guard 验证码
  const args = ['+login', cfg.steamUser, '+run_app_build', vdfPath, '+quit'];
  await new Promise<void>((resolve, reject) => {
    const p = spawn(cfg.steamcmdPath, args, { stdio: 'inherit' });
    p.on('error', (e) => reject(new Error(`无法启动 steamcmd（${cfg.steamcmdPath}）: ${e.message}`)));
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`steamcmd 退出码 ${code}`))));
  });
}
