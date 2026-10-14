@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Instalando dependencias...
  call npm install --no-audit --no-fund
)
start "" http://localhost:3000
node server.js
pause
