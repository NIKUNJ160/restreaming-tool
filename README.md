# Kick Broadcast Studio — Livestream Restreaming Platform

A high-performance, modern web application that allows creators to paste an authorized livestream URL (HLS, DASH, RTMP, RTSP, or direct media streams) and rebroadcast it directly to their **Kick.com** channel using an isolated FFmpeg media engine.

---

## Key Features

1. **Kick.com Exclusive Output**:
   - Zero unnecessary third-party destination clutter.
   - Built specifically for Kick's RTMP ingest infrastructure (`rtmps://fa723fc1b171.global-contribute.live-video.net/app/`).
   - Secure Kick account manager with **AES-256-GCM** encryption for stream keys.
   - Stream keys are decrypted in-memory only during worker execution and never exposed in browser payloads or server logs.

2. **Broadcasting Control Room**:
   - **Source Monitor**: Real-time client-side preview player powered by HLS.js.
   - **Live Telemetry HUD**: Real-time output bitrate gauge, framerate counter, resolution target, network health indicator, and uptime timer.
   - **FFmpeg Engine Terminal**: Real-time stdout/stderr stream console with autoscroll and filter capabilities.
   - **SSRF & DNS Rebinding Protection**: Blocks loopback (`127.0.0.0/8`), private networks (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), and cloud metadata IP ranges (`169.254.169.254`).
   - **Mandatory Ownership Confirmation Gate**: Enforces legal authorization/ownership check before broadcast launch.

3. **Streaming Engine & Quality Presets**:
   - **Livestream & Downloaded Video Broadcasting**: Restream external live URLs OR broadcast downloaded MP4 videos and OpenShorts clips directly to Kick.
   - **Continuous Looping (24/7 Restreaming)**: Automatically loop downloaded videos continuously for 24/7 channels on Kick.
   - **Direct Stream Copy (`-c copy`)**: Bit-for-bit stream pass-through for compatible H.264 + AAC feeds (0% transcoding CPU load).
   - **Hardware/Software Transcoding**:
     - `1080p60` (6000 kbps x264, 160k AAC)
     - `720p60` (4500 kbps x264, 128k AAC)
     - `720p30` (3000 kbps x264, 128k AAC)
     - `480p30` (1500 kbps x264, 96k AAC)
   - **Automatic Reconnection**: Recovers from transient network drops with automatic retry backoff.
   - **Graceful Termination**: Intercepts stop commands to cleanly close FLV containers and disconnect cleanly from Kick.

4. **Automated Scheduler**:
   - Schedule future broadcasts with exact start and stop timestamps.
   - Automatic execution daemon that checks and triggers broadcasts.

5. **Stream Recording & Video Downloader**:
   - **Download Video from URL**: Dedicated interface to download/capture video directly from any HLS (`.m3u8`), direct MP4, RTMP, or YouTube URL to an MP4 file on the server.
   - **Configurable Capture Duration**: Capture full streams or timed clips (60s, 5m, 15m, 30m, 1hr).
   - **Live Capture Telemetry**: Real-time progress monitor with downloaded megabytes, duration, and speed.
   - **Saved Videos Manager**: Download MP4 files directly to your device or delete old recordings.

6. **OpenShorts-Inspired Shorts & Video Clipper**:
   - **Modern Font Captions & Hook Overlay**: Burn bold viral headlines and captions onto clips with customizable typography (Segoe UI Bold, Impact, Arial Bold, Trebuchet MS Bold).
   - **Styling & Color Presets**: Neon Kick Green glow, TikTok crisp white with black stroke, YouTube Shorts vibrant yellow, urgent fire red, or translucent charcoal badge.
   - **Flexible Caption Positioning**: Top hook banner (above video in 9:16 vertical blur format), bottom subtitles, or center punchlines with customizable font sizing (38px - 64px).
   - **Vertical Reframing Engine**: Transform standard 16:9 videos into viral 9:16 vertical shorts.
   - **Intelligent Background Blur**: Preserves full 16:9 aspect ratio in the center while dynamically generating a blurred, scaled background filling the 9:16 frame.
   - **Center Crop & Square Layouts**: Support for 9:16 full-bleed crop and 1:1 square formats for Instagram/TikTok/Twitter.
   - **Interactive Scrubber & Time Sync**: Scrub video directly in the browser and one-click set start/end timestamps.
   - **Flexible Source Ingestion**: Upload videos directly (drag & drop up to 2GB) or pick from downloaded stream feeds.
   - **Clips Gallery**: Stream/preview generated clips in-browser, download MP4s, or manage clips.

7. **Dashboard & History**:
   - Total streaming hours, total broadcasts, bandwidth usage, and active session KPIs.
   - Detailed historical audit trail of previous restream sessions.

---

## Architecture & Technology Stack

- **Frontend**: Next.js / Broadcast Studio SPA, Tailwind-inspired professional dark layout, HLS.js, WebSocket telemetry client.
- **Backend**: Node.js, Express, WebSocket server (`ws`), Prisma ORM schema.
- **Queue & Workers**: BullMQ, Redis, isolated child process workers.
- **Media Engine**: FFmpeg (bundled via `ffmpeg-static` for zero-friction setup, supports system FFmpeg).
- **Security**: Node.js Crypto (AES-256-GCM), SSRF DNS verification.

---

## Quick Start (Local Run)

### 1. Prerequisites
- **Node.js**: v18+ installed.
- **Redis** (optional): If running locally on port 6379, BullMQ queue is automatically activated; otherwise, the in-memory isolated worker queue runs seamlessly.

### 2. Install & Start
```bash
# Install dependencies
npm install

# Start the broadcast platform
npm start
```

Open your browser at **[http://localhost:3000](http://localhost:3000)**.

---

## Docker Deployment (PostgreSQL + Redis + App)

Deploy the complete multi-container production stack with one command:

```bash
docker compose up -d
```

Services started:
- `app`: Kick Restream Studio (Port 3000)
- `postgres`: PostgreSQL database (Port 5432)
- `redis`: Redis cache & queue (Port 6379)

---

## API Reference

### Broadcast Controls
- `POST /api/stream/validate`: Validates SSRF safety, probes video/audio codecs, resolution, and copy compatibility.
- `POST /api/stream/start`: Starts a restream session (requires `ownershipConfirmed: true`).
- `POST /api/stream/stop`: Stops the active restream gracefully.
- `GET /api/stream/active`: Returns live session state and real-time telemetry.
- `GET /api/stream/history`: Returns previous broadcast sessions.

### Kick Account Management
- `GET /api/kick/status`: Returns connected accounts and Kick RTMP ingest status.
- `POST /api/kick/connect`: Encrypts and saves Kick channel username and stream key.
- `DELETE /api/kick/account/:id`: Disconnects a Kick account.

### Telemetry & Logs
- `WS /ws/telemetry`: WebSocket endpoint streaming real-time bitrates, FPS, network health, and FFmpeg logs.
- `GET /api/logs/stream`: Server-Sent Events (SSE) fallback feed for logs.

### Scheduler
- `GET /api/schedule`: Retrieves pending and past scheduled streams.
- `POST /api/schedule`: Creates a scheduled broadcast.
- `DELETE /api/schedule/:id`: Cancels a scheduled broadcast.

### Video Downloader from URL
- `POST /api/download/start`: Starts capturing video from an HLS, RTMP, direct MP4, or YouTube URL.
- `POST /api/download/stop`: Stops an active video capture.
- `GET /api/download/active`: Returns running download tasks with progress telemetry.
- `GET /api/download/files`: Lists completed MP4 download files.
- `GET /api/download/file/:filename`: Downloads a saved video file to the browser.
- `DELETE /api/download/file/:filename`: Deletes a downloaded video file.

### OpenShorts Video Clipper
- `POST /api/clips/upload`: Uploads a video file (up to 2GB) and returns probed metadata.
- `POST /api/clips/create`: Cuts and reframes a video into 9:16 vertical blur, 9:16 crop, 1:1, or 16:9.
- `GET /api/clips`: Lists generated clips.
- `GET /api/clips/preview/:filename`: Streams a clip for in-browser video playback.
- `GET /api/clips/download/:filename`: Downloads a clip MP4 file.
- `DELETE /api/clips/:id`: Deletes a generated clip and its file.
