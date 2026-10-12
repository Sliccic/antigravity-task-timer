@echo off
chcp 65001 >nul
echo 正在安装 Antigravity 任务计时与 Token 统计插件...
node "%~dp0bin\cli.js" install
pause
