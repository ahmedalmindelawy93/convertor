@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "NODE_EXE=%~dp0runtime\node\node.exe"
if not exist "%NODE_EXE%" (
  echo Portable Node.js is not set up. Run setup-env.cmd first.
  exit /b 1
)

set "PORT=3000"
set "HOST=0.0.0.0"

if /i "%~1"=="--port" goto named
if /i "%~1"=="-port" goto named
if /i "%~1"=="/port" goto named
if /i "%~1"=="--host" goto named
if /i "%~1"=="-host" goto named
if /i "%~1"=="/host" goto named
if not "%~1"=="" set "PORT=%~1"
if not "%~2"=="" set "HOST=%~2"
if not "%~3"=="" (
  echo Usage: run.cmd [port] [host]
  echo    or: run.cmd --port 8080 --host 0.0.0.0
  exit /b 1
)
goto launch

:named
:parse
if "%~1"=="" goto launch
if /i "%~1"=="--port" (
  if "%~2"=="" goto usage
  set "PORT=%~2"
  shift
  shift
  goto parse
)
if /i "%~1"=="-port" (
  if "%~2"=="" goto usage
  set "PORT=%~2"
  shift
  shift
  goto parse
)
if /i "%~1"=="/port" (
  if "%~2"=="" goto usage
  set "PORT=%~2"
  shift
  shift
  goto parse
)
if /i "%~1"=="--host" (
  if "%~2"=="" goto usage
  set "HOST=%~2"
  shift
  shift
  goto parse
)
if /i "%~1"=="-host" (
  if "%~2"=="" goto usage
  set "HOST=%~2"
  shift
  shift
  goto parse
)
if /i "%~1"=="/host" (
  if "%~2"=="" goto usage
  set "HOST=%~2"
  shift
  shift
  goto parse
)
goto usage

:usage
echo Usage: run.cmd [port] [host]
echo    or: run.cmd --port 8080 --host 0.0.0.0
exit /b 1

:launch
echo Starting Format Converter on http://%HOST%:%PORT%
"%NODE_EXE%" "%~dp0server.js"
exit /b %ERRORLEVEL%
