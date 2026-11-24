const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const probeService = require('./probeService');
const { getFfmpegProtocolWhitelist } = require('../security/ssrfValidator');
const { timeToSeconds, formatSecondsToTime } = require('./timeUtils');

const DOWNLOADS_DIR = path.resolve(__dirname, '..', '..', 'downloads');
if (!fs.existsSync(DOWNLOADS_DIR)) {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

class DownloadManager {
  constructor() {
    this.activeDownloads = new Map();
    this.resolutionStoreFile = path.resolve(__dirname, '..', '..', 'data', 'downloads_store.json');
    this.resolutionCache = new Map();
    this.loadStore();
    this.syncInitialResolutions();
  }

  loadStore() {
    try {
      if (fs.existsSync(this.resolutionStoreFile)) {
        const raw = fs.readFileSync(this.resolutionStoreFile, 'utf8');
        const data = JSON.parse(raw);
        if (data && typeof data === 'object') {
          for (const [k, v] of Object.entries(data)) {
            this.resolutionCache.set(k, v);
          }
        }
      }
    } catch (_) {}
  }

  saveStore() {
    try {
      const obj = {};
      for (const [k, v] of this.resolutionCache.entries()) {
        obj[k] = v;
      }
      fs.writeFileSync(this.resolutionStoreFile, JSON.stringify(obj, null, 2), 'utf8');
    } catch (_) {}
  }

  syncInitialResolutions() {
    try {
      const files = fs.readdirSync(DOWNLOADS_DIR).filter(f => f.endsWith('.mp4'));
      for (const file of files) {
        if (!this.resolutionCache.has(file)) {
          this.probeFileResolution(file).catch(() => {});
        }
      }
    } catch (_) {}
  }

  probeFileResolution(fileName) {
    if (this.resolutionCache.has(fileName)) {
      return Promise.resolve(this.resolutionCache.get(fileName));
    }
    const filePath = path.join(DOWNLOADS_DIR, fileName);
    if (!fs.existsSync(filePath)) return Promise.resolve('Source');

    const ffmpegPath = this.resolveBinary();
    return new Promise(resolve => {
      const proc = spawn(ffmpegPath, ['-hide_banner', '-i', filePath], { windowsHide: true });
      let stderr = '';
      proc.stderr.on('data', d => stderr += d);
      proc.on('close', () => {
        const match = stderr.match(/Video:.*?(\d{3,4}x\d{3,4})/);
        const res = match ? match[1] : 'Source';
        this.resolutionCache.set(fileName, res);
        this.saveStore();
        resolve(res);
      });
      proc.on('error', () => resolve('Source'));
    });
  }

  resolveBinary() {
    if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
    try {
      const staticFfmpeg = require('ffmpeg-static');
      if (staticFfmpeg && fs.existsSync(staticFfmpeg)) return staticFfmpeg;
    } catch (_) {}
    return 'ffmpeg';
  }

  getActiveDownloads() {
    const list = [];
    for (const [id, task] of this.activeDownloads) {
      list.push({
        id,
        title: task.title,
        fileName: task.fileName,
        resolution: task.resolution || 'Source',
        timeRange: task.timeRange || 'Full Stream',
        downloadedBytes: task.downloadedBytes,
        durationSeconds: task.durationSeconds,
        speed: task.speed,
        status: task.status
      });
    }
    return list;
  }

  getCompletedFiles() {
    try {
      const files = fs.readdirSync(DOWNLOADS_DIR).filter(f => f.endsWith('.mp4'));
      return files.map(fileName => {
        const filePath = path.join(DOWNLOADS_DIR, fileName);
        const stats = fs.statSync(filePath);
        const resolution = this.resolutionCache.get(fileName) || 'Source';
        return {
          fileName,
          resolution,
          fileSizeBytes: stats.size,
          createdAt: stats.mtime.toISOString(),
          downloadUrl: `/api/download/file/${encodeURIComponent(fileName)}`
        };
      }).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    } catch (_) {
      return [];
    }
  }

  async startDownload({ sourceUrl, title, durationSeconds, resolution = 'source', startTime, endTime }) {
    if (!sourceUrl || typeof sourceUrl !== 'string' || !sourceUrl.trim()) {
      throw new Error('Valid video URL is required.');
    }

    const cleanSource = sourceUrl.trim();
    const cleanTitle = (title || 'video').trim().replace(/[^a-zA-Z0-9_-]/g, '_');
    const cleanRes = (resolution || 'source').toLowerCase();

    // Timestamp & range processing
    const startSec = timeToSeconds(startTime);
    const endSec = timeToSeconds(endTime);

    let clipDuration = null;
    if (endSec > startSec) {
      clipDuration = endSec - startSec;
    } else {
      const dur = parseInt(durationSeconds, 10);
      if (dur > 0) {
        clipDuration = dur;
      }
    }

    let timeRangeDisplay = 'Full Stream';
    let timeLabel = '';
    if (startSec > 0 && endSec > startSec) {
      timeRangeDisplay = `${formatSecondsToTime(startSec)} → ${formatSecondsToTime(endSec)} (${Math.round(clipDuration)}s)`;
      timeLabel = `clip_${Math.round(startSec)}s_${Math.round(endSec)}s_`;
    } else if (startSec > 0) {
      timeRangeDisplay = `From ${formatSecondsToTime(startSec)}${clipDuration ? ` (${Math.round(clipDuration)}s)` : ''}`;
      timeLabel = `from_${Math.round(startSec)}s_`;
    } else if (clipDuration > 0) {
      timeRangeDisplay = `First ${Math.round(clipDuration)}s`;
    }

    const taskId = 'dl_' + Date.now().toString(36);
    const fileName = `${cleanTitle}_${timeLabel}${cleanRes !== 'source' ? cleanRes + '_' : ''}${taskId}.mp4`;
    const filePath = path.join(DOWNLOADS_DIR, fileName);

    let resolvedUrls = [cleanSource];
    const isYouTube = /youtube\.com|youtu\.be/i.test(cleanSource);
    if (isYouTube) {
      const resolved = await probeService.resolveSourceUrls(cleanSource);
      resolvedUrls = resolved.streamUrls;
    }

    const ffmpegPath = this.resolveBinary();
    const args = [];

    // Protocol whitelisting prevents malicious playlist sub-requests
    const isLocal = fs.existsSync(cleanSource);
    const whitelist = getFfmpegProtocolWhitelist(isLocal);
    args.push('-protocol_whitelist', whitelist);

    // Fast input seek if start timestamp is provided
    if (startSec > 0) {
      args.push('-ss', String(startSec));
    }

    // Input(s)
    if (resolvedUrls.length > 1) {
      args.push('-i', resolvedUrls[0]);
      if (startSec > 0) {
        args.push('-ss', String(startSec));
      }
      args.push('-i', resolvedUrls[1]);
    } else {
      args.push('-i', resolvedUrls[0]);
    }

    // Resolution & Video Encoding Strategy
    const scaleMap = {
      '1080p': 'scale=-2:1080',
      '720p': 'scale=-2:720',
      '480p': 'scale=-2:480',
      '360p': 'scale=-2:360'
    };

    if (scaleMap[cleanRes]) {
      args.push('-vf', scaleMap[cleanRes], '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-c:a', 'aac', '-b:a', '128k');
    } else if (resolvedUrls.length > 1) {
      args.push('-c:v', 'copy', '-c:a', 'aac');
    } else {
      args.push('-c', 'copy');
    }

    // Clip duration limit
    if (clipDuration && clipDuration > 0) {
      args.push('-t', String(clipDuration));
    }

    args.push('-movflags', '+faststart', '-y', filePath);

    const proc = spawn(ffmpegPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });

    const displayResolution = cleanRes === 'source' ? 'Source' : cleanRes.toUpperCase();

    const task = {
      id: taskId,
      title: cleanTitle,
      fileName,
      filePath,
      resolution: displayResolution,
      timeRange: timeRangeDisplay,
      process: proc,
      status: 'DOWNLOADING',
      downloadedBytes: 0,
      durationSeconds: 0,
      speed: '0x'
    };

    this.activeDownloads.set(taskId, task);

    proc.stderr.on('data', chunk => {
      const text = chunk.toString();
      const sizeMatch = text.match(/size=\s*(\d+)kB/i);
      if (sizeMatch) {
        task.downloadedBytes = parseInt(sizeMatch[1], 10) * 1024;
      }
      const timeMatch = text.match(/time=(\d{2}):(\d{2}):(\d{2})/);
      if (timeMatch) {
        const h = parseInt(timeMatch[1], 10);
        const m = parseInt(timeMatch[2], 10);
        const s = parseInt(timeMatch[3], 10);
        task.durationSeconds = h * 3600 + m * 60 + s;
      }
      const speedMatch = text.match(/speed=\s*([\d.]+)x/);
      if (speedMatch) {
        task.speed = `${speedMatch[1]}x`;
      }
    });

    proc.on('close', () => {
      this.activeDownloads.delete(taskId);
      if (fs.existsSync(filePath)) {
        this.probeFileResolution(fileName).catch(() => {});
      }
    });

    proc.on('error', () => {
      this.activeDownloads.delete(taskId);
    });

    return {
      success: true,
      id: taskId,
      fileName,
      resolution: displayResolution,
      timeRange: timeRangeDisplay,
      message: `Video download started (${timeRangeDisplay}, ${displayResolution}).`
    };
  }

  stopDownload(taskId) {
    const task = this.activeDownloads.get(taskId);
    if (!task || !task.process) {
      return { success: false, message: 'No active download found.' };
    }

    try {
      if (task.process.stdin && task.process.stdin.writable) {
        task.process.stdin.write('q\n');
      }
    } catch (_) {}

    setTimeout(() => {
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', String(task.process.pid), '/T', '/F']);
        } else {
          task.process.kill('SIGKILL');
        }
      } catch (_) {
        try { task.process.kill(); } catch (__) {}
      }
    }, 2000);

    return { success: true, message: 'Download stopped.' };
  }

  deleteFile(fileName) {
    if (!fileName || typeof fileName !== 'string') return false;
    const safeName = path.basename(fileName);
    if (!safeName || safeName === '.' || safeName === '..') return false;
    const target = path.resolve(DOWNLOADS_DIR, safeName);
    const dirWithSep = DOWNLOADS_DIR.endsWith(path.sep) ? DOWNLOADS_DIR : DOWNLOADS_DIR + path.sep;
    if (!target.startsWith(dirWithSep)) return false;
    if (fs.existsSync(target) && fs.statSync(target).isFile()) {
      try {
        fs.unlinkSync(target);
        this.resolutionCache.delete(safeName);
        this.saveStore();
        return true;
      } catch (_) {}
    }
    return false;
  }
}

module.exports = new DownloadManager();
