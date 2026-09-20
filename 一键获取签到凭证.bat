@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在读取 Trae / WorkBuddy / Qoder 本地签到凭证...
echo.
node "%~dp0get-credentials.js"
echo.
pause
