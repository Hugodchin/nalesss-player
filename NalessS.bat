@echo off
cd /d "%~dp0"
echo Iniciando NalessS...
"node_modules\.pnpm\electron@30.5.1\node_modules\electron\dist\electron.exe" .
