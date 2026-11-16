@echo off
setlocal
set "APP_ROOT=%~dp0"
set "ELECTRON=%APP_ROOT%node_modules\electron\dist\electron.exe"

if not exist "%ELECTRON%" goto missing
if not exist "%APP_ROOT%dist\index.html" goto missing
if not exist "%APP_ROOT%engine\target\release\filebraid-engine.exe" if not exist "%APP_ROOT%engine\target\debug\filebraid-engine.exe" goto missing

start "" /D "%APP_ROOT%." "%ELECTRON%" "."
if errorlevel 1 (
    echo FileBraid could not start.
    pause
    exit /b 1
)
exit /b 0

:missing
echo FileBraid is missing its Windows build files.
echo See README.md for the build instructions.
pause
exit /b 1
