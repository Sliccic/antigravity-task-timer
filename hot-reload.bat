@echo off
chcp 65001 >nul
echo 正在执行 Antigravity 任务计时组件零重启热注入...
node "%~dp0bin\cli.js" hot-reload
pause
