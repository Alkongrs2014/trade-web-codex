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

if exist ".git" (
  echo   المجلد مربوط أصلاً. جارٍ التحديث فقط...
  git pull --rebase origin main
  goto :done
)

git init
git remote add origin https://github.com/Alkongrs2014/Alkongrs2014.git
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
