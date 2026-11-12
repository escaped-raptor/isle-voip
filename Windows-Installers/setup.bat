@echo off
rem ------------------------------------------------------------------
rem  Species Specific VoIP - The Isle Evrima
rem  Setup for Windows. Double-click this file.
rem
rem  It checks that Node.js is installed (and offers to install it),
rem  then downloads the parts the client and/or the server need.
rem  Nothing is installed outside this folder except Node.js itself.
rem
rem  You can also run:  setup.bat client   or   setup.bat server
rem ------------------------------------------------------------------
setlocal EnableExtensions
title Species Specific VoIP - Setup
cd /d "%~dp0.."
set "PICK=%~1"
set "TRIES=0"

echo.
echo   Species Specific VoIP - The Isle Evrima
echo   Setup
echo   ---------------------------------------
echo.

if not exist "client\package.json" goto wrong_folder
if not exist "server\package.json" goto wrong_folder

:check_node
where node >nul 2>nul
if errorlevel 1 goto need_node
set "NODE_VERSION="
for /f "delims=" %%v in ('node -v') do set "NODE_VERSION=%%v"
if not defined NODE_VERSION goto need_node
set "NODE_MAJOR=%NODE_VERSION:v=%"
for /f "tokens=1 delims=." %%m in ("%NODE_MAJOR%") do set "NODE_MAJOR=%%m"
if "%NODE_MAJOR%"=="" goto need_node
if %NODE_MAJOR% LSS 20 goto old_node
echo   Node.js %NODE_VERSION% is installed. Good.
echo.
goto menu

:need_node
echo   This needs Node.js, a free program that runs the client and server.
echo   It is not installed on this computer yet.
echo.
where winget >nul 2>nul
if errorlevel 1 goto manual_node
set "ANSWER="
set /p "ANSWER=  Install Node.js now? Type Y and press Enter, or N to stop: "
if /i not "%ANSWER%"=="Y" goto manual_node
echo.
echo   Installing Node.js. Windows may ask for permission.
echo.
winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
if errorlevel 1 goto manual_node
rem A new program is not visible to this window until its folder is added.
set "PATH=%ProgramFiles%\nodejs;%APPDATA%\npm;%PATH%"
where node >nul 2>nul
if errorlevel 1 goto reopen
echo.
goto check_node

:old_node
echo   Node.js %NODE_VERSION% is installed, but version 20 or newer is needed.
echo   Download the current "LTS" version from https://nodejs.org and install it,
echo   then run this setup again.
goto finish_error

:manual_node
echo.
echo   Please install Node.js yourself:
echo     1. Open https://nodejs.org in your browser.
echo     2. Download the "LTS" version and run the installer, keeping its suggestions.
echo     3. Run this setup again.
goto finish_error

:reopen
echo.
echo   Node.js was installed. Close this window and run setup.bat again
echo   so Windows can find it.
goto finish_error

:wrong_folder
echo   This file needs to stay in the project folder, next to the
echo   "client" and "server" folders. If you opened it from inside a zip,
echo   extract the whole zip first, then run it from the extracted folder.
goto finish_error

:menu
if /i "%PICK%"=="client" goto do_client
if /i "%PICK%"=="server" goto do_server
if /i "%PICK%"=="both" goto do_both
echo   What would you like to set up on this computer?
echo.
echo     1  Client   for players
echo     2  Server   for whoever runs the Isle Evrima server
echo     3  Both     to try everything on one PC
echo     4  Exit
echo.
set "PICK="
set /p "PICK=  Type 1, 2, 3 or 4 and press Enter: "
if "%PICK%"=="1" goto do_client
if "%PICK%"=="2" goto do_server
if "%PICK%"=="3" goto do_both
if "%PICK%"=="4" goto end
echo.
set /a TRIES+=1
if %TRIES% GEQ 5 goto end
echo   Please type 1, 2, 3 or 4.
echo.
goto menu

:do_both
set "ALSO_SERVER=1"

:do_client
echo.
echo   Setting up the client. This downloads about 300 MB and can take
echo   a few minutes. Please wait...
echo.
pushd client
call npm install --no-fund --no-audit --loglevel=error
if errorlevel 1 goto npm_failed
call npm run build
if errorlevel 1 goto npm_failed
popd
set "DID_CLIENT=1"
echo.
echo   The client is ready.
if not defined ALSO_SERVER goto done

:do_server
echo.
echo   Setting up the server. This downloads about 300 MB and can take
echo   a few minutes. Please wait...
echo.
pushd server
call npm install --no-fund --no-audit --loglevel=error
if errorlevel 1 goto npm_failed
popd
pushd server-app
call npm install --no-fund --no-audit --loglevel=error
if errorlevel 1 goto npm_failed
popd
set "DID_SERVER=1"
echo.
echo   The server is ready.
goto done

:npm_failed
popd
echo.
echo   Something went wrong while downloading. The message above says what.
echo   Check your internet connection and run this setup again. It is safe
echo   to run as many times as you like.
goto finish_error

:done
echo.
echo   ---------------------------------------
echo   All done.
echo.
if defined DID_CLIENT echo   To start the client:  double-click  start-client.bat  in the Windows-Installers folder
if defined DID_SERVER echo   To start the server:  double-click  start-server.bat  in the Windows-Installers folder
echo.
if defined DID_SERVER echo   The first time the server starts it asks a few setup questions.
if defined DID_SERVER echo   To try it on this PC only, choose "Testing without a certificate".
echo.
set "ANSWER="
set /p "ANSWER=  Start it now? Type Y and press Enter, or just press Enter to finish: "
if /i not "%ANSWER%"=="Y" goto end
if defined DID_SERVER call "%~dp0start-server.bat" quiet
if defined DID_CLIENT call "%~dp0start-client.bat" quiet
goto end

:finish_error
echo.
pause
endlocal
exit /b 1

:end
echo.
if /i not "%~2"=="quiet" pause
endlocal
exit /b 0
