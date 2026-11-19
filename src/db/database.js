const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { encrypt, decrypt, maskStreamKey } = require('../security/crypto');

const DATA_DIR = path.resolve(__dirname, '..', '..', 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_FILE = path.join(DATA_DIR, 'platform_store.json');

class DatabaseService {
  constructor() {
    this.data = {
      users: [],
      kickAccounts: [],
      streamSessions: [],
      scheduledStreams: [],
      recordings: [],
      settings: {
        defaultRtmpUrl: 'rtmps://fa723fc1b171.global-contribute.live-video.net/app/',
        defaultQualityPreset: 'source',
        autoReconnect: true,
        maxRetries: 3
      }
    };
    this.load();
    this.initDefaultUser();
  }

  load() {
    try {
      if (fs.existsSync(DB_FILE)) {
        const raw = fs.readFileSync(DB_FILE, 'utf8');
        this.data = JSON.parse(raw);
      } else {
        this.save();
      }
    } catch (e) {
      console.error('Error loading database file, initializing fresh store:', e);
      this.save();
    }
  }

  save() {
    try {
      fs.writeFileSync(DB_FILE, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (e) {
      console.error('Error saving database file:', e);
    }
  }

  initDefaultUser() {
    if (this.data.users.length === 0) {
      this.data.users.push({
        id: 'usr_default_admin',
        username: 'streamer',
        email: 'creator@kick.com',
        createdAt: new Date().toISOString()
      });
      this.save();
    }
  }

  // --- KICK ACCOUNTS ---
  getKickAccounts(mask = true) {
    return this.data.kickAccounts.map(acc => {
      const copy = { ...acc };
      if (mask) {
        let plainKey = '';
        try {
          plainKey = decrypt(acc.streamKeyEnc, acc.streamKeyIv, acc.streamKeyTag);
        } catch (_) {}
        copy.maskedStreamKey = maskStreamKey(plainKey);
        delete copy.streamKeyEnc;
        delete copy.streamKeyIv;
        delete copy.streamKeyTag;
      }
      return copy;
    });
  }

  getKickAccountById(id, withSecret = false) {
    const acc = this.data.kickAccounts.find(a => a.id === id);
    if (!acc) return null;
    const copy = { ...acc };
    try {
      const plain = decrypt(acc.streamKeyEnc, acc.streamKeyIv, acc.streamKeyTag);
      copy.maskedStreamKey = maskStreamKey(plain);
      if (withSecret) {
        copy.plainStreamKey = plain;
      } else {
        delete copy.streamKeyEnc;
        delete copy.streamKeyIv;
        delete copy.streamKeyTag;
      }
    } catch (err) {
      copy.maskedStreamKey = '****';
      if (withSecret) copy.plainStreamKey = '';
    }
    return copy;
  }

  saveKickAccount({ kickUsername, channelSlug, streamKey, rtmpUrl }) {
    if (!kickUsername || !streamKey) {
      throw new Error('Kick username and Stream Key are required.');
    }

    const { cipherText, iv, tag } = encrypt(streamKey.trim());
    let normalizedRtmp = (rtmpUrl || 'rtmps://fa723fc1b171.global-contribute.live-video.net/app/').trim();
    if (!normalizedRtmp.endsWith('/')) normalizedRtmp += '/';

    const existingIdx = this.data.kickAccounts.findIndex(
      a => a.kickUsername.toLowerCase() === kickUsername.toLowerCase()
    );

    const accountRecord = {
      id: existingIdx >= 0 ? this.data.kickAccounts[existingIdx].id : 'kick_' + crypto.randomUUID().slice(0, 8),
      userId: 'usr_default_admin',
      kickUsername: kickUsername.trim(),
      channelSlug: (channelSlug || kickUsername).trim().toLowerCase(),
      streamKeyEnc: cipherText,
      streamKeyIv: iv,
      streamKeyTag: tag,
      rtmpUrl: normalizedRtmp,
      isVerified: true,
      avatarUrl: `https://avatar.vercel.sh/${encodeURIComponent(kickUsername)}.png`,
      createdAt: existingIdx >= 0 ? this.data.kickAccounts[existingIdx].createdAt : new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    if (existingIdx >= 0) {
      this.data.kickAccounts[existingIdx] = accountRecord;
    } else {
      this.data.kickAccounts.push(accountRecord);
    }

    this.save();
    return this.getKickAccountById(accountRecord.id, false);
  }

  deleteKickAccount(id) {
    this.data.kickAccounts = this.data.kickAccounts.filter(a => a.id !== id);
    this.save();
    return true;
  }

  // --- STREAM SESSIONS ---
  createStreamSession(params) {
    const session = {
      id: 'sess_' + crypto.randomUUID().slice(0, 8),
      userId: 'usr_default_admin',
      kickAccountId: params.kickAccountId || null,
      title: params.title || 'Live Restream',
      sourceUrl: params.sourceUrl,
      sourceFormat: params.sourceFormat || 'DIRECT',
      destinationUrl: params.destinationUrl, // masked
      status: 'STARTING',
      qualityPreset: params.qualityPreset || 'source',
      isTranscoding: params.isTranscoding || false,
      videoBitrate: params.videoBitrate || null,
      audioBitrate: params.audioBitrate || null,
      resolution: params.resolution || null,
      fps: params.fps || null,
      startTime: new Date().toISOString(),
      endTime: null,
      durationSeconds: 0,
      totalBytesSent: 0,
      errorMessage: null,
      exitCode: null,
      recordEnabled: !!params.recordEnabled,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    this.data.streamSessions.unshift(session);
    this.save();
    return session;
  }

  updateStreamSession(id, updates) {
    const session = this.data.streamSessions.find(s => s.id === id);
    if (!session) return null;
    Object.assign(session, updates, { updatedAt: new Date().toISOString() });
    this.save();
    return session;
  }

  getStreamSessions(limit = 20) {
    return this.data.streamSessions.slice(0, limit);
  }

  getStreamSessionById(id) {
    return this.data.streamSessions.find(s => s.id === id) || null;
  }

  // --- SCHEDULED STREAMS ---
  createScheduledStream(params) {
    const scheduled = {
      id: 'sched_' + crypto.randomUUID().slice(0, 8),
      userId: 'usr_default_admin',
      title: params.title || 'Scheduled Broadcast',
      sourceUrl: params.sourceUrl,
      qualityPreset: params.qualityPreset || 'source',
      scheduledStartTime: params.scheduledStartTime,
      scheduledStopTime: params.scheduledStopTime || null,
      autoStart: params.autoStart !== undefined ? params.autoStart : true,
      retryOnFail: params.retryOnFail !== undefined ? params.retryOnFail : true,
      maxRetries: params.maxRetries || 3,
      status: 'PENDING',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    this.data.scheduledStreams.unshift(scheduled);
    this.save();
    return scheduled;
  }

  getScheduledStreams() {
    return this.data.scheduledStreams;
  }

  updateScheduledStream(id, updates) {
    const sched = this.data.scheduledStreams.find(s => s.id === id);
    if (!sched) return null;
    Object.assign(sched, updates, { updatedAt: new Date().toISOString() });
    this.save();
    return sched;
  }

  deleteScheduledStream(id) {
    this.data.scheduledStreams = this.data.scheduledStreams.filter(s => s.id !== id);
    this.save();
    return true;
  }

  // --- RECORDINGS ---
  createRecording(params) {
    const rec = {
      id: 'rec_' + crypto.randomUUID().slice(0, 8),
      streamSessionId: params.streamSessionId,
      fileName: params.fileName,
      filePath: params.filePath,
      fileSizeBytes: params.fileSizeBytes || 0,
      durationSeconds: params.durationSeconds || 0,
      downloadUrl: `/api/recordings/download/${params.fileName}`,
      status: params.status || 'RECORDING',
      createdAt: new Date().toISOString()
    };
    this.data.recordings.unshift(rec);
    this.save();
    return rec;
  }

  updateRecording(id, updates) {
    const rec = this.data.recordings.find(r => r.id === id);
    if (!rec) return null;
    Object.assign(rec, updates);
    this.save();
    return rec;
  }

  getRecordings() {
    return this.data.recordings;
  }

  deleteRecording(id) {
    const rec = this.data.recordings.find(r => r.id === id);
    if (rec && fs.existsSync(rec.filePath)) {
      try { fs.unlinkSync(rec.filePath); } catch (_) {}
    }
    this.data.recordings = this.data.recordings.filter(r => r.id !== id);
    this.save();
    return true;
  }

  // --- DASHBOARD ANALYTICS ---
  getDashboardMetrics() {
    const sessions = this.data.streamSessions;
    const totalBroadcasts = sessions.length;
    
    // Sum duration
    const totalDurationSeconds = sessions.reduce((acc, s) => acc + (s.durationSeconds || 0), 0);
    const totalHours = (totalDurationSeconds / 3600).toFixed(1);

    // Active sessions
    const activeSessions = sessions.filter(s => s.status === 'LIVE' || s.status === 'STARTING');
    
    // Last broadcast
    const lastBroadcast = sessions.length > 0 ? sessions[0] : null;

    // Kick accounts
    const kickConnected = this.data.kickAccounts.length > 0;
    const primaryKick = kickConnected ? this.data.kickAccounts[0].kickUsername : null;

    // Total bandwidth estimation
    const totalMB = sessions.reduce((acc, s) => {
      // estimate from bitrate * duration if totalBytesSent not recorded
      const dur = s.durationSeconds || 0;
      const bit = s.videoBitrate || 4500;
      const mb = (dur * bit * 1000) / (8 * 1024 * 1024);
      return acc + mb;
    }, 0);

    return {
      totalBroadcasts,
      totalStreamingHours: parseFloat(totalHours),
      activeCount: activeSessions.length,
      currentLiveSession: activeSessions.length > 0 ? activeSessions[0] : null,
      lastBroadcast,
      kickConnected,
      primaryKick,
      totalBandwidthGB: (totalMB / 1024).toFixed(2),
      scheduledCount: this.data.scheduledStreams.filter(s => s.status === 'PENDING').length
    };
  }
}

module.exports = new DatabaseService();
