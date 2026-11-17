@echo off
chcp 65001 >nul
title Mini Estudio Pro - Motor GPU NVIDIA RTX
echo Iniciando motor de renderizado con aceleracion por tarjeta de video (GPU)...
start "" "http://localhost:3456"
node render_mp4.js --server
pause
