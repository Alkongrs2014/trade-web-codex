@echo off
rem  Thin ASCII launcher. See schedule.bat for why this is not a real batch file.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0schedule.ps1" -Publish
