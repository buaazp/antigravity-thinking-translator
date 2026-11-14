@echo off
cd /d "%~dp0"
node scripts\build-renderer.js
node cli.js check
node cli.js install
node cli.js status
pause
