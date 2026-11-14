@echo off
cd /d "%~dp0"
node cli.js restore
node cli.js status
pause
