const { EventEmitter } = require('events');
const FFmpegWorker = require('../streaming/ffmpegWorker');
const db = require('../db/database');
const kickService = require('../kick/kickService');

class QueueService extends EventEmitter {
  constructor() {
    super();
    this.activeWorkers = new Map(); // sessionId -> FFmpegWorker
    this.redisAvailable = false;
    this.initBullMQ();
  }

  async initBullMQ() {
    let redis = null;
    try {
      const { Queue } = require('bullmq');
      const IORedis = require('ioredis');
      redis = new IORedis({
        host: process.env.REDIS_HOST || '127.0.0.1',
        port: parseInt(process.env.REDIS_PORT, 10) || 6379,
        maxRetriesPerRequest: null,
        connectTimeout: 2000,
        lazyConnect: true,
        retryStrategy: () => null
      });

      // Prevent unhandled error event crash on connection loss
      redis.on('error', () => {});

      await redis.connect();
      const info = await redis.info();
      const verMatch = info.match(/redis_version:([0-9.]+)/);
      const majorVer = verMatch ? parseInt(verMatch[1].split('.')[0], 10) : 0;

      if (majorVer >= 5) {
        this.queue = new Queue('restream-queue', { connection: redis });
        this.redisAvailable = true;
        console.log(`[REDIS] Redis v${verMatch[1]} verified. BullMQ distributed queue active.`);
      } else {
        this.redisAvailable = false;
        try { redis.disconnect(); } catch (_) {}
        console.log(`[QUEUE] Local Redis is v${verMatch ? verMatch[1] : 'unknown'} (< 5.0). Using isolated in-memory worker engine.`);
      }
    } catch (err) {
      if (redis) {
        try { redis.disconnect(); } catch (_) {}
      }
      this.redisAvailable = false;
      console.log(`[QUEUE] Running isolated streaming workers engine.`);
    }
  }

  getActiveSession() {
    for (const [_, worker] of this.activeWorkers) {
      if (worker.status === 'LIVE' || worker.status === 'STARTING') {
        return worker.getState();
      }
    }
    return null;
  }

  async startStream(params) {
    // 1. Check if an active session is already broadcasting
    const existing = this.getActiveSession();
    if (existing) {
      throw new Error(`Session "${existing.sessionId}" is currently live. Stop it before launching a new broadcast.`);
    }

    // 2. Resolve Kick Credentials
    let creds;
    if (params.customStreamKey) {
      // Direct stream key provided in form
      const rtmpBase = params.rtmpUrl || 'rtmps://fa723fc1b171.global-contribute.live-video.net/app/';
      const cleanBase = rtmpBase.endsWith('/') ? rtmpBase : rtmpBase + '/';
      const cleanKey = params.customStreamKey.trim();
      const { maskStreamKey } = require('../security/crypto');
      creds = {
        accountId: null,
        kickUsername: 'Manual Key',
        channelSlug: 'kick-live',
        rtmpBase: cleanBase,
        plainStreamKey: cleanKey,
        fullDestinationUrl: `${cleanBase}${cleanKey}`,
        maskedDestination: `${cleanBase}${maskStreamKey(cleanKey)}`
      };
    } else {
      creds = kickService.getBroadcastingCredentials(params.kickAccountId);
    }

    // 3. Create Session Record in Database
    const session = db.createStreamSession({
      kickAccountId: creds.accountId,
      title: params.title || `Restream @${creds.kickUsername}`,
      sourceUrl: params.sourceUrl,
      sourceFormat: params.sourceFormat || 'DIRECT',
      destinationUrl: creds.maskedDestination,
      qualityPreset: params.qualityPreset || 'source',
      recordEnabled: !!params.recordEnabled
    });

    // 4. Instantiate Isolated FFmpeg Worker
    const worker = new FFmpegWorker(session.id, {
      sourceUrl: params.sourceUrl,
      destinationUrl: creds.fullDestinationUrl,
      maskedDestination: creds.maskedDestination,
      qualityPreset: params.qualityPreset || 'source',
      recordEnabled: !!params.recordEnabled,
      isLocalFile: !!params.isLocalFile,
      loopVideo: !!params.loopVideo
    });

    this.activeWorkers.set(session.id, worker);

    // Forward worker events
    worker.on('status', evt => {
      db.updateStreamSession(session.id, { status: evt.status, errorMessage: evt.error || null });
      this.emit('session_update', { sessionId: session.id, status: evt.status, error: evt.error });
    });

    worker.on('telemetry', data => {
      db.updateStreamSession(session.id, {
        fps: data.metrics.fps,
        videoBitrate: data.metrics.bitrateKbps,
        resolution: data.metrics.resolution,
        durationSeconds: data.metrics.uptimeSeconds
      });
      this.emit('telemetry', data);
    });

    worker.on('log', logData => {
      this.emit('log', logData);
    });

    worker.on('completed', () => {
      db.updateStreamSession(session.id, {
        status: 'COMPLETED',
        endTime: new Date().toISOString()
      });
      this.activeWorkers.delete(session.id);
    });

    // 5. Start Worker
    await worker.start();
    return worker.getState();
  }

  async stopStream(sessionId) {
    let worker = null;
    if (sessionId) {
      worker = this.activeWorkers.get(sessionId);
    } else {
      for (const [_, w] of this.activeWorkers) {
        if (w.status === 'LIVE' || w.status === 'STARTING') {
          worker = w;
          break;
        }
      }
    }

    if (!worker) {
      return { success: false, message: 'No active stream to stop.' };
    }

    await worker.stop();
    return { success: true, message: `Stream session ${worker.sessionId} terminated.` };
  }
}

module.exports = new QueueService();
