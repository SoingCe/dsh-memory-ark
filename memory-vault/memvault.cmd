@echo off
setlocal
set "NODE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE%" set "NODE=node"
"%NODE%" "%~dp0memvault.mjs" %*
