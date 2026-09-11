@echo off
cd /d "%~dp0"
node "%~dp0ui\node_modules\electron\cli.js" "%~dp0ui\desktop.js"
if errorlevel 1 pause