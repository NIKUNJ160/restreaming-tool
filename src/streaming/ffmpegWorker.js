const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const probeService = require('./probeService');
const { getFfmpegProtocolWhitelist } = require('../security/ssrfValidator');

class FFmpegWorker extends EventEmitter {
  constructor(sessionId, options) {
    super();
    this.sessionId = sessionId;
    this.sourceUrl = options.sourceUrl;
    this.destinationUrl = options.destinationUrl; // with decrypted key
    this.maskedDestination = options.maskedDestination;
    this.qualityPreset = options.qualityPreset || 'source';
    this.recordEnabled = !!options.recordEnabled;
    this.isLocalFile = !!options.isLocalFile;
    this.loopVideo = !!options.loopVideo;
    this.customBitrate = options.customBitrate;
    this.customResolution = options.customResolution;

    this.ffmpegPath = this.resolveBinary();
    this.process = null;
    this.status = 'IDLE'; // IDLE | STARTING | LIVE | STOPPING | ERROR | COMPLETED
    this.startedAt = null;
    this.metrics = {
      fps: 0,
      bitrateKbps: 0,
      frames: 0,
      speed: '0x',
      uptimeSeconds: 0,
      networkHealth: 'GOOD', // GOOD | FAIR | POOR
      resolution: options.customResolution || 'Source',
      totalBytes: 0
    };
    this.logs = [];
    this.maxLogs = 400;
    this.retryCount = 0;
    this.maxRetries = 3;
    this.manualStop = false;
    this.recordingPath = null;
  }

  resolveBinary() {
    if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
    try {
      const staticFfmpeg = require('ffmpeg-static');
      if (staticFfmpeg && fs.existsSync(staticFfmpeg)) return staticFfmpeg;
    } catch (_) {}
    return 'ffmpeg';
  }

  addLog(rawText) {
    if (!rawText) return;
    const lines = rawText.toString().split(/\r?\n/).filter(line => line.trim().length > 0);
    for (const line of lines) {
      const timestamp = new Date().toISOString().substring(11, 19);
      const entry = `[${timestamp}] ${line}`;
      this.logs.push(entry);
      if (this.logs.length > this.maxLogs) {
        this.logs.shift();
      }
      this.emit('log', { sessionId: this.sessionId, line: entry });
    }
  }

  buildArguments(resolvedUrls, probeInfo) {
    const isMultiInput = resolvedUrls.length > 1;
    const args = [];

    // Protocol whitelisting prevents malicious HLS/DASH sub-requests (e.g. file:// or internal protocols)
    const whitelist = getFfmpegProtocolWhitelist(this.isLocalFile);
    args.push('-protocol_whitelist', whitelist);

    // Continuous loop option for local video files (e.g. 24/7 restream)
    if (this.isLocalFile && this.loopVideo) {
      this.addLog('[ENCODER] Continuous looping enabled for local video playback.');
      args.push('-stream_loop', '-1');
    }

    // Add inputs
    if (isMultiInput) {
      args.push('-re', '-i', resolvedUrls[0]); // video track
      args.push('-re', '-i', resolvedUrls[1]); // audio track
    } else {
      args.push('-re', '-i', resolvedUrls[0]);
    }

    // Determine encoding strategy
    const shouldTranscode = this.qualityPreset !== 'source' || !probeInfo.isCopyCompatible || isMultiInput;

    if (!shouldTranscode) {
      this.addLog('[ENCODER] Using Direct Stream Copy (-c copy) - zero CPU re-encoding.');
      args.push('-c', 'copy');
    } else {
      this.addLog(`[ENCODER] Transcoding enabled: Preset "${this.qualityPreset}" with x264.`);

      // Video encoding parameters based on quality preset
      args.push('-c:v', 'libx264', '-preset', 'veryfast', '-g', '60', '-keyint_min', '30', '-sc_threshold', '0');

      switch (this.qualityPreset) {
        case '1080p60':
          args.push('-s', '1920x1080', '-r', '60', '-b:v', '6000k', '-maxrate', '6500k', '-bufsize', '12000k');
          this.metrics.resolution = '1920x1080';
          break;
        case '720p60':
          args.push('-s', '1280x720', '-r', '60', '-b:v', '4500k', '-maxrate', '5000k', '-bufsize', '9000k');
          this.metrics.resolution = '1280x720';
          break;
        case '720p30':
          args.push('-s', '1280x720', '-r', '30', '-b:v', '3000k', '-maxrate', '3500k', '-bufsize', '6000k');
          this.metrics.resolution = '1280x720';
          break;
        case '480p30':
          args.push('-s', '854x480', '-r', '30', '-b:v', '1500k', '-maxrate', '1800k', '-bufsize', '3000k');
          this.metrics.resolution = '854x480';
          break;
        default:
          // Transcode to standard high-profile preserving resolution
          args.push('-b:v', '4500k', '-maxrate', '5000k', '-bufsize', '9000k');
          if (probeInfo.resolution && probeInfo.resolution !== 'unknown') {
            this.metrics.resolution = probeInfo.resolution;
          }
          break;
      }

      // Audio encoding
      args.push('-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-ac', '2');
    }

    // Kick RTMP FLV output options
    args.push('-f', 'flv', '-flvflags', 'no_duration_filesize', this.destinationUrl);

    return args;
  }

  async start() {
    this.status = 'STARTING';
    this.emit('status', { status: this.status });
    this.addLog(`[INIT] Initializing broadcast session: ${this.sessionId}`);
    this.addLog(`[DEST] Target RTMP: ${this.maskedDestination}`);

    let probeInfo;
    let resolvedUrls;
    try {
      this.addLog('[PROBE] Inspecting source stream codecs and headers...');
      probeInfo = await probeService.probeStream(this.sourceUrl);
      resolvedUrls = probeInfo.resolvedUrls;
      this.addLog(`[PROBE] Source codec: Video=${probeInfo.videoCodec}, Audio=${probeInfo.audioCodec}, Res=${probeInfo.resolution}, FPS=${probeInfo.fps}`);
    } catch (err) {
      this.addLog(`[ERROR] Stream probe failed: ${err.message}`);
      this.status = 'ERROR';
      this.emit('status', { status: this.status, error: err.message });
      throw err;
    }

    const args = this.buildArguments(resolvedUrls, probeInfo);

    try {
      this.process = spawn(this.ffmpegPath, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      });
    } catch (err) {
      const msg = `Failed to spawn FFmpeg process: ${err.message}`;
      this.addLog(`[FATAL] ${msg}`);
      this.status = 'ERROR';
      this.emit('status', { status: this.status, error: msg });
      throw err;
    }

    const proc = this.process;

    proc.stdout.on('data', chunk => this.addLog(chunk.toString()));

    proc.stderr.on('data', chunk => {
      const text = chunk.toString();
      this.parseProgress(text);
      this.addLog(text);

      if (this.status === 'STARTING') {
        if (/frame=\s*\d+|bitrate=\s*[\d.]+|Output #0, flv/i.test(text)) {
          this.status = 'LIVE';
          this.startedAt = Date.now();
          this.addLog('[BROADCAST] Status is now LIVE. Packets transmitting to Kick.');
          this.emit('status', { status: this.status });
        }
      }
    });

    proc.on('close', (code, signal) => {
      this.addLog(`[EXIT] FFmpeg closed with code ${code} (signal: ${signal || 'none'})`);
      if (this.manualStop) {
        this.status = 'COMPLETED';
        this.addLog('[STOP] Session terminated gracefully by user.');
        this.emit('status', { status: this.status });
        this.emit('completed', { recordingPath: this.recordingPath });
      } else if (code === 0) {
        this.status = 'COMPLETED';
        this.addLog('[END] Source stream completed.');
        this.emit('status', { status: this.status });
        this.emit('completed', { recordingPath: this.recordingPath });
      } else {
        // Handle unexpected disconnect & auto-recovery
        if (this.retryCount < this.maxRetries) {
          this.retryCount++;
          this.addLog(`[RECONNECT] Connection lost. Automatic reconnection attempt ${this.retryCount}/${this.maxRetries} in 3 seconds...`);
          setTimeout(() => {
            if (!this.manualStop) {
              this.start().catch(() => {});
            }
          }, 3000);
        } else {
          this.status = 'ERROR';
          const errMsg = `Streaming ended unexpectedly with exit code ${code}. Maximum retry limit reached.`;
          this.addLog(`[ERROR] ${errMsg}`);
          this.emit('status', { status: this.status, error: errMsg });
        }
      }
      this.process = null;
    });

    proc.on('error', err => {
      this.addLog(`[ERROR] Child process error: ${err.message}`);
      this.status = 'ERROR';
      this.emit('status', { status: this.status, error: err.message });
    });

    return { sessionId: this.sessionId, status: this.status };
  }

  parseProgress(text) {
    // Matches e.g. frame=  123 fps= 30 q=28.0 size=   1024kB time=00:00:05.12 bitrate=1638.4kbits/s speed=1.02x
    const frameMatch = text.match(/frame=\s*(\d+)/);
    const fpsMatch = text.match(/fps=\s*([\d.]+)/);
    const bitrateMatch = text.match(/bitrate=\s*([\d.]+)\s*kbits/i);
    const speedMatch = text.match(/speed=\s*([\d.]+)x/);

    if (frameMatch) this.metrics.frames = parseInt(frameMatch[1], 10);
    if (fpsMatch) this.metrics.fps = parseFloat(fpsMatch[1]);
    if (bitrateMatch) this.metrics.bitrateKbps = Math.round(parseFloat(bitrateMatch[1]));
    if (speedMatch) {
      this.metrics.speed = `${speedMatch[1]}x`;
      const spd = parseFloat(speedMatch[1]);
      if (spd >= 0.95) this.metrics.networkHealth = 'GOOD';
      else if (spd >= 0.8) this.metrics.networkHealth = 'FAIR';
      else this.metrics.networkHealth = 'POOR';
    }

    if (this.startedAt) {
      this.metrics.uptimeSeconds = Math.floor((Date.now() - this.startedAt) / 1000);
    }

    this.emit('telemetry', {
      sessionId: this.sessionId,
      status: this.status,
      metrics: this.metrics
    });
  }

  async stop() {
    this.manualStop = true;
    this.status = 'STOPPING';
    this.emit('status', { status: this.status });
    this.addLog('[INFO] Graceful shutdown initiated...');

    if (!this.process) {
      this.status = 'COMPLETED';
      return { success: true };
    }

    const proc = this.process;

    return new Promise(resolve => {
      let resolved = false;
      const finish = () => {
        if (!resolved) {
          resolved = true;
          this.process = null;
          this.status = 'COMPLETED';
          resolve({ success: true });
        }
      };

      try {
        if (proc.stdin && proc.stdin.writable) {
          proc.stdin.write('q\n');
        }
      } catch (_) {}

      const forceTimer = setTimeout(() => {
        try {
          if (process.platform === 'win32') {
            spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F']);
          } else {
            proc.kill('SIGKILL');
          }
        } catch (_) {
          try { proc.kill(); } catch (__) {}
        }
        finish();
      }, 3500);

      proc.once('close', () => {
        clearTimeout(forceTimer);
        finish();
      });
    });
  }

  getState() {
    return {
      sessionId: this.sessionId,
      status: this.status,
      sourceUrl: this.sourceUrl,
      maskedDestination: this.maskedDestination,
      qualityPreset: this.qualityPreset,
      recordEnabled: this.recordEnabled,
      metrics: this.metrics,
      logs: this.logs.slice(-50)
    };
  }
}

module.exports = FFmpegWorker;
