const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const config = require('./config');
const db = require('./db/database');
const kickService = require('./kick/kickService');
const { validateStreamUrl, validateLocalVideoFile } = require('./security/ssrfValidator');
const probeService = require('./streaming/probeService');
const queueService = require('./queue/queueService');
const scheduler = require('./queue/scheduler');
const { setupWebSocket } = require('./websocket');
const downloadManager = require('./streaming/downloadManager');
const clipManager = require('./streaming/clipManager');
const multer = require('multer');

const ALLOWED_VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.mkv', '.flv', '.avi']);
const ALLOWED_VIDEO_MIMES = new Set([
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/x-matroska',
  'video/x-flv',
  'video/x-msvideo',
  'application/octet-stream'
]);

const uploadStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.resolve(__dirname, '..', 'uploads');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.mp4';
    const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9_-]/g, '_');
    cb(null, `${base}_${Date.now()}${ext}`);
  }
});

const upload = multer({
  storage: uploadStorage,
  limits: { fileSize: 2000 * 1024 * 1024 }, // 2GB
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_VIDEO_EXTS.has(ext)) {
      return cb(new Error(`Invalid file extension "${ext}". Allowed video formats: mp4, webm, mov, mkv, flv, avi.`));
    }
    if (!ALLOWED_VIDEO_MIMES.has(file.mimetype.toLowerCase())) {
      return cb(new Error(`Invalid MIME type "${file.mimetype}". Only video uploads are permitted.`));
    }
    cb(null, true);
  }
});

// In-memory rate limiter with periodic cleanup to prevent unbounded memory growth
const rateLimitMap = new Map();
const rateLimitCleaner = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitMap.entries()) {
    if (now > entry.resetAt) {
      rateLimitMap.delete(key);
    }
  }
}, 60000);
if (rateLimitCleaner.unref) rateLimitCleaner.unref();

function rateLimit({ windowMs = 60000, max = 20, message = 'Too many requests, please slow down.' }) {
  return (req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress || '127.0.0.1';
    const key = `${req.path}:${ip}`;
    const now = Date.now();
    const entry = rateLimitMap.get(key) || { count: 0, resetAt: now + windowMs };

    if (now > entry.resetAt) {
      entry.count = 1;
      entry.resetAt = now + windowMs;
    } else {
      entry.count++;
    }

    rateLimitMap.set(key, entry);

    if (entry.count > max) {
      return res.status(429).json({ success: false, error: message });
    }
    next();
  };
}

const app = express();
const server = http.createServer(app);

// Attach WebSocket Telemetry server
setupWebSocket(server);

// Defensive Security Headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; media-src 'self' blob: data: http: https:; connect-src 'self' ws: wss: http: https:; img-src 'self' data: https:;"
  );
  next();
});

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve frontend static assets
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------------- DASHBOARD METRICS ----------------
app.get('/api/metrics', (req, res) => {
  try {
    const metrics = db.getDashboardMetrics();
    const active = queueService.getActiveSession();
    return res.json({ success: true, metrics, activeSession: active });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------- SOURCE VALIDATION & PROBE ----------------
app.post('/api/stream/validate', rateLimit({ windowMs: 60000, max: 30 }), async (req, res) => {
  const { sourceUrl, sourceType, sourceFileName } = req.body;
  const target = sourceFileName || sourceUrl;
  if (!target) {
    return res.status(400).json({ success: false, error: 'Source URL or downloaded video file is required.' });
  }

  let safety;
  if (sourceType === 'download' || sourceType === 'local' || /^(local|download|clip|file):/i.test(target)) {
    safety = validateLocalVideoFile(target);
  } else {
    safety = await validateStreamUrl(target);
  }

  if (!safety.valid) {
    return res.status(400).json({ success: false, error: safety.error });
  }

  // 2. Stream Probing
  try {
    const probe = await probeService.probeStream(safety.sanitizedUrl);
    return res.json({
      success: true,
      detectedType: safety.detectedType,
      sanitizedUrl: safety.sanitizedUrl,
      isLocalFile: !!safety.isLocalFile,
      fileName: safety.fileName || null,
      probe
    });
  } catch (err) {
    return res.status(400).json({
      success: false,
      detectedType: safety.detectedType,
      error: err.message
    });
  }
});

// ---------------- BROADCAST CONTROLS ----------------
app.post('/api/stream/start', rateLimit({ windowMs: 60000, max: 15 }), async (req, res) => {
  const {
    sourceUrl,
    sourceType,
    sourceFileName,
    loopVideo,
    customStreamKey,
    rtmpUrl,
    kickAccountId,
    qualityPreset,
    recordEnabled,
    ownershipConfirmed,
    title
  } = req.body;

  // Enforce ownership / authorization confirmation
  if (!ownershipConfirmed) {
    return res.status(400).json({
      success: false,
      error: 'You must confirm that you own or have permission to broadcast this content.'
    });
  }

  const target = sourceFileName || sourceUrl;
  if (!target) {
    return res.status(400).json({ success: false, error: 'Source livestream URL or downloaded file is required.' });
  }

  let safety;
  if (sourceType === 'download' || sourceType === 'local' || /^(local|download|clip|file):/i.test(target)) {
    safety = validateLocalVideoFile(target);
  } else {
    safety = await validateStreamUrl(target);
  }

  if (!safety.valid) {
    return res.status(400).json({ success: false, error: safety.error });
  }

  try {
    const session = await queueService.startStream({
      title: title || (safety.isLocalFile ? `Broadcast: ${safety.fileName}` : undefined),
      sourceUrl: safety.sanitizedUrl,
      sourceFormat: safety.detectedType,
      isLocalFile: !!safety.isLocalFile,
      loopVideo: !!loopVideo,
      customStreamKey,
      rtmpUrl,
      kickAccountId,
      qualityPreset: qualityPreset || 'source',
      recordEnabled: !!recordEnabled
    });

    return res.json({
      success: true,
      message: safety.isLocalFile ? 'Broadcasting downloaded video to Kick.' : 'Broadcasting started successfully to Kick.',
      session
    });
  } catch (err) {
    const isConflict = err.message.includes('currently live') || err.message.includes('already');
    return res.status(isConflict ? 409 : 400).json({
      success: false,
      error: err.message
    });
  }
});

app.post('/api/stream/stop', async (req, res) => {
  const { sessionId } = req.body;
  try {
    const result = await queueService.stopStream(sessionId);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/stream/active', (req, res) => {
  const active = queueService.getActiveSession();
  return res.json({ active: !!active, session: active });
});

app.get('/api/stream/history', (req, res) => {
  const sessions = db.getStreamSessions(25);
  return res.json({ success: true, sessions });
});

// ---------------- KICK INTEGRATION ----------------
app.get('/api/kick/status', (req, res) => {
  const status = kickService.getIntegrationStatus();
  return res.json({ success: true, ...status });
});

app.post('/api/kick/connect', async (req, res) => {
  const { kickUsername, channelSlug, streamKey, rtmpUrl } = req.body;
  try {
    const result = await kickService.connectAccount({ kickUsername, channelSlug, streamKey, rtmpUrl });
    return res.json(result);
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
});

app.delete('/api/kick/account/:id', (req, res) => {
  const ok = kickService.disconnectAccount(req.params.id);
  return res.json({ success: ok });
});

// ---------------- SCHEDULER ----------------
app.get('/api/schedule', (req, res) => {
  const scheduled = db.getScheduledStreams();
  return res.json({ success: true, scheduled });
});

app.post('/api/schedule', (req, res) => {
  try {
    const created = scheduler.schedule(req.body);
    return res.json({ success: true, scheduled: created });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
});

app.delete('/api/schedule/:id', (req, res) => {
  const ok = scheduler.delete(req.params.id);
  return res.json({ success: ok });
});

// ---------------- VIDEO DOWNLOAD FROM URL ----------------
app.post('/api/download/start', rateLimit({ windowMs: 60000, max: 15 }), async (req, res) => {
  const { sourceUrl, title, durationSeconds, resolution } = req.body;
  if (!sourceUrl) {
    return res.status(400).json({ success: false, error: 'Source video URL is required.' });
  }

  const allowedResolutions = new Set(['source', 'original', '1080p', '720p', '480p', '360p']);
  const safeResolution = allowedResolutions.has(String(resolution || '').toLowerCase())
    ? String(resolution).toLowerCase()
    : 'source';

  const safety = await validateStreamUrl(sourceUrl);
  if (!safety.valid) {
    return res.status(400).json({ success: false, error: safety.error });
  }

  try {
    const result = await downloadManager.startDownload({
      sourceUrl: safety.sanitizedUrl,
      title,
      durationSeconds,
      resolution: safeResolution
    });
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/download/stop', (req, res) => {
  const { id } = req.body;
  const result = downloadManager.stopDownload(id);
  return res.json(result);
});

app.get('/api/download/active', (req, res) => {
  const active = downloadManager.getActiveDownloads();
  return res.json({ success: true, active });
});

app.get('/api/download/files', (req, res) => {
  const files = downloadManager.getCompletedFiles();
  return res.json({ success: true, files });
});

app.get('/api/download/file/:filename', (req, res) => {
  const fileCheck = validateLocalVideoFile(req.params.filename);
  if (!fileCheck.valid || fileCheck.category !== 'downloads') {
    return res.status(404).send('File not found or invalid.');
  }

  res.setHeader('Content-Disposition', `attachment; filename="${fileCheck.fileName}"`);
  res.setHeader('Content-Type', 'video/mp4');
  fs.createReadStream(fileCheck.sanitizedUrl).pipe(res);
});

app.delete('/api/download/file/:filename', (req, res) => {
  const ok = downloadManager.deleteFile(req.params.filename);
  return res.json({ success: ok });
});

// ---------------- OPENSHORTS VIDEO CLIPPER ----------------
app.post('/api/clips/upload', rateLimit({ windowMs: 60000, max: 10 }), upload.single('video'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No video file provided.' });
    }
    const filePath = req.file.path;
    const probe = await clipManager.probeVideo(filePath);
    return res.json({
      success: true,
      file: {
        originalName: req.file.originalname,
        fileName: req.file.filename,
        filePath: filePath,
        fileSizeBytes: req.file.size,
        durationSeconds: probe.durationSec,
        resolution: probe.resolution
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/clips/create', rateLimit({ windowMs: 60000, max: 15 }), async (req, res) => {
  try {
    const {
      sourceVideoPath,
      sourceFileName,
      startTime,
      endTime,
      layout,
      title,
      hookText,
      captionText,
      captionFont,
      captionStyle,
      captionPosition,
      captionSize
    } = req.body;

    const candidate = sourceFileName || sourceVideoPath;
    if (!candidate) {
      return res.status(400).json({ success: false, error: 'Source video file or file name is required.' });
    }

    const fileCheck = validateLocalVideoFile(candidate);
    if (!fileCheck.valid) {
      return res.status(400).json({ success: false, error: fileCheck.error });
    }

    const clip = await clipManager.createClip({
      sourceVideoPath: fileCheck.sanitizedUrl,
      startTime,
      endTime,
      layout,
      title,
      hookText,
      captionText,
      captionFont,
      captionStyle,
      captionPosition,
      captionSize
    });

    return res.json({ success: true, clip });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/clips', (req, res) => {
  try {
    const clips = clipManager.getClips();
    return res.json({ success: true, clips });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/clips/preview/:filename', (req, res) => {
  const fileCheck = validateLocalVideoFile(req.params.filename);
  if (!fileCheck.valid || fileCheck.category !== 'clips') {
    return res.status(404).send('Clip not found or invalid.');
  }
  res.setHeader('Content-Type', 'video/mp4');
  fs.createReadStream(fileCheck.sanitizedUrl).pipe(res);
});

app.get('/api/clips/download/:filename', (req, res) => {
  const fileCheck = validateLocalVideoFile(req.params.filename);
  if (!fileCheck.valid || fileCheck.category !== 'clips') {
    return res.status(404).send('Clip not found or invalid.');
  }
  res.setHeader('Content-Disposition', `attachment; filename="${fileCheck.fileName}"`);
  res.setHeader('Content-Type', 'video/mp4');
  fs.createReadStream(fileCheck.sanitizedUrl).pipe(res);
});

app.delete('/api/clips/:id', (req, res) => {
  try {
    const ok = clipManager.deleteClip(req.params.id);
    return res.json({ success: ok });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------- SSE LOGS FEED ----------------
app.get('/api/logs/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const active = queueService.getActiveSession();
  res.write(`data: ${JSON.stringify({ type: 'init', activeSession: active })}\n\n`);

  const onLog = (data) => {
    res.write(`data: ${JSON.stringify({ type: 'log', log: data })}\n\n`);
  };

  const onSessionUpdate = (data) => {
    res.write(`data: ${JSON.stringify({ type: 'session_update', status: data })}\n\n`);
  };

  queueService.on('log', onLog);
  queueService.on('session_update', onSessionUpdate);

  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    queueService.removeListener('log', onLog);
    queueService.removeListener('session_update', onSessionUpdate);
  });
});

// ---------------- API 404 HANDLER ----------------
app.all('/api/*', (req, res) => {
  res.status(404).json({ success: false, error: 'API endpoint not found.' });
});

// ---------------- SPA FALLBACK ----------------
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

server.listen(config.PORT, () => {
  console.log(`\n======================================================`);
  console.log(`  KICK RESTREAM PLATFORM - BROADCAST ENGINE ONLINE`);
  console.log(`  Web Control Room:  http://localhost:${config.PORT}`);
  console.log(`  Telemetry WS:      ws://localhost:${config.PORT}/ws/telemetry`);
  console.log(`  Engine Binary:     ${queueService.activeWorkers ? 'FFmpeg Static / System' : 'FFmpeg'}`);
  console.log(`  Target Platform:   Kick RTMP Ingest Only`);
  console.log(`======================================================\n`);
});
