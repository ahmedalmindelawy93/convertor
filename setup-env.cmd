@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

rem Portable Node.js 22 LTS zip. No installer and no system Node required.
set "NODE_VERSION=22.23.4"
set "ARCH=x64"
if /i "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "ARCH=arm64"
if /i "%PROCESSOR_ARCHITEW6432%"=="ARM64" set "ARCH=arm64"
if /i "%PROCESSOR_ARCHITECTURE%"=="x86" if "%PROCESSOR_ARCHITEW6432%"=="" (
  echo Format Converter needs 64-bit Windows.
  exit /b 1
)

if /i "%ARCH%"=="arm64" (
  set "ZIP_SHA256=a8b8cd79cbbb3062435f449591d98dd63730bbbf30ce2d7cc3a6376c236cb111"
) else (
  set "ZIP_SHA256=cbc74b5e0982c9dbb41525fd8fb5dcd32fbee237863f7829072f4639a1ce5f20"
)

set "RUNTIME=%~dp0runtime"
set "NODE_HOME=%RUNTIME%\node"
set "NODE_EXE=%NODE_HOME%\node.exe"
set "ZIP_NAME=node-v%NODE_VERSION%-win-%ARCH%.zip"
set "ZIP=%RUNTIME%\%ZIP_NAME%"
set "URL=https://nodejs.org/dist/v%NODE_VERSION%/%ZIP_NAME%"

if exist "%NODE_EXE%" (
  for /f "delims=" %%V in ('"%NODE_EXE%" -p "process.version"') do set "HAVE=%%V"
  if /i "!HAVE!"=="v%NODE_VERSION%" goto modules
)

echo Downloading portable Node.js v%NODE_VERSION% ^(%ARCH%^)...
if not exist "%RUNTIME%" mkdir "%RUNTIME%"
where curl.exe >nul 2>&1
if errorlevel 1 (
  echo curl.exe was not found. Windows 10 and later include it.
  exit /b 1
)
curl.exe -fL --retry 3 --retry-delay 2 -o "%ZIP%" "%URL%"
if errorlevel 1 (
  echo Download failed: %URL%
  exit /b 1
)

set "GOT="
for /f "skip=1 delims=" %%H in ('certutil -hashfile "%ZIP%" SHA256') do (
  set "GOT=%%H"
  goto hash_done
)
:hash_done
set "GOT=%GOT: =%"
if /i not "%GOT%"=="%ZIP_SHA256%" (
  echo Checksum mismatch for %ZIP_NAME%.
  echo Expected %ZIP_SHA256%
  echo Got      %GOT%
  del /f "%ZIP%"
  exit /b 1
)

if exist "%RUNTIME%\unpack" rmdir /s /q "%RUNTIME%\unpack"
mkdir "%RUNTIME%\unpack"
tar.exe -xf "%ZIP%" -C "%RUNTIME%\unpack"
if errorlevel 1 (
  echo Could not unpack %ZIP_NAME%.
  exit /b 1
)
if exist "%NODE_HOME%" rmdir /s /q "%NODE_HOME%"
move "%RUNTIME%\unpack\node-v%NODE_VERSION%-win-%ARCH%" "%NODE_HOME%" >nul
if errorlevel 1 (
  echo Could not move the portable Node folder into place.
  exit /b 1
)
rmdir /s /q "%RUNTIME%\unpack"
del /f "%ZIP%"
echo Portable Node.js is in runtime\node.

:modules
if not exist "%NODE_EXE%" (
  echo Portable Node.js is missing.
  exit /b 1
)
echo Installing packages with the portable Node. This needs the internet once.
set "PATH=%NODE_HOME%;%PATH%"
set "npm_config_audit=false"
set "npm_config_fund=false"
call "%NODE_HOME%\npm.cmd" ci --omit=dev
if errorlevel 1 (
  echo npm ci failed.
  exit /b 1
)

echo.
echo Format Converter is ready. Node is not installed on this PC.
echo   Standalone:  run.cmd
echo                run.cmd 8080
echo                run.cmd 8080 0.0.0.0
echo   IIS:         point a site at this folder. See README, Publish on IIS.
exit /b 0
