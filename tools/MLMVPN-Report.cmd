@echo off
REM ---------------------------------------------------------------------------
REM  MLM VPN - problem report collector
REM
REM  Double-click this when the application will not start, opens black, hangs,
REM  or closes itself. It needs nothing from the app - only Windows PowerShell,
REM  which every Windows has - so it still works when the app does not.
REM
REM  This file is ASCII on purpose: cmd.exe mangles non-ASCII in a .cmd. Every
REM  Persian string lives in report.ps1, which PowerShell reads as UTF-8 thanks
REM  to its byte-order mark.
REM ---------------------------------------------------------------------------

REM UTF-8 console, or the Persian output is mojibake.
chcp 65001 >nul 2>&1
title MLM VPN - Report

REM -ExecutionPolicy Bypass because the default policy blocks unsigned scripts,
REM and a user with a broken app cannot be asked to change a system policy.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0report.ps1"

if errorlevel 1 (
  echo.
  echo  Could not run the report. Please send us this folder instead:
  echo  %USERPROFILE%\.mlmvpn
  echo.
  explorer "%USERPROFILE%\.mlmvpn"
  pause
)
