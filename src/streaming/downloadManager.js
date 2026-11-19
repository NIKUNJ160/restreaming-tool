const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const probeService = require('./probeService');
const { getFfmpegProtocolWhitelist } = require('../security/ssrfValidator');

const DOWNLOADS_DIR = path.resolve(__dirname, '..', '..', 'downloads');
if (!fs.existsSync(DOWNLOADS_DIR)) {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

class DownloadManager {
  constructor() {
    this.activeDownloads = new Map();
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
        return {
          fileName,
          fileSizeBytes: stats.size,
          createdAt: stats.mtime.toISOString(),
          downloadUrl: `/api/download/file/${encodeURIComponent(fileName)}`
        };
      }).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    } catch (_) {
      return [];
    }
  }

  async startDownload({ sourceUrl, title, durationSeconds }) {
    if (!sourceUrl || typeof sourceUrl !== 'string' || !sourceUrl.trim()) {
      throw new Error('Valid video URL is required.');
    }

    const cleanSource = sourceUrl.trim();
    const cleanTitle = (title || 'video').trim().replace(/[^a-zA-Z0-9_-]/g, '_');
    const taskId = 'dl_' + Date.now().toString(36);
    const fileName = `${cleanTitle}_${taskId}.mp4`;
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

    if (resolvedUrls.length > 1) {
      args.push('-i', resolvedUrls[0]);
      args.push('-i', resolvedUrls[1]);
      args.push('-c:v', 'copy', '-c:a', 'aac');
    } else {
      args.push('-i', resolvedUrls[0]);
      args.push('-c', 'copy');
    }

    const dur = parseInt(durationSeconds, 10);
    if (dur > 0) {
      args.push('-t', String(dur));
    }

    args.push('-movflags', '+faststart', '-y', filePath);

    const proc = spawn(ffmpegPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });

    const task = {
      id: taskId,
      title: cleanTitle,
      fileName,
      filePath,
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
    });

    proc.on('error', () => {
      this.activeDownloads.delete(taskId);
    });

    return {
      success: true,
      id: taskId,
      fileName,
      message: 'Video download started.'
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
      try { fs.unlinkSync(target); return true; } catch (_) {}
    }
    return false;
  }
}

module.exports = new DownloadManager();
