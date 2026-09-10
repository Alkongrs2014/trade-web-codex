@echo off
rem  Thin ASCII launcher. All logic and all Arabic text live in schedule.ps1 --
rem  cmd.exe miscounts its file position in a UTF-8 batch under chcp 65001, which
rem  silently splits schtasks lines in half. PowerShell reads UTF-8 correctly.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0schedule.ps1"
