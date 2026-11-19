const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { getFfmpegProtocolWhitelist } = require('../security/ssrfValidator');

class ProbeService {
  constructor() {
    this.ffmpegPath = this.resolveBinary();
  }

  resolveBinary() {
    if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
    try {
      const staticFfmpeg = require('ffmpeg-static');
      if (staticFfmpeg && fs.existsSync(staticFfmpeg)) return staticFfmpeg;
    } catch (_) {}
    return 'ffmpeg';
  }

  /**
   * Resolves raw source URL to direct streaming URLs (handling YouTube if detected).
   */
  async resolveSourceUrls(sourceUrl) {
    if (fs.existsSync(sourceUrl)) {
      return { isYouTube: false, streamUrls: [sourceUrl], isLocal: true };
    }
    const isYouTube = /youtube\.com|youtu\.be/i.test(sourceUrl);
    if (!isYouTube) {
      return { isYouTube: false, streamUrls: [sourceUrl] };
    }

    return new Promise((resolve, reject) => {
      execFile('yt-dlp', ['--js-runtimes', 'node', '-g', '--', sourceUrl], { timeout: 25000 }, (err, stdout, stderr) => {
        if (err) {
          const msg = (stderr || err.message || '').trim();
          return reject(new Error(`YouTube stream extraction failed: ${msg}. Stream may be offline or restricted.`));
        }
        const urls = stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        if (urls.length === 0) {
          return reject(new Error('No live media stream could be extracted from this YouTube URL.'));
        }
        resolve({ isYouTube: true, streamUrls: urls });
      });
    });
  }

  /**
   * Probes the stream using FFmpeg to gather metadata (codecs, resolution, fps).
   */
  async probeStream(targetUrl) {
    const resolved = await this.resolveSourceUrls(targetUrl);
    const probeUrl = resolved.streamUrls[0];

    return new Promise((resolve) => {
      const whitelist = getFfmpegProtocolWhitelist(resolved.isLocal);
      // Run ffmpeg with protocol whitelist and -i to inspect stream headers
      const args = ['-hide_banner', '-protocol_whitelist', whitelist, '-i', probeUrl, '-t', '1', '-f', 'null', '-'];
      let stderrOutput = '';

      const proc = spawn(this.ffmpegPath, args, { windowsHide: true });

      const timer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch (_) {}
      }, 8000);

      proc.stderr.on('data', chunk => {
        stderrOutput += chunk.toString();
      });

      proc.on('close', () => {
        clearTimeout(timer);

        // Parse stream information
        // e.g.: Stream #0:0: Video: h264 (High), yuv420p(tv, bt709), 1920x1080 [SAR 1:1 DAR 16:9], 30 fps
        // e.g.: Stream #0:1: Audio: aac (LC), 44100 Hz, stereo, fltp, 128 kb/s
        let videoCodec = 'unknown';
        let audioCodec = 'unknown';
        let resolution = 'unknown';
        let fps = 30;

        const videoMatch = stderrOutput.match(/Video:\s*([a-zA-Z0-9_\-]+)/i);
        if (videoMatch) videoCodec = videoMatch[1].toLowerCase();

        const audioMatch = stderrOutput.match(/Audio:\s*([a-zA-Z0-9_\-]+)/i);
        if (audioMatch) audioCodec = audioMatch[1].toLowerCase();

        const resMatch = stderrOutput.match(/(\d{3,4}x\d{3,4})/);
        if (resMatch) resolution = resMatch[1];

        const fpsMatch = stderrOutput.match(/([\d.]+)\s*fps/i);
        if (fpsMatch) fps = parseFloat(fpsMatch[1]);

        // Kick RTMP FLV requires H.264 video and AAC audio for stream copying
        const isVideoCopyCompatible = /h264|avc|flv1/i.test(videoCodec);
        const isAudioCopyCompatible = /aac|mp3/i.test(audioCodec);
        const isCopyCompatible = isVideoCopyCompatible && isAudioCopyCompatible && !resolved.isYouTube;

        resolve({
          success: videoCodec !== 'unknown' || audioCodec !== 'unknown',
          isYouTube: resolved.isYouTube,
          videoCodec,
          audioCodec,
          resolution,
          fps,
          isCopyCompatible,
          recommendation: isCopyCompatible
            ? 'Stream copy compatible (zero CPU re-encoding overhead).'
            : 'Transcoding recommended (incompatible container/codec for direct Kick FLV copy).',
          resolvedUrls: resolved.streamUrls
        });
      });
    });
  }
}

module.exports = new ProbeService();
