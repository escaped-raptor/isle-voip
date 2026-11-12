@echo off
rem Starts the voice server as a desktop app with a tray icon. Run setup.bat first.
rem The first time, it opens a page with a few setup questions.
setlocal EnableExtensions
cd /d "%~dp0..\server-app"
if not exist "node_modules\electron\dist\electron.exe" goto not_set_up
if not exist "..\server\node_modules\mediasoup" goto not_set_up
start "" "node_modules\electron\dist\electron.exe" .
endlocal
exit /b 0

:not_set_up
echo.
echo   The server is not set up yet. Double-click setup.bat first
echo   and choose "Server".
echo.
if /i not "%~1"=="quiet" pause
endlocal
exit /b 1
