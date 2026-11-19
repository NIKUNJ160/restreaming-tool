FROM node:20-alpine

# Install FFmpeg and required media libraries
RUN apk add --no-cache ffmpeg python3 py3-pip dumb-init

# Optional: Install yt-dlp inside container for stream resolution
RUN wget https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -O /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app

# Copy dependency definitions
COPY package*.json ./
RUN npm ci --only=production

# Copy application code
COPY . .

# Ensure storage directories exist
RUN mkdir -p /app/recordings /app/data

EXPOSE 3000

ENV PORT=3000
ENV NODE_ENV=production
ENV FFMPEG_PATH=ffmpeg

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "src/server.js"]
