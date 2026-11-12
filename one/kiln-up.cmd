@echo off
node "%~dp0kiln-up.mjs" %*
if errorlevel 1 pause
