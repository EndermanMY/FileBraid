@echo off
setlocal
set "APP_ROOT=%~dp0"
set "ELECTRON=%APP_ROOT%node_modules\electron\dist\electron.exe"

if not exist "%ELECTRON%" goto missing
if not exist "%APP_ROOT%dist\index.html" goto missing
if not exist "%APP_ROOT%engine\target\release\cardhelper-engine.exe" if not exist "%APP_ROOT%engine\target\debug\cardhelper-engine.exe" goto missing

start "" /D "%APP_ROOT%." "%ELECTRON%" "."
if errorlevel 1 (
    echo CardHelper could not start.
    pause
    exit /b 1
)
exit /b 0

:missing
echo CardHelper is missing its Windows build files.
echo See README.md for the build instructions.
pause
exit /b 1
