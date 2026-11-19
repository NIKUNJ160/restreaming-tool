const dns = require('dns').promises;
const { URL } = require('url');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const ALLOWED_MEDIA_DIRS = {
  downloads: path.resolve(__dirname, '..', '..', 'downloads'),
  uploads: path.resolve(__dirname, '..', '..', 'uploads'),
  clips: path.resolve(__dirname, '..', '..', 'clips')
};

// Ensure directories exist
for (const dir of Object.values(ALLOWED_MEDIA_DIRS)) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

const ALLOWED_VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.mkv', '.flv', '.avi']);

/**
 * Returns safe FFmpeg protocol whitelist string.
 * For local files: restricts strictly to file and crypto.
 * For network streams: restricts to safe web and streaming protocols, prohibiting file:// sub-requests.
 */
function getFfmpegProtocolWhitelist(isLocalFile = false) {
  if (isLocalFile) {
    return 'file,crypto';
  }
  return 'http,https,tcp,tls,crypto,rtmp,rtmps';
}

/**
 * Safely validates a local video file inside downloads, uploads, or clips directories.
 * Strictly prevents path traversal attacks, directory traversal ('..', '.'), and non-video files.
 */
function validateLocalVideoFile(rawNameOrPath) {
  if (!rawNameOrPath || typeof rawNameOrPath !== 'string') {
    return { valid: false, error: 'Video file name is required.' };
  }

  // Strip prefixes like "download:", "local:", "clip:", "file:"
  let clean = rawNameOrPath.replace(/^(download|local|clip|file):\/\/?/i, '').trim();

  // Extract base filename to disallow arbitrary paths
  const baseName = path.basename(clean);
  if (!baseName || baseName === '.' || baseName === '..') {
    return { valid: false, error: 'Invalid file name.' };
  }

  // Check extension against video allowlist
  const ext = path.extname(baseName).toLowerCase();
  if (ext && !ALLOWED_VIDEO_EXTS.has(ext)) {
    return { valid: false, error: `Invalid video file extension "${ext}". Allowed: ${Array.from(ALLOWED_VIDEO_EXTS).join(', ')}` };
  }

  // Check against all authorized media directories
  for (const [category, dir] of Object.entries(ALLOWED_MEDIA_DIRS)) {
    const fullPath = path.resolve(dir, baseName);
    const dirWithSep = dir.endsWith(path.sep) ? dir : dir + path.sep;

    // Verify path is strictly within the allowed directory and is a regular file
    if (fullPath.startsWith(dirWithSep) && fs.existsSync(fullPath)) {
      try {
        const stats = fs.statSync(fullPath);
        if (stats.isFile()) {
          return {
            valid: true,
            sanitizedUrl: fullPath,
            detectedType: 'LOCAL_VIDEO',
            isLocalFile: true,
            fileName: baseName,
            category
          };
        }
      } catch (_) {}
    }
  }

  return { valid: false, error: `Local video file "${baseName}" was not found in authorized media storage.` };
}

// Blocked IP ranges (RFC 1918, loopback, link-local, multicast, cloud metadata)
const PRIVATE_IP_REGEXES = [
  /^127\./,                         // Loopback (127.0.0.0/8)
  /^10\./,                          // Private class A (10.0.0.0/8)
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./, // Private class B (172.16.0.0/12)
  /^192\.168\./,                    // Private class C (192.168.0.0/16)
  /^169\.254\./,                    // Link-local / AWS/GCP metadata (169.254.0.0/16)
  /^0\./,                           // Zero address (0.0.0.0/8)
  /^::1$/,                          // IPv6 Loopback
  /^fe80:/i,                        // IPv6 Link-local
  /^fc00:/i,                        // IPv6 Unique local
  /^fd00:/i                         // IPv6 Unique local
];

/**
 * Checks if a hostname resolves to any private, loopback, or metadata IP.
 */
async function verifyHostSafety(hostname) {
  if (!hostname || typeof hostname !== 'string') return false;
  const cleanHost = hostname.toLowerCase().trim();
  if (cleanHost === 'localhost') return false;

  // Direct IP check
  for (const regex of PRIVATE_IP_REGEXES) {
    if (regex.test(cleanHost)) return false;
  }

  try {
    const addresses = await dns.lookup(cleanHost, { all: true });
    if (!addresses || addresses.length === 0) return false;
    for (const record of addresses) {
      const ip = record.address;
      for (const regex of PRIVATE_IP_REGEXES) {
        if (regex.test(ip)) return false;
      }
    }
    return true;
  } catch (dnsErr) {
    // If hostname cannot be resolved, reject it
    return false;
  }
}

/**
 * Performs a safe preflight HTTP/HTTPS request with redirect inspection to defend against
 * SSRF TOCTOU and redirect-based internal network probing.
 */
function verifyHttpPreflight(targetUrl, maxRedirects = 3) {
  return new Promise((resolve) => {
    let currentUrl = targetUrl;
    let redirectCount = 0;

    function step(urlStr) {
      let parsed;
      try {
        parsed = new URL(urlStr);
      } catch (_) {
        return resolve({ safe: false, error: 'Malformed URL in stream preflight.' });
      }

      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return resolve({ safe: false, error: 'Stream protocol must be http or https.' });
      }

      verifyHostSafety(parsed.hostname).then(isSafe => {
        if (!isSafe) {
          return resolve({ safe: false, error: 'Target host or redirect resolves to restricted internal network.' });
        }

        const client = parsed.protocol === 'https:' ? https : http;
        const req = client.request(
          urlStr,
          {
            method: 'HEAD',
            timeout: 5000,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) KickRestreamer/1.0' }
          },
          res => {
            if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
              redirectCount++;
              if (redirectCount > maxRedirects) {
                return resolve({ safe: false, error: 'Too many HTTP redirects.' });
              }
              const location = res.headers.location;
              if (!location) {
                return resolve({ safe: false, error: 'Redirect without Location header.' });
              }
              try {
                const nextUrl = new URL(location, urlStr).href;
                return step(nextUrl);
              } catch (_) {
                return resolve({ safe: false, error: 'Invalid redirect Location URL.' });
              }
            }
            resolve({ safe: true });
          }
        );

        req.on('timeout', () => {
          req.destroy();
          // Timeout on HEAD is acceptable (some servers ignore HEAD), host safety was verified
          resolve({ safe: true });
        });

        req.on('error', () => {
          // If HEAD fails due to method not allowed, host safety was verified
          resolve({ safe: true });
        });

        req.end();
      }).catch(() => resolve({ safe: false, error: 'Host safety verification failed.' }));
    }

    step(currentUrl);
  });
}

/**
 * Validates a stream URL for SSRF vulnerabilities, DNS rebinding, and format safety.
 * @param {string} rawUrl Input livestream URL
 * @returns {Promise<{ valid: boolean, sanitizedUrl: string, detectedType: string, error?: string }>}
 */
async function validateStreamUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return { valid: false, sanitizedUrl: '', detectedType: 'UNKNOWN', error: 'Livestream URL is required.' };
  }

  const trimmed = rawUrl.trim();

  // Local video file prefix
  if (/^(local|download|clip|file):/i.test(trimmed)) {
    return validateLocalVideoFile(trimmed);
  }

  // RTMP / RTSP URLs
  if (/^(rtmp|rtmps|rtsp|srt):\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed.replace(/^rtmps?:\/\//i, 'http://').replace(/^rtsp:\/\//i, 'http://'));
      const hostname = parsed.hostname;
      const isSafe = await verifyHostSafety(hostname);
      if (!isSafe) {
        return { valid: false, sanitizedUrl: trimmed, detectedType: 'RTMP', error: 'Access to private, loopback, or internal IP addresses is prohibited.' };
      }
      return { valid: true, sanitizedUrl: trimmed, detectedType: trimmed.startsWith('rtsp') ? 'RTSP' : 'RTMP' };
    } catch (e) {
      return { valid: false, sanitizedUrl: trimmed, detectedType: 'RTMP', error: 'Invalid streaming URL format.' };
    }
  }

  // HTTP / HTTPS URLs
  if (!/^https?:\/\//i.test(trimmed)) {
    return {
      valid: false,
      sanitizedUrl: trimmed,
      detectedType: 'UNKNOWN',
      error: 'URL must begin with http://, https://, rtmp://, rtmps://, or rtsp://'
    };
  }

  try {
    const parsed = new URL(trimmed);
    const hostname = parsed.hostname;

    // Check hostname safety
    const isSafe = await verifyHostSafety(hostname);
    if (!isSafe) {
      return {
        valid: false,
        sanitizedUrl: trimmed,
        detectedType: 'UNKNOWN',
        error: 'Target host resolves to a restricted internal or private network IP.'
      };
    }

    // SSRF TOCTOU / Redirect verification for HTTP(S) streams
    if (!/youtube\.com|youtu\.be/i.test(hostname)) {
      const preflight = await verifyHttpPreflight(trimmed);
      if (!preflight.safe) {
        return {
          valid: false,
          sanitizedUrl: trimmed,
          detectedType: 'UNKNOWN',
          error: preflight.error || 'Preflight stream safety check failed.'
        };
      }
    }

    // Detect format
    let detectedType = 'DIRECT';
    const pathLower = parsed.pathname.toLowerCase();
    if (pathLower.endsWith('.m3u8') || pathLower.includes('/hls/')) {
      detectedType = 'HLS';
    } else if (pathLower.endsWith('.mpd') || pathLower.includes('/dash/')) {
      detectedType = 'DASH';
    } else if (/youtube\.com|youtu\.be/i.test(hostname)) {
      detectedType = 'YOUTUBE';
    } else if (pathLower.endsWith('.flv')) {
      detectedType = 'FLV';
    }

    return {
      valid: true,
      sanitizedUrl: trimmed,
      detectedType
    };
  } catch (err) {
    return {
      valid: false,
      sanitizedUrl: trimmed,
      detectedType: 'UNKNOWN',
      error: `Invalid URL format: ${err.message}`
    };
  }
}

module.exports = {
  validateStreamUrl,
  validateLocalVideoFile,
  verifyHostSafety,
  getFfmpegProtocolWhitelist,
  ALLOWED_MEDIA_DIRS
};
