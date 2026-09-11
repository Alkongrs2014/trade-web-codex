@echo off
chcp 65001 >nul
cd /d "%~dp0.."
echo.
echo ══ ربط المجلد المحلي بمستودع GitHub ══
echo.
echo   يجعل هذا المجلد نسخة عاملة من نفس المستودع،
echo   فيصير المشروع واحداً في مكانين لا مشروعين.
echo.
git --version >nul 2>&1 || (echo   [خطأ] Git غير مثبّت — حمّله من git-scm.com & pause & exit /b 1)

if not exist ".git" goto :newrepo
set "ORIGIN_URL="
for /f "delims=" %%R in ('git remote get-url origin 2^>nul') do set "ORIGIN_URL=%%R"
echo(%ORIGIN_URL%| findstr /I /C:"github.com/Alkongrs2014/trade-web-codex" >nul || (
  echo   [خطأ] origin لا يشير إلى مستودع trade-web-codex — أُوقف التحديث للحماية.
  pause
  exit /b 1
)
echo   المجلد مربوط بالمستودع الصحيح. جارٍ التحديث فقط...
git pull --rebase origin main
goto :done

:newrepo
git init
git remote add origin https://github.com/Alkongrs2014/trade-web-codex.git
echo   جارٍ جلب المستودع...
git fetch origin main || (echo   [خطأ] تعذّر الجلب — تحقّق من الإنترنت & pause & exit /b 1)
git reset --mixed origin/main
git branch -M main
git branch --set-upstream-to=origin/main main

:done
echo.
echo ══ الحالة ══
git status --short
echo.
echo   تم. الملفات المذكورة أعلاه (إن وُجدت) هي فروقك المحلية.
echo   للدفع لاحقاً:  git add -A ^&^& git commit -m "وصف" ^&^& git push
pause
