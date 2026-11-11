// Windows 桌面集成：创建快捷方式、弹出系统的“选择文件夹”对话框。都通过系统自带的 Windows PowerShell 完成。
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
export const isWindows = process.platform === 'win32';

/** 运行一段 PowerShell，参数通过环境变量传，避免引号转义问题 */
async function ps(script: string, env: Record<string, string> = {}, sta = false) {
  const prelude = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $ErrorActionPreference = "Stop"; ';
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', ...(sta ? ['-STA'] : []), '-Command', prelude + script], {
    env: { ...process.env, ...env }, encoding: 'utf8', windowsHide: true, maxBuffer: 1 << 20,
  });
  return stdout.trim();
}

/** 快捷方式启动的命令：node <包>/bin/autosw.js ui */
export function launchCommand() {
  return { node: process.execPath, script: join(import.meta.dirname, '..', 'bin', 'autosw.js') };
}

/** 在桌面和开始菜单创建“AutoSteamworks”快捷方式，返回创建的路径。folders 只在测试时传 */
export async function createShortcuts(folders?: string[]): Promise<string[]> {
  if (!isWindows) throw new Error('目前只支持在 Windows 上创建快捷方式');
  const { node, script } = launchCommand();
  // 注意：这段脚本写在模板字符串里，不要用反斜杠（会被 JS 吃掉）
  const out = await ps(`
    $shell = New-Object -ComObject WScript.Shell
    $made = @()
    $folders = if ($env:AUTOSW_LNK_DIRS) { $env:AUTOSW_LNK_DIRS.Split([char]124) } else { @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs')) }
    foreach ($folder in $folders) {
      $path = Join-Path $folder 'AutoSteamworks.lnk'
      $s = $shell.CreateShortcut($path)
      $s.TargetPath = $env:AUTOSW_NODE
      $s.Arguments = '"' + $env:AUTOSW_SCRIPT + '" ui'
      $s.WorkingDirectory = $env:AUTOSW_HOMEDIR
      $s.WindowStyle = 7
      $s.Description = 'AutoSteamworks：打开本地后台网页'
      $s.Save()
      $made += $path
    }
    $made -join [char]10`, { AUTOSW_NODE: node, AUTOSW_SCRIPT: script, AUTOSW_HOMEDIR: homedir(), AUTOSW_LNK_DIRS: folders?.join('|') ?? '' });
  return out.split('\n').map((l) => l.trim()).filter(Boolean);
}

/** 弹出系统的选择文件夹对话框，取消时返回 undefined */
export async function pickFolder(): Promise<string | undefined> {
  if (!isWindows) throw new Error('目前只支持在 Windows 上弹出选择文件夹的窗口，请直接粘贴路径');
  const out = await ps(`
    Add-Type -AssemblyName System.Windows.Forms
    $owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false; WindowState = 'Minimized' }
    $owner.Show(); $owner.Hide()
    $d = New-Object System.Windows.Forms.FolderBrowserDialog
    $d.Description = '选择游戏项目的文件夹'
    $d.ShowNewFolderButton = $true
    if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { $d.SelectedPath }
    $owner.Dispose()`, {}, true);
  return out || undefined;
}

/** 用默认浏览器打开网址 */
export function openUrl(url: string) {
  // cmd /c start 遇到网址里的 & 会截断，用 rundll32 交给系统默认浏览器
  const [cmd, args] = isWindows ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]];
  execFile(cmd, args as string[], { windowsHide: true }, () => {});
}
