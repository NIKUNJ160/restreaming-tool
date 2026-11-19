const db = require('../db/database');
const queueService = require('./queueService');

class StreamScheduler {
  constructor() {
    this.timer = null;
    this.startCron();
  }

  startCron() {
    // Check every 15 seconds for pending scheduled streams ready to start
    this.timer = setInterval(() => this.checkSchedule(), 15000);
  }

  async checkSchedule() {
    const now = new Date();
    const scheduled = db.getScheduledStreams();

    for (const item of scheduled) {
      if (item.status === 'PENDING' && item.autoStart) {
        const startTime = new Date(item.scheduledStartTime);
        if (now >= startTime) {
          console.log(`[SCHEDULER] Triggering scheduled broadcast "${item.title}" (${item.id})`);
          db.updateScheduledStream(item.id, { status: 'ACTIVE' });

          try {
            await queueService.startStream({
              title: item.title,
              sourceUrl: item.sourceUrl,
              qualityPreset: item.qualityPreset
            });
            db.updateScheduledStream(item.id, { status: 'COMPLETED' });
          } catch (err) {
            console.error(`[SCHEDULER] Scheduled stream failed:`, err.message);
            db.updateScheduledStream(item.id, { status: 'FAILED' });
          }
        }
      }

      // Check if active scheduled stream has reached stop time
      if (item.status === 'ACTIVE' && item.scheduledStopTime) {
        const stopTime = new Date(item.scheduledStopTime);
        if (now >= stopTime) {
          console.log(`[SCHEDULER] Stopping scheduled stream "${item.title}" per stop-time`);
          await queueService.stopStream();
          db.updateScheduledStream(item.id, { status: 'COMPLETED' });
        }
      }
    }
  }

  schedule({ title, sourceUrl, qualityPreset, scheduledStartTime, scheduledStopTime, autoStart, retryOnFail, maxRetries }) {
    if (!sourceUrl || !scheduledStartTime) {
      throw new Error('Source URL and Scheduled Start Time are required.');
    }

    return db.createScheduledStream({
      title,
      sourceUrl,
      qualityPreset,
      scheduledStartTime,
      scheduledStopTime,
      autoStart,
      retryOnFail,
      maxRetries
    });
  }

  cancel(id) {
    return db.updateScheduledStream(id, { status: 'CANCELLED' });
  }

  delete(id) {
    return db.deleteScheduledStream(id);
  }
}

module.exports = new StreamScheduler();
