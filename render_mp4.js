const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');
const puppeteer = require('puppeteer');

const WORKSPACE_DIR = __dirname;
const PORT = 3456;

function findLatestProjectJson(explicitPath) {
  if (explicitPath && fs.existsSync(explicitPath)) return explicitPath;

  const candidates = [];
  const localJson = path.join(WORKSPACE_DIR, 'proyecto_editado.json');
  if (fs.existsSync(localJson)) {
    candidates.push({ file: localJson, mtime: fs.statSync(localJson).mtimeMs });
  }

  const downloadsDir = path.join(process.env.USERPROFILE || process.env.HOME || '', 'Downloads');
  if (downloadsDir && fs.existsSync(downloadsDir)) {
    try {
      const dlFiles = fs.readdirSync(downloadsDir)
        .filter(f => /^proyecto_editado(\s*\(\d+\))?\.json$/i.test(f));
      dlFiles.forEach(f => {
        const full = path.join(downloadsDir, f);
        candidates.push({ file: full, mtime: fs.statSync(full).mtimeMs });
      });
    } catch (e) {}
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0].file;
}
let hasNvencCached = null;
function checkNvencAvailable() {
  if (hasNvencCached !== null) return hasNvencCached;
  try {
    execFileSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=c=black:s=256x256:d=0.1:r=30',
      '-c:v', 'h264_nvenc', '-f', 'null', '-'
    ], { stdio: 'ignore' });
    hasNvencCached = true;
  } catch (e) {
    hasNvencCached = false;
  }
  return hasNvencCached;
}

function findBestMatchingFile(dir, preferredName, extensions) {
  const downloadsDir = path.join(process.env.USERPROFILE || process.env.HOME || '', 'Downloads');
  const searchDirs = [dir];
  if (downloadsDir && fs.existsSync(downloadsDir)) searchDirs.push(downloadsDir);

  if (preferredName) {
    for (const d of searchDirs) {
      const directPath = path.resolve(d, preferredName);
      if (fs.existsSync(directPath)) return directPath;
    }
  }

  for (const d of searchDirs) {
    const allFiles = fs.readdirSync(d).filter(f => {
      const ext = path.extname(f).toLowerCase();
      return extensions.includes(ext) && f.toLowerCase() !== 'estudio.html' && !f.startsWith('__temp_');
    });

    if (preferredName && allFiles.length > 0) {
      const cleanPref = preferredName.replace(/\.[^.]+$/, '').toLowerCase();
      const matched = allFiles.find(f => f.toLowerCase().includes(cleanPref) || cleanPref.includes(f.replace(/\.[^.]+$/, '').toLowerCase()));
      if (matched) return path.join(d, matched);
    }
  }

  const fallbackFiles = fs.readdirSync(dir).filter(f => {
    const ext = path.extname(f).toLowerCase();
    return extensions.includes(ext) && f.toLowerCase() !== 'estudio.html' && !f.startsWith('__temp_');
  });
  return fallbackFiles.length > 0 ? path.join(dir, fallbackFiles[0]) : null;
}

function buildAtempoChain(speed) {
  const filters = [];
  let s = speed;
  while (s > 2.0) {
    filters.push('atempo=2.0');
    s /= 2.0;
  }
  while (s < 0.5) {
    filters.push('atempo=0.5');
    s /= 0.5;
  }
  if (Math.abs(s - 1.0) > 0.001) {
    filters.push(`atempo=${s.toFixed(5)}`);
  }
  return filters.length > 0 ? filters.join(',') : 'anull';
}

function buildAudioMix(audioPath, audioClips, totalDurationSec, tempAudioOut) {
  if (!audioPath || !fs.existsSync(audioPath) || !audioClips || audioClips.length === 0) {
    return null;
  }

  const filterParts = [];
  const mixLabels = [];

  audioClips.forEach((clip, idx) => {
    const srcStart = Math.max(0, Number(clip.sourceStart) || 0);
    const srcEnd = Math.max(srcStart + 0.02, Number(clip.sourceEnd) || (srcStart + Number(clip.duration) || 1));
    const clipDur = Math.max(0.02, Number(clip.duration) || (srcEnd - srcStart));
    const tlStartMs = Math.max(0, Math.round((Number(clip.timelineStart) || 0) * 1000));

    const speed = Math.max(0.1, Math.min(10.0, (srcEnd - srcStart) / clipDur));
    const atempoFilter = buildAtempoChain(speed);

    const chain = [
      `[0:a]atrim=start=${srcStart.toFixed(4)}:end=${srcEnd.toFixed(4)}`,
      `asetpts=PTS-STARTPTS`,
      atempoFilter,
      `atrim=0:${clipDur.toFixed(4)}`,
      `asetpts=PTS-STARTPTS`,
      `adelay=${tlStartMs}:all=1[a${idx}]`
    ].join(',');

    filterParts.push(chain);
    mixLabels.push(`[a${idx}]`);
  });

  if (mixLabels.length === 1) {
    filterParts.push(`${mixLabels[0]}apad=whole_dur=${totalDurationSec.toFixed(4)},atrim=0:${totalDurationSec.toFixed(4)}[aout]`);
  } else {
    filterParts.push(
      `${mixLabels.join('')}amix=inputs=${mixLabels.length}:duration=longest:dropout_transition=0:normalize=0,apad=whole_dur=${totalDurationSec.toFixed(4)},atrim=0:${totalDurationSec.toFixed(4)}[aout]`
    );
  }

  const filterComplex = filterParts.join(';');

  execFileSync('ffmpeg', [
    '-y',
    '-hide_banner',
    '-loglevel', 'error',
    '-i', audioPath,
    '-filter_complex', filterComplex,
    '-map', '[aout]',
    '-c:a', 'aac',
    '-b:a', '192k',
    tempAudioOut
  ], { stdio: 'inherit' });

  return tempAudioOut;
}

function getActiveClipAt(clipsList, t) {
  const sorted = [...clipsList].sort((a, b) => (Number(a.timelineStart) || 0) - (Number(b.timelineStart) || 0));
  for (let i = sorted.length - 1; i >= 0; i--) {
    const c = sorted[i];
    const start = Number(c.timelineStart) || 0;
    const dur = Number(c.duration) || 0;
    if (t >= start - 0.0001 && t <= start + dur + 0.0001) {
      return c;
    }
  }
  return null;
}

function mapTimelineToSource(clip, t) {
  const start = Number(clip.timelineStart) || 0;
  const dur = Math.max(0.001, Number(clip.duration) || 0.001);
  const srcStart = Number(clip.sourceStart) || 0;
  const srcEnd = Number(clip.sourceEnd) || 0;
  const progress = Math.max(0, Math.min(1, (t - start) / dur));
  return srcStart + progress * (srcEnd - srcStart);
}

// Puente universal inyectado en el HTML para controlar el tiempo y ocultar los controles inferiores
const UNIVERSAL_RENDER_BRIDGE = `
<script>
(function() {
  window.__capturedTimelines = window.__capturedTimelines || [];
  function installGsapHook() {
    if (!window.gsap || window.__renderHookInstalled) return;
    window.__renderHookInstalled = true;
    const origTimeline = window.gsap.timeline;
    window.gsap.timeline = function(vars) {
      const tl = origTimeline.call(window.gsap, vars);
      window.__capturedTimelines.push(tl);
      return tl;
    };
  }
  installGsapHook();
  document.addEventListener('DOMContentLoaded', installGsapHook);

  function getMasterTimelines() {
    if (!window.gsap) return [];
    const candidates = [
      ...(window.__capturedTimelines || []),
      ...(window.gsap.globalTimeline ? window.gsap.globalTimeline.getChildren(false, false, true) : []),
      window.tl, window.mainTl, window.masterTl, window.timeline
    ].filter(Boolean);
    const unique = Array.from(new Set(candidates));
    return unique.filter(t => {
      try {
        const d = typeof t.duration === 'function' ? t.duration() : 0;
        return d >= 3 && d < 3600;
      } catch (e) { return false; }
    });
  }

  window.__prepareForExport = function() {
    const ov = document.getElementById('ov') || document.querySelector('[id*="overlay" i], [class*="overlay" i]');
    if (ov) ov.style.display = 'none';

    const bar = document.getElementById('bar') || document.querySelector('[id*="control" i], [class*="control-bar" i], footer');
    if (bar) bar.style.display = 'none';

    if (typeof fit === 'function') {
      try { fit(); } catch (e) {}
    }
    window.dispatchEvent(new Event('resize'));
  };

  window.__isAnimationReady = function() {
    const tls = getMasterTimelines();
    return tls.length > 0;
  };

  window.__seekExactSecond = function(sec, totalFallback) {
    window.__prepareForExport();
    const tls = getMasterTimelines();
    const nativeDur = tls.length > 0 ? tls[0].duration() : (typeof D === 'number' ? D : (totalFallback || 55));
    const clampedSec = Math.max(0, Math.min(nativeDur, sec));

    const rangeInput = document.getElementById('seek') || document.querySelector('input[type="range"]');
    if (rangeInput) {
      const min = parseFloat(rangeInput.min) || 0;
      const max = parseFloat(rangeInput.max) || 100;
      const ratio = nativeDur > 0 ? (clampedSec / nativeDur) : 0;
      rangeInput.value = min + ratio * (max - min);
      rangeInput.dispatchEvent(new Event('input', { bubbles: true }));
    }

    tls.forEach(t => {
      try {
        t.pause();
        t.time(clampedSec, false);
      } catch (e) {}
    });

    if (typeof ui === 'function') {
      try { ui(); } catch (e) {}
    }
  };
})();
</script>
`;

async function renderProjectToMp4(project, outputFile, onProgress) {
  const fps = Number(project.fps) || 30;
  const width = Number(project.width) || 1080;
  const height = Number(project.height) || 1920;
  const videoClips = Array.isArray(project.videoClips) ? project.videoClips : [];
  const audioClips = Array.isArray(project.audioClips) ? project.audioClips : [];

  if (videoClips.length === 0) {
    throw new Error('El proyecto no contiene clips de video en "videoClips".');
  }

  const useNvenc = checkNvencAvailable();
  const gpuLabel = useNvenc ? 'NVIDIA GeForce RTX (h264_nvenc + GPU Raster)' : 'CPU (libx264)';

  const preferredHtml = project.htmlFile || (videoClips[0] && videoClips[0].name ? `${videoClips[0].name}.html` : '');
  const preferredAudio = project.audioFile || (audioClips[0] && audioClips[0].name ? `${audioClips[0].name}.wav` : '');

  // Si estudio.html nos envía el contenido HTML o el audio en Base64 directamente, los usamos; si no, los buscamos en la carpeta
  const runId = Date.now();
  const tempHtmlPath = path.join(WORKSPACE_DIR, `__temp_render_stage_${runId}.html`);
  const tempUploadedAudioPath = path.join(WORKSPACE_DIR, `__temp_input_audio_${runId}.wav`);
  const tempAudioPath = path.join(WORKSPACE_DIR, `__temp_mixed_audio_${runId}.m4a`);

  let rawHtml = project.htmlContent || '';
  if (!rawHtml) {
    const htmlPath = findBestMatchingFile(WORKSPACE_DIR, preferredHtml, ['.html']);
    if (!htmlPath || !fs.existsSync(htmlPath)) {
      throw new Error('No se encontró ningún archivo de animación .html en la carpeta.');
    }
    rawHtml = fs.readFileSync(htmlPath, 'utf8');
  }

  let audioPath = null;
  if (project.audioBase64) {
    const base64Clean = project.audioBase64.replace(/^data:audio\/[^;]+;base64,/, '');
    fs.writeFileSync(tempUploadedAudioPath, Buffer.from(base64Clean, 'base64'));
    audioPath = tempUploadedAudioPath;
  } else {
    audioPath = findBestMatchingFile(WORKSPACE_DIR, preferredAudio, ['.wav', '.mp3', '.m4a', '.ogg']);
  }

  const maxVideoEnd = Math.max(0, ...videoClips.map(c => (Number(c.timelineStart) || 0) + (Number(c.duration) || 0)));
  const maxAudioEnd = Math.max(0, ...audioClips.map(c => (Number(c.timelineStart) || 0) + (Number(c.duration) || 0)));
  const totalDurationSec = Math.max(maxVideoEnd, maxAudioEnd, 0.1);
  const totalFrames = Math.ceil(totalDurationSec * fps);

  if (onProgress) {
    onProgress({
      stage: 'audio',
      frame: 0,
      totalFrames,
      percent: 0,
      gpu: gpuLabel,
      message: 'Procesando pista de audio (Warp + Trim)...'
    });
  }

  let processedAudio = null;
  if (audioPath && audioClips.length > 0) {
    processedAudio = buildAudioMix(audioPath, audioClips, totalDurationSec, tempAudioPath);
  }

  if (rawHtml.includes('</body>')) {
    rawHtml = rawHtml.replace('</body>', UNIVERSAL_RENDER_BRIDGE + '\n</body>');
  } else {
    rawHtml += '\n' + UNIVERSAL_RENDER_BRIDGE;
  }
  fs.writeFileSync(tempHtmlPath, rawHtml, 'utf8');

  // Lanzar Puppeteer activando aceleración por hardware en la tarjeta de video (GPU rasterization, WebGL, Canvas 2D)
  const browser = await puppeteer.launch({
    headless: 'new',
    defaultViewport: { width, height, deviceScaleFactor: 1 },
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      `--window-size=${width},${height}`,
      '--ignore-gpu-blocklist',
      '--enable-gpu',
      '--enable-gpu-rasterization',
      '--enable-accelerated-2d-canvas',
      '--enable-zero-copy',
      '--force-gpu-mem-available-mb=4096'
    ]
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 1 });

    const fileUrl = 'file:///' + tempHtmlPath.replace(/\\/g, '/');
    await page.goto(fileUrl, { waitUntil: 'networkidle0', timeout: 60000 });

    await page.waitForFunction('window.__isAnimationReady && window.__isAnimationReady()', { timeout: 20000 });
    await page.evaluate(() => {
      if (window.__prepareForExport) window.__prepareForExport();
    });
    await new Promise(r => setTimeout(r, 250));

    // Configurar FFmpeg con aceleración por hardware NVIDIA NVENC (h264_nvenc) si está disponible
    const ffmpegArgs = [
      '-y',
      '-f', 'image2pipe',
      '-vcodec', 'mjpeg',
      '-r', String(fps),
      '-i', '-'
    ];

    if (processedAudio && fs.existsSync(processedAudio)) {
      ffmpegArgs.push('-i', processedAudio);
    }

    if (useNvenc) {
      ffmpegArgs.push(
        '-c:v', 'h264_nvenc',
        '-preset', 'p4',
        '-tune', 'hq',
        '-rc', 'vbr',
        '-cq', '19',
        '-b:v', '8M',
        '-maxrate', '14M',
        '-bufsize', '20M',
        '-pix_fmt', 'yuv420p',
        '-r', String(fps)
      );
    } else {
      ffmpegArgs.push(
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '18',
        '-pix_fmt', 'yuv420p',
        '-r', String(fps)
      );
    }

    if (processedAudio && fs.existsSync(processedAudio)) {
      ffmpegArgs.push('-c:a', 'aac', '-b:a', '192k', '-shortest');
    }

    ffmpegArgs.push('-movflags', '+faststart', outputFile);

    const ffmpegProc = spawn('ffmpeg', ffmpegArgs, { stdio: ['pipe', 'ignore', 'pipe'] });

    let ffmpegErrLog = '';
    ffmpegProc.stderr.on('data', chunk => {
      ffmpegErrLog += chunk.toString();
    });

    const ffmpegExitPromise = new Promise((resolve, reject) => {
      ffmpegProc.on('close', code => {
        if (code === 0) resolve();
        else reject(new Error(`FFmpeg finalizó con código ${code}:\n${ffmpegErrLog.slice(-1000)}`));
      });
      ffmpegProc.on('error', reject);
    });

    const startTimeMs = Date.now();
    let lastShownSecond = 0;

    for (let frameIdx = 0; frameIdx < totalFrames; frameIdx++) {
      const timelineSec = frameIdx / fps;
      const activeVideoClip = getActiveClipAt(videoClips, timelineSec);

      let targetGsapSec = lastShownSecond;
      if (activeVideoClip) {
        targetGsapSec = mapTimelineToSource(activeVideoClip, timelineSec);
        lastShownSecond = targetGsapSec;
      }

      await page.evaluate((sec) => {
        if (window.__seekExactSecond) {
          window.__seekExactSecond(sec, 55);
        }
      }, targetGsapSec);

      const frameBuffer = await page.screenshot({
        type: 'jpeg',
        quality: 92,
        encoding: 'binary',
        optimizeForSpeed: true
      });

      const canWrite = ffmpegProc.stdin.write(frameBuffer);
      if (!canWrite) {
        await new Promise(res => ffmpegProc.stdin.once('drain', res));
      }

      if (frameIdx % 5 === 0 || frameIdx === totalFrames - 1) {
        const pct = Number((((frameIdx + 1) / totalFrames) * 100).toFixed(1));
        const elapsed = ((Date.now() - startTimeMs) / 1000).toFixed(1);
        if (onProgress) {
          onProgress({
            stage: 'rendering',
            frame: frameIdx + 1,
            totalFrames,
            percent: pct,
            timelineSec: Number(timelineSec.toFixed(2)),
            gsapSec: Number(targetGsapSec.toFixed(2)),
            elapsedSec: Number(elapsed),
            gpu: gpuLabel,
            message: `Renderizando cuadro ${frameIdx + 1}/${totalFrames} (${pct}%)`
          });
        }
      }
    }

    ffmpegProc.stdin.end();
    await ffmpegExitPromise;

    if (onProgress) {
      onProgress({
        stage: 'done',
        frame: totalFrames,
        totalFrames,
        percent: 100,
        gpu: gpuLabel,
        outputFile,
        fileName: path.basename(outputFile),
        message: `¡Video exportado con éxito!: ${path.basename(outputFile)}`
      });
    }

    return outputFile;
  } finally {
    await browser.close();
    [tempHtmlPath, tempUploadedAudioPath, tempAudioPath].forEach(f => {
      if (fs.existsSync(f)) {
        try { fs.unlinkSync(f); } catch (e) {}
      }
    });
  }
}

// Modo 1: Servidor local para que estudio.html renderice el MP4 directamente con 1 clic
function startServer() {
  let activeJob = null;

  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const urlObj = new URL(req.url, `http://localhost:${PORT}`);

    // Servir estudio.html en la raíz
    if (req.method === 'GET' && (urlObj.pathname === '/' || urlObj.pathname === '/estudio.html')) {
      const html = fs.readFileSync(path.join(WORKSPACE_DIR, 'estudio.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    // Estado del servidor y detección de GPU
    if (req.method === 'GET' && urlObj.pathname === '/api/ping') {
      const nvenc = checkNvencAvailable();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        nvenc,
        gpu: nvenc ? 'NVIDIA GeForce RTX (NVENC Activo)' : 'CPU (libx264)',
        busy: Boolean(activeJob && activeJob.stage !== 'done' && activeJob.stage !== 'error')
      }));
      return;
    }

    // Consultar progreso en vivo del renderizado
    if (req.method === 'GET' && urlObj.pathname === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(activeJob || { stage: 'idle', percent: 0 }));
      return;
    }

    // Devolver el último proyecto_editado.json (de la carpeta o de Descargas) para restaurarlo en estudio.html
    if (req.method === 'GET' && urlObj.pathname === '/api/project') {
      const latestJson = findLatestProjectJson(null);
      if (latestJson && fs.existsSync(latestJson)) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(fs.readFileSync(latestJson, 'utf8'));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No hay proyecto previo' }));
      }
      return;
    }

    // Descargar el video_final.mp4 generado
    if (req.method === 'GET' && urlObj.pathname === '/api/download') {
      const targetMp4 = path.join(WORKSPACE_DIR, 'video_final.mp4');
      if (!fs.existsSync(targetMp4)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Aún no existe video_final.mp4' }));
        return;
      }
      const stat = fs.statSync(targetMp4);
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Length': stat.size,
        'Content-Disposition': 'attachment; filename="video_final.mp4"'
      });
      fs.createReadStream(targetMp4).pipe(res);
      return;
    }

    // Iniciar renderizado directo desde estudio.html
    if (req.method === 'POST' && urlObj.pathname === '/api/render') {
      if (activeJob && activeJob.stage !== 'done' && activeJob.stage !== 'error') {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Ya hay un renderizado en curso.' }));
        return;
      }

      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        try {
          const bodyStr = Buffer.concat(chunks).toString('utf8');
          const project = JSON.parse(bodyStr);
          const outFile = path.join(WORKSPACE_DIR, 'video_final.mp4');

          // Guardar también copia de proyecto_editado.json por respaldo
          const cleanCopy = {
            htmlFile: project.htmlFile,
            audioFile: project.audioFile,
            fps: project.fps || 30,
            width: project.width || 1080,
            height: project.height || 1920,
            videoClips: project.videoClips,
            audioClips: project.audioClips
          };
          fs.writeFileSync(path.join(WORKSPACE_DIR, 'proyecto_editado.json'), JSON.stringify(cleanCopy, null, 2), 'utf8');

          activeJob = {
            stage: 'starting',
            percent: 0,
            frame: 0,
            totalFrames: 0,
            gpu: checkNvencAvailable() ? 'NVIDIA GeForce RTX (h264_nvenc)' : 'CPU (libx264)',
            message: 'Iniciando motor de renderizado con GPU...'
          };

          res.writeHead(202, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ started: true, job: activeJob }));

          console.log(`\n🎬 [Servidor] Renderizando video_final.mp4 solicitado desde estudio.html...`);
          renderProjectToMp4(project, outFile, (prog) => {
            activeJob = prog;
            if (prog.stage === 'rendering' && (prog.frame % 30 === 0 || prog.frame === prog.totalFrames)) {
              process.stdout.write(`\r   ⚡ [${prog.gpu}] Cuadro ${prog.frame}/${prog.totalFrames} (${prog.percent}%) | Tiempo: ${prog.elapsedSec}s   `);
            }
          }).then(() => {
            console.log(`\n✅ [Servidor] ¡video_final.mp4 generado con éxito en: ${outFile}!`);
          }).catch(err => {
            console.error(`\n❌ [Servidor] Error en renderizado:`, err.message || err);
            activeJob = {
              stage: 'error',
              percent: 0,
              message: err.message || String(err)
            };
          });
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Ruta no encontrada' }));
  });

  server.listen(PORT, () => {
    const nvenc = checkNvencAvailable();
    console.log('======================================================================');
    console.log(`🚀 Motor de Renderizado GPU Activo en: http://localhost:${PORT}`);
    console.log(`🎮 Aceleración por Hardware: ${nvenc ? '✅ NVIDIA GeForce RTX (h264_nvenc + GPU Raster)' : '⚠️ CPU (libx264)'}`);
    console.log(`💡 Puedes usar estudio.html abierto en tu navegador (incluso desde file://)`);
    console.log(`   y al pulsar "🎬 Exportar Video MP4 (GPU)" se renderizará automáticamente.`);
    console.log('======================================================================');
  });
}

// Modo 2: Ejecución directa por consola (ej. `node render_mp4.js`)
async function runCli() {
  const explicitArg = process.argv[2] ? path.resolve(process.argv[2]) : null;
  const projectFile = findLatestProjectJson(explicitArg);
  const outputFile = process.argv[3] ? path.resolve(process.argv[3]) : path.join(WORKSPACE_DIR, 'video_final.mp4');

  const nvenc = checkNvencAvailable();
  console.log('🎬 Iniciando Renderizador Universal HTML + Audio -> MP4 (1080x1920 @ 30fps)');
  console.log(`🎮 Aceleración por Tarjeta de Video: ${nvenc ? '✅ NVIDIA GeForce RTX (h264_nvenc + GPU Raster)' : 'CPU (libx264)'}`);

  let project = null;
  if (projectFile && fs.existsSync(projectFile)) {
    console.log(`📂 Leyendo proyecto editado desde: ${projectFile}`);
    project = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
    // Guardar copia actualizada en la carpeta de trabajo
    const localCopy = path.join(WORKSPACE_DIR, 'proyecto_editado.json');
    if (path.resolve(projectFile) !== path.resolve(localCopy)) {
      fs.copyFileSync(projectFile, localCopy);
      console.log(`💾 Copia sincronizada en: ${localCopy}`);
    }
  } else {
    console.log(`⚠️ No se encontró "proyecto_editado.json" ni en la carpeta ni en Descargas. Usando archivos sin recortar...`);
    const autoHtml = findBestMatchingFile(WORKSPACE_DIR, null, ['.html']);
    const autoAudio = findBestMatchingFile(WORKSPACE_DIR, null, ['.wav', '.mp3', '.m4a', '.ogg']);
    project = {
      htmlFile: autoHtml ? path.basename(autoHtml) : '',
      audioFile: autoAudio ? path.basename(autoAudio) : '',
      fps: 30,
      width: 1080,
      height: 1920,
      videoClips: [{ timelineStart: 0, duration: 55, sourceStart: 0, sourceEnd: 55 }],
      audioClips: autoAudio ? [{ timelineStart: 0, duration: 53.52, sourceStart: 0, sourceEnd: 53.52 }] : []
    };
  }

  console.log(`🎞️ Clips de video a renderizar (${project.videoClips.length}):`);
  project.videoClips.forEach((c, idx) => {
    const spd = ((c.sourceEnd - c.sourceStart) / Math.max(0.05, c.duration)).toFixed(2);
    console.log(`   [${idx + 1}] Línea: ${c.timelineStart}s -> ${(c.timelineStart + c.duration).toFixed(2)}s (dur: ${c.duration}s) | HTML: ${c.sourceStart}s -> ${c.sourceEnd}s (${spd}x)`);
  });

  await renderProjectToMp4(project, outputFile, (prog) => {
    if (prog.stage === 'rendering' && (prog.frame % 15 === 0 || prog.frame === prog.totalFrames)) {
      process.stdout.write(`\r   ⚡ Cuadro ${prog.frame}/${prog.totalFrames} (${prog.percent}%) | Timeline: ${prog.timelineSec}s -> HTML: ${prog.gsapSec}s | Tiempo: ${prog.elapsedSec}s   `);
    } else if (prog.stage === 'done') {
      process.stdout.write('\n');
      console.log(`✅ ${prog.message}`);
      console.log(`📁 Ruta: ${prog.outputFile}`);
    }
  });
}

if (process.argv.includes('--server')) {
  startServer();
} else {
  runCli().catch(err => {
    console.error('\n❌ Error durante el renderizado:', err.message || err);
    process.exit(1);
  });
}
