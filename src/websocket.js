const { WebSocketServer } = require('ws');
const queueService = require('./queue/queueService');

function isOriginAllowed(origin, hostHeader) {
  if (!origin) return true; // Same-origin or non-browser client
  try {
    const originUrl = new URL(origin);
    if (['localhost', '127.0.0.1', '::1'].includes(originUrl.hostname)) return true;
    if (hostHeader && originUrl.host.toLowerCase() === hostHeader.toLowerCase()) return true;
    return false;
  } catch (_) {
    return false;
  }
}

function setupWebSocket(server) {
  const wss = new WebSocketServer({
    server,
    path: '/ws/telemetry',
    verifyClient: (info, cb) => {
      // Defend against Cross-Site WebSocket Hijacking (CSWSH) at HTTP Upgrade handshake
      const origin = info.origin || info.req.headers['origin'];
      const host = info.req.headers['host'];
      if (!isOriginAllowed(origin, host)) {
        return cb(false, 403, 'Forbidden origin');
      }
      cb(true);
    }
  });

  wss.on('connection', ws => {
    // Send initial state upon connect
    const active = queueService.getActiveSession();
    ws.send(JSON.stringify({ type: 'init', activeSession: active }));

    const onTelemetry = data => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'telemetry', data }));
      }
    };

    const onLog = logData => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'log', log: logData }));
      }
    };

    const onSessionUpdate = statusData => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'session_update', status: statusData }));
      }
    };

    queueService.on('telemetry', onTelemetry);
    queueService.on('log', onLog);
    queueService.on('session_update', onSessionUpdate);

    ws.on('close', () => {
      queueService.removeListener('telemetry', onTelemetry);
      queueService.removeListener('log', onLog);
      queueService.removeListener('session_update', onSessionUpdate);
    });
  });

  return wss;
}

module.exports = { setupWebSocket };
