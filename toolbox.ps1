# 工具箱一键启动: 切 Node 20 -> 起服务 -> 就绪后自动开浏览器
nvm use 20.19.5 | Out-Null
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root
# 等 3 秒让服务监听就绪, 再打开浏览器
Start-Process -WindowStyle Hidden powershell -ArgumentList '-NoProfile','-Command','Start-Sleep 3; Start-Process "http://127.0.0.1:8600"'
node server/main.js
