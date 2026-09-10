@echo off
chcp 65001 >nul
rem  Arabic-named alias for schedule-publish.bat -- a wrapper, not a copy.
call "%~dp0schedule-publish.bat"
