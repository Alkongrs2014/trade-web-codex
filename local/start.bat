@echo off
chcp 65001 >nul
cd /d "%~dp0.."
echo.
echo   تشغيل الخادم المحلي...
echo.
start "" http://localhost:8080
node local\run.mjs serve
pause
