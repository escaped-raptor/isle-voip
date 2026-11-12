@echo off
rem Starts the player client. Run setup.bat first.
setlocal EnableExtensions
cd /d "%~dp0..\client"
if not exist "node_modules\electron\dist\electron.exe" goto not_set_up
call node build.mjs >nul
if errorlevel 1 goto not_set_up
start "" "node_modules\electron\dist\electron.exe" .
endlocal
exit /b 0

:not_set_up
echo.
echo   The client is not set up yet. Double-click setup.bat first
echo   and choose "Client".
echo.
if /i not "%~1"=="quiet" pause
endlocal
exit /b 1
