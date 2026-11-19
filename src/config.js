require('dotenv').config();
const path = require('path');
const fs = require('fs');

// Ensure recordings directory exists
const RECORDINGS_DIR = path.resolve(process.env.RECORDINGS_DIR || path.join(__dirname, '..', 'recordings'));
if (!fs.existsSync(RECORDINGS_DIR)) {
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
}

// Master encryption key for stream keys (32 bytes hex or string)
const DEFAULT_FALLBACK_KEY = 'kick_restream_master_secret_key_32_bytes!';
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || DEFAULT_FALLBACK_KEY;

if (ENCRYPTION_KEY === DEFAULT_FALLBACK_KEY) {
  if (process.env.NODE_ENV === 'production') {
    console.error('\n[FATAL SECURITY ERROR] ENCRYPTION_KEY environment variable MUST be set in production!');
    process.exit(1);
  } else {
    console.warn('[SECURITY NOTICE] Running with development default ENCRYPTION_KEY. Set ENCRYPTION_KEY in .env for production.');
  }
}

module.exports = {
  PORT: parseInt(process.env.PORT, 10) || 3000,
  WS_PORT: parseInt(process.env.WS_PORT, 10) || 3001,
  DATABASE_URL: process.env.DATABASE_URL || 'file:./dev.db',
  REDIS_HOST: process.env.REDIS_HOST || '127.0.0.1',
  REDIS_PORT: parseInt(process.env.REDIS_PORT, 10) || 6379,
  REDIS_PASSWORD: process.env.REDIS_PASSWORD || undefined,
  FFMPEG_PATH: process.env.FFMPEG_PATH || null,
  DEFAULT_KICK_RTMP: process.env.KICK_RTMP_URL || 'rtmps://fa723fc1b171.global-contribute.live-video.net/app/',
  RECORDINGS_DIR,
  ENCRYPTION_KEY,
  KICK_CLIENT_ID: process.env.KICK_CLIENT_ID || '',
  KICK_CLIENT_SECRET: process.env.KICK_CLIENT_SECRET || '',
  KICK_REDIRECT_URI: process.env.KICK_REDIRECT_URI || 'http://localhost:3000/api/kick/callback'
};
