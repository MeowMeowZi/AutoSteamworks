@echo off
rem AutoSteamworks dev launcher: double-click to open the local web UI with the code in this repo
chcp 65001 >nul
cd /d "%~dp0"

rem PATH 里找不到 node 时，试一下 Node.js 安装程序的默认位置
where node >nul 2>nul || if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
where node >nul 2>nul || (echo 没有找到 Node.js，请先安装：https://nodejs.org/ & pause & exit /b 1)

if not exist node_modules (
  echo 第一次运行，正在安装依赖…
  call npm install --include=dev || (pause & exit /b 1)
)

node bin\autosw.js ui %*
if errorlevel 1 pause
