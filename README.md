# Mini Estudio Pro

Editor de video en el navegador para animaciones HTML + audio. Pensado para pulir animaciones generadas con IA y exportarlas como videos cortos verticales (1080x1920) en MP4.

## Qué hace

- Carga una animación `.html` y un archivo de audio (`.wav`).
- Línea de tiempo con cortes (`S`), borrado de clips, pegar huecos, deshacer/rehacer (`Ctrl+Z` / `Ctrl+Y`).
- Modo **WARP**: estira o comprime la velocidad de la animación para ajustarla al audio.
- Guarda y carga el proyecto como `.json`.
- Exporta a MP4: un servidor Node abre la animación con Puppeteer, captura los cuadros y los codifica con FFmpeg, mezclando el audio.
- Usa aceleración por GPU NVIDIA (`h264_nvenc`) si está disponible; si no, cae a CPU (`libx264`).

## Requisitos

- [Node.js](https://nodejs.org/) 18 o superior
- [FFmpeg](https://ffmpeg.org/) disponible en el `PATH`
- (Opcional) GPU NVIDIA con soporte NVENC para exportar más rápido

## Uso

```bash
npm install
npm start
```

Luego abre `http://localhost:3456` y carga tu HTML y tu audio. En Windows también puedes ejecutar `iniciar_estudio_gpu.bat`.

También se puede renderizar sin la interfaz:

```bash
node render_mp4.js [proyecto.json] [salida.mp4]
```

## Estructura

| Archivo | Descripción |
| --- | --- |
| `estudio.html` | Interfaz del editor (línea de tiempo, vista previa) |
| `render_mp4.js` | Servidor local y motor de render (Puppeteer + FFmpeg) |
| `iniciar_estudio_gpu.bat` | Atajo de arranque para Windows |

## Notas

- Todo corre en local (`localhost:3456`); no se sube nada a ningún servidor.
- Los videos y audios de salida no se incluyen en el repositorio.

## Licencia

MIT
