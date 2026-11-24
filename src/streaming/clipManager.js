const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { timeToSeconds } = require('./timeUtils');

const UPLOADS_DIR = path.resolve(__dirname, '..', '..', 'uploads');
const CLIPS_DIR = path.resolve(__dirname, '..', '..', 'clips');

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(CLIPS_DIR)) fs.mkdirSync(CLIPS_DIR, { recursive: true });

class ClipManager {
  constructor() {
    this.clipsStoreFile = path.resolve(__dirname, '..', '..', 'data', 'clips_store.json');
    this.clips = [];
    this.load();
  }

  resolveBinary() {
    if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
    try {
      const staticFfmpeg = require('ffmpeg-static');
      if (staticFfmpeg && fs.existsSync(staticFfmpeg)) return staticFfmpeg;
    } catch (_) {}
    return 'ffmpeg';
  }

  load() {
    try {
      if (fs.existsSync(this.clipsStoreFile)) {
        this.clips = JSON.parse(fs.readFileSync(this.clipsStoreFile, 'utf8'));
      }
    } catch (_) {
      this.clips = [];
    }
  }

  save() {
    try {
      fs.writeFileSync(this.clipsStoreFile, JSON.stringify(this.clips, null, 2), 'utf8');
    } catch (_) {}
  }

  getClips() {
    this.load();
    return this.clips;
  }

  /**
   * Probes video metadata (duration in seconds, dimensions).
   */
  async probeVideo(filePath) {
    const ffmpegPath = this.resolveBinary();
    return new Promise((resolve) => {
      const proc = spawn(ffmpegPath, ['-hide_banner', '-i', filePath], { windowsHide: true });
      let stderr = '';
      proc.stderr.on('data', chunk => stderr += chunk.toString());
      proc.on('close', () => {
        let durationSec = 0;
        let resolution = '1920x1080';

        const durMatch = stderr.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2}\.\d+)/);
        if (durMatch) {
          const h = parseInt(durMatch[1], 10);
          const m = parseInt(durMatch[2], 10);
          const s = parseFloat(durMatch[3]);
          durationSec = Math.round(h * 3600 + m * 60 + s);
        }

        const resMatch = stderr.match(/Video:.*?(\d{3,4}x\d{3,4})/);
        if (resMatch) resolution = resMatch[1];

        resolve({ durationSec, resolution });
      });
    });
  }

  formatFfmpegPath(rawPath) {
    if (!rawPath) return '';
    let p = rawPath.replace(/\\/g, '/');
    if (/^[A-Za-z]:/.test(p)) {
      p = p[0] + '\\:' + p.slice(2);
    }
    return p;
  }

  resolveFontFile(fontChoice = 'segoe') {
    const isWindows = process.platform === 'win32';
    if (isWindows) {
      const winDir = process.env.WINDIR || 'C:\\Windows';
      const map = {
        'segoe': path.join(winDir, 'Fonts', 'segoeuib.ttf'),
        'impact': path.join(winDir, 'Fonts', 'impact.ttf'),
        'arial_bold': path.join(winDir, 'Fonts', 'arialbd.ttf'),
        'trebuchet': path.join(winDir, 'Fonts', 'trebucbd.ttf'),
        'arial': path.join(winDir, 'Fonts', 'arial.ttf')
      };
      if (map[fontChoice] && fs.existsSync(map[fontChoice])) {
        return map[fontChoice];
      }
      if (fs.existsSync(map.segoe)) return map.segoe;
      if (fs.existsSync(map.arial_bold)) return map.arial_bold;
    }
    const linuxFonts = [
      '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
      '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
      '/usr/share/fonts/truetype/freefont/FreeSansBold.ttf'
    ];
    for (const f of linuxFonts) {
      if (fs.existsSync(f)) return f;
    }
    return null;
  }

  /**
   * Generates a trimmed, reframed clip inspired by OpenShorts with modern typography captions.
   * @param {Object} params
   * @param {string} params.sourceVideoPath Path to uploaded video
   * @param {string} params.startTime e.g. "00:00:10" or seconds "10"
   * @param {string} params.endTime e.g. "00:00:45" or seconds "45"
   * @param {string} params.layout "vertical_blur" | "vertical_crop" | "square" | "landscape"
   * @param {string} params.title Custom clip name
   * @param {string} params.captionText Optional headline / hook caption text
   * @param {string} params.captionFont "segoe" | "impact" | "arial_bold" | "trebuchet"
   * @param {string} params.captionStyle "kick_green" | "tiktok_white" | "shorts_yellow" | "fire_red" | "dark_box"
   * @param {string} params.captionPosition "top_hook" | "bottom" | "center"
   * @param {string} params.captionSize "medium" | "large" | "small"
   */
  async createClip({
    sourceVideoPath,
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
  }) {
    if (!sourceVideoPath || !fs.existsSync(sourceVideoPath)) {
      throw new Error('Source video file does not exist.');
    }

    const startSec = timeToSeconds(startTime || 0);
    const endSec = timeToSeconds(endTime || 0);
    const clipDuration = endSec > startSec ? (endSec - startSec) : null;

    const clipId = 'clip_' + crypto.randomUUID().slice(0, 8);
    const cleanTitle = (title || 'short_clip').replace(/[^a-zA-Z0-9_-]/g, '_');
    const outputFilename = `${cleanTitle}_${clipId}.mp4`;
    const outputPath = path.join(CLIPS_DIR, outputFilename);

    const ffmpegPath = this.resolveBinary();
    const args = ['-protocol_whitelist', 'file,crypto'];

    // Fast seek to start
    if (startSec > 0) {
      args.push('-ss', String(startSec));
    }

    args.push('-i', sourceVideoPath);

    // Duration limit
    if (clipDuration && clipDuration > 0) {
      args.push('-t', String(clipDuration));
    }

    // OpenShorts Layout Filtering
    const selectedLayout = layout || 'vertical_blur';
    let filterGraph = '';

    if (selectedLayout === 'vertical_blur') {
      // 9:16 Vertical with Blurred Background (OpenShorts flagship format)
      filterGraph = '[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=20:5[bg];[0:v]scale=1080:1920:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2';
    } else if (selectedLayout === 'vertical_crop') {
      filterGraph = 'crop=ih*9/16:ih:(iw-ih*9/16)/2:0,scale=1080:1920';
    } else if (selectedLayout === 'square') {
      filterGraph = 'crop=min(iw\\,ih):min(iw\\,ih),scale=1080:1080';
    } else {
      filterGraph = 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2';
    }

    // Modern Caption / Hook Overlay
    const rawCaption = (captionText || hookText || '').trim();
    let tempCaptionFile = null;

    if (rawCaption) {
      tempCaptionFile = path.resolve(__dirname, '..', '..', 'data', `caption_${clipId}.txt`);
      fs.writeFileSync(tempCaptionFile, rawCaption, 'utf8');

      const fontFile = this.resolveFontFile(captionFont || 'segoe');
      const fontFilePathEscaped = fontFile ? this.formatFfmpegPath(fontFile) : null;
      const textFilePathEscaped = this.formatFfmpegPath(tempCaptionFile);

      // Sizing
      let fontSize = 52;
      if (captionSize === 'large') fontSize = 64;
      else if (captionSize === 'small') fontSize = 38;
      if (selectedLayout === 'square') fontSize = Math.round(fontSize * 0.9);
      else if (selectedLayout === 'landscape') fontSize = Math.round(fontSize * 0.85);

      // Positioning
      const pos = captionPosition || 'top_hook';
      let xPos = '(w-text_w)/2';
      let yPos = 'h*0.13';
      if (pos === 'bottom') {
        yPos = (selectedLayout === 'vertical_blur' || selectedLayout === 'vertical_crop') ? 'h*0.80' : 'h*0.82';
      } else if (pos === 'center') {
        yPos = '(h-text_h)/2';
      } else if (pos === 'top_hook') {
        yPos = selectedLayout === 'vertical_blur' ? 'h*0.13' : 'h*0.09';
      }

      // Styling presets
      const style = captionStyle || 'kick_green';
      let styleParams = 'fontcolor=0x53FC18:borderw=5:bordercolor=black:shadowx=3:shadowy=3:shadowcolor=black@0.8';
      if (style === 'tiktok_white') {
        styleParams = 'fontcolor=white:borderw=5:bordercolor=black:shadowx=3:shadowy=3:shadowcolor=black@0.8';
      } else if (style === 'shorts_yellow') {
        styleParams = 'fontcolor=0xFFE600:borderw=5:bordercolor=black:shadowx=3:shadowy=3:shadowcolor=black@0.8';
      } else if (style === 'dark_box') {
        styleParams = 'fontcolor=white:box=1:boxcolor=black@0.75:boxborderw=18';
      } else if (style === 'fire_red') {
        styleParams = 'fontcolor=0xFF3B30:borderw=5:bordercolor=black:shadowx=3:shadowy=3:shadowcolor=black@0.8';
      }

      let drawtextFilter = `drawtext=textfile='${textFilePathEscaped}':fontsize=${fontSize}:line_spacing=16:x=${xPos}:y=${yPos}:${styleParams}`;
      if (fontFilePathEscaped) {
        drawtextFilter = `drawtext=fontfile='${fontFilePathEscaped}':textfile='${textFilePathEscaped}':fontsize=${fontSize}:line_spacing=16:x=${xPos}:y=${yPos}:${styleParams}`;
      }

      filterGraph += `,${drawtextFilter}`;
    }

    args.push('-filter_complex', filterGraph);
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22');
    args.push('-c:a', 'aac', '-b:a', '160k', '-ar', '44100');
    args.push('-movflags', '+faststart', '-y', outputPath);

    return new Promise((resolve, reject) => {
      let stderrOutput = '';
      const proc = spawn(ffmpegPath, args, { windowsHide: true });

      proc.stderr.on('data', chunk => {
        stderrOutput += chunk.toString();
      });

      proc.on('close', (code) => {
        if (tempCaptionFile && fs.existsSync(tempCaptionFile)) {
          try { fs.unlinkSync(tempCaptionFile); } catch (_) {}
        }

        if (code === 0 && fs.existsSync(outputPath)) {
          const stats = fs.statSync(outputPath);
          const clipRecord = {
            id: clipId,
            title: cleanTitle,
            fileName: outputFilename,
            filePath: outputPath,
            fileSizeBytes: stats.size,
            durationSeconds: clipDuration || Math.round(endSec - startSec),
            layout: selectedLayout,
            captionText: rawCaption || null,
            captionFont: captionFont || 'segoe',
            captionStyle: captionStyle || 'kick_green',
            captionPosition: captionPosition || 'top_hook',
            previewUrl: `/api/clips/preview/${outputFilename}`,
            downloadUrl: `/api/clips/download/${outputFilename}`,
            createdAt: new Date().toISOString()
          };

          this.clips.unshift(clipRecord);
          this.save();
          resolve(clipRecord);
        } else {
          reject(new Error(`FFmpeg clipping failed with exit code ${code}. Error: ${stderrOutput.slice(-300)}`));
        }
      });

      proc.on('error', err => {
        if (tempCaptionFile && fs.existsSync(tempCaptionFile)) {
          try { fs.unlinkSync(tempCaptionFile); } catch (_) {}
        }
        reject(err);
      });
    });
  }

  timeToSeconds(timeStr) {
    return timeToSeconds(timeStr);
  }

  deleteClip(id) {
    const clip = this.clips.find(c => c.id === id);
    if (clip && clip.filePath) {
      const target = path.resolve(clip.filePath);
      const dirWithSep = CLIPS_DIR.endsWith(path.sep) ? CLIPS_DIR : CLIPS_DIR + path.sep;
      if (target.startsWith(dirWithSep) && fs.existsSync(target) && fs.statSync(target).isFile()) {
        try { fs.unlinkSync(target); } catch (_) {}
      }
    }
    this.clips = this.clips.filter(c => c.id !== id);
    this.save();
    return true;
  }
}

module.exports = new ClipManager();
