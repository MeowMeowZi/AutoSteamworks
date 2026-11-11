# AutoSteamworks 一键安装（Windows）
# 用法：在 PowerShell 里运行
#   irm https://raw.githubusercontent.com/MeowMeowZi/AutoSteamworks/main/install.ps1 | iex
# 会做三件事：检查 Node.js（没有就用 winget 安装）→ 安装 AutoSteamworks → 在桌面和开始菜单创建快捷方式并打开。
# 再运行一次就是更新到最新版。
# 注意：这个文件要保持“UTF-8 无 BOM”，否则 irm | iex 会报错。

$ErrorActionPreference = 'Stop'
$repo = 'github:MeowMeowZi/AutoSteamworks'

function Step($msg) { Write-Host "`n== $msg" -ForegroundColor Cyan }
function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}
function Node-Ok {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $cmd) { return $false }
  $v = (& node -v) -replace '^v', ''
  return ([version]$v) -ge [version]'20.0.0'
}

Step '检查 Node.js（需要 20 或更新版本）'
if (-not (Node-Ok)) {
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Write-Host '没有找到合适的 Node.js，用 winget 安装 Node.js LTS…'
    winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
    Refresh-Path
  }
  if (-not (Node-Ok)) {
    Write-Host '请先从 https://nodejs.org/ 安装 Node.js（选 LTS 版本），装好后重新运行这条命令。' -ForegroundColor Yellow
    return
  }
}
Write-Host ("Node.js " + (& node -v))

Step '安装 AutoSteamworks（第一次大约需要一分钟）'
# 用户环境可能设置了 NODE_ENV=production / omit=dev，这里不需要开发依赖，不影响
& npm install -g $repo
if ($LASTEXITCODE -ne 0) { throw 'npm 安装失败，请把上面的错误信息发给开发者' }
Refresh-Path
$autosw = Join-Path (& npm prefix -g) 'autosw.cmd'
if (-not (Test-Path $autosw)) { throw "安装后找不到 $autosw" }

Step '创建桌面和开始菜单快捷方式'
& $autosw shortcut
if ($LASTEXITCODE -ne 0) { throw '创建快捷方式失败' }

Step '打开 AutoSteamworks'
$lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'AutoSteamworks.lnk'
Start-Process $lnk
Write-Host "`n完成！以后双击桌面上的“AutoSteamworks”就能打开。网页里按提示添加游戏项目、登录 Steam。" -ForegroundColor Green
