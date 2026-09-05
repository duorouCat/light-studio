@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul
title Light Studio Server
cd /d "%~dp0"

rem ---- Pick the first free port from the candidate list ----
set PORTS=8321 8000 8080 3000 5173
set PORT=
for %%P in (%PORTS%) do if not defined PORT (
  netstat -ano | findstr ":%%P " | findstr "LISTENING" >nul
  if errorlevel 1 set PORT=%%P
)
if not defined PORT set PORT=8321

echo ==============================================
echo   Light Studio  http://127.0.0.1:!PORT!/
echo ==============================================

rem ---- Step 1: open the browser FIRST ----
echo Opening browser now ...
start "" "http://127.0.0.1:!PORT!/"

rem ---- Step 2: then start the server ----
where node >nul 2>nul
if %errorlevel%==0 (
  echo Using Node serve.js. Press Ctrl+C to stop.
  set OPEN_BROWSER=0
  node serve.js
  goto :end
)
where python >nul 2>nul
if %errorlevel%==0 (
  echo Using Python http.server. Press Ctrl+C to stop.
  python -m http.server !PORT! --bind 127.0.0.1
  goto :end
)
echo Neither Python nor Node.js found. Trying npx http-server...
npx --yes http-server -p !PORT!
:end
pause
