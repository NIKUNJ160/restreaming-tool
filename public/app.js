(function () {
  'use strict';

  // --- SECURITY SANITIZER ---
  function escapeHtml(str) {
    if (!str && str !== 0) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // --- STATE ---
  let activeSessionId = null;
  let masterStatus = 'OFFLINE';
  let uptimeInterval = null;
  let streamStartedAt = null;
  let hlsInstance = null;
  let ws = null;

  // --- DOM REFERENCES ---
  const navItems = document.querySelectorAll('.sidebar-nav .nav-item');
  const tabPanes = document.querySelectorAll('.tab-pane');

  const masterStatusBadge = document.getElementById('masterStatusBadge');
  const masterUptime = document.getElementById('masterUptime');
  const quickStopBtn = document.getElementById('quickStopBtn');
  const sidebarLivePill = document.getElementById('sidebarLivePill');
  const activeChannelDisplay = document.getElementById('activeChannelDisplay');

  // Telemetry HUD
  const telBitrate = document.getElementById('telBitrate');
  const telBitrateBar = document.getElementById('telBitrateBar');
  const telFps = document.getElementById('telFps');
  const telResolution = document.getElementById('telResolution');
  const telHealthDot = document.getElementById('telHealthDot');
  const telHealthText = document.getElementById('telHealthText');
  const telSpeed = document.getElementById('telSpeed');
  const telFrames = document.getElementById('telFrames');

  // Monitor
  const sourceVideoPlayer = document.getElementById('sourceVideoPlayer');
  const noSignalOverlay = document.getElementById('noSignalOverlay');
  const previewSourceBtn = document.getElementById('previewSourceBtn');
  const sourceTypeBadge = document.getElementById('sourceTypeBadge');
  const monitorStatus = document.getElementById('monitorStatus');
  const probeResultText = document.getElementById('probeResultText');

  // Form Controls
  const broadcastForm = document.getElementById('broadcastForm');
  let currentSourceMode = 'url'; // 'url' | 'file'
  const sourceModeUrlBtn = document.getElementById('sourceModeUrlBtn');
  const sourceModeFileBtn = document.getElementById('sourceModeFileBtn');
  const sourceUrlSection = document.getElementById('sourceUrlSection');
  const sourceFileSection = document.getElementById('sourceFileSection');
  const sourceDownloadedSelect = document.getElementById('sourceDownloadedSelect');
  const refreshDownloadedBtn = document.getElementById('refreshDownloadedBtn');
  const loopVideoCheck = document.getElementById('loopVideoCheck');
  const streamSourceUrl = document.getElementById('streamSourceUrl');
  const validateUrlBtn = document.getElementById('validateUrlBtn');
  const validationFeedback = document.getElementById('validationFeedback');
  const qualityPresetSelect = document.getElementById('qualityPresetSelect');
  const kickAccountSelect = document.getElementById('kickAccountSelect');
  const manualKeySection = document.getElementById('manualKeySection');
  const manualStreamKeyInput = document.getElementById('manualStreamKeyInput');
  const recordStreamCheck = document.getElementById('recordStreamCheck');
  const ownershipConfirmCheck = document.getElementById('ownershipConfirmCheck');
  const startBroadcastBtn = document.getElementById('startBroadcastBtn');
  const stopBroadcastBtn = document.getElementById('stopBroadcastBtn');

  // Logs Terminal
  const terminalLogs = document.getElementById('terminalLogs');
  const terminalAutoScroll = document.getElementById('terminalAutoScroll');
  const clearTerminalBtn = document.getElementById('clearTerminalBtn');

  // Sidebar Kick Widget
  const sidebarAccountName = document.getElementById('sidebarAccountName');
  const sidebarAccountStatus = document.getElementById('sidebarAccountStatus');

  // --- NAVIGATION ROUTING ---
  navItems.forEach(item => {
    item.addEventListener('click', () => {
      const tabId = item.getAttribute('data-tab');
      navItems.forEach(n => n.classList.remove('active'));
      item.classList.add('active');

      tabPanes.forEach(pane => {
        pane.classList.remove('active');
        if (pane.id === `tab-${tabId}`) {
          pane.classList.add('active');
        }
      });

      // Refresh specific tab data
      if (tabId === 'overview') loadOverviewKPIs();
      if (tabId === 'history') loadBroadcastHistory();
      if (tabId === 'scheduler') loadScheduledStreams();
      if (tabId === 'downloads') loadDownloadedFiles();
      if (tabId === 'clipper') initClipperTab();
      if (tabId === 'settings') loadKickSettings();
    });
  });

  // --- LOGGING ---
  function appendLog(line) {
    if (!line) return;
    terminalLogs.textContent += line + '\n';
    if (terminalAutoScroll.checked) {
      terminalLogs.scrollTop = terminalLogs.scrollHeight;
    }
  }

  clearTerminalBtn.addEventListener('click', () => {
    terminalLogs.textContent = '';
  });

  // --- STATUS UPDATES ---
  function updateMasterStatus(status) {
    masterStatus = status ? status.toUpperCase() : 'OFFLINE';
    masterStatusBadge.className = 'badge-status';

    const isLive = masterStatus === 'LIVE';
    const isStarting = masterStatus === 'STARTING';
    const isRunning = isLive || isStarting;

    if (isLive) {
      masterStatusBadge.classList.add('badge-live');
      masterStatusBadge.textContent = '● LIVE';
      sidebarLivePill.style.display = 'block';
      monitorStatus.textContent = 'TRANSMITTING';
      monitorStatus.style.color = '#53FC18';
    } else if (isStarting) {
      masterStatusBadge.classList.add('badge-starting');
      masterStatusBadge.textContent = 'STARTING...';
      sidebarLivePill.style.display = 'block';
      monitorStatus.textContent = 'INITIALIZING';
      monitorStatus.style.color = '#FF9500';
    } else {
      masterStatusBadge.classList.add('badge-offline');
      masterStatusBadge.textContent = masterStatus;
      sidebarLivePill.style.display = 'none';
      monitorStatus.textContent = 'NO SIGNAL';
      monitorStatus.style.color = '';
    }

    startBroadcastBtn.disabled = isRunning;
    stopBroadcastBtn.disabled = !isRunning;
    quickStopBtn.disabled = !isRunning;
    streamSourceUrl.disabled = isRunning;
    qualityPresetSelect.disabled = isRunning;
    kickAccountSelect.disabled = isRunning;
    manualStreamKeyInput.disabled = isRunning;

    if (isLive) {
      if (!uptimeInterval && streamStartedAt) {
        startUptimeCounter();
      }
    } else {
      stopUptimeCounter();
    }
  }

  function startUptimeCounter() {
    stopUptimeCounter();
    updateUptime();
    uptimeInterval = setInterval(updateUptime, 1000);
  }

  function stopUptimeCounter() {
    if (uptimeInterval) {
      clearInterval(uptimeInterval);
      uptimeInterval = null;
    }
    masterUptime.textContent = '00:00:00';
  }

  function updateUptime() {
    if (!streamStartedAt) return;
    const totalSecs = Math.max(0, Math.floor((Date.now() - streamStartedAt) / 1000));
    const h = String(Math.floor(totalSecs / 3600)).padStart(2, '0');
    const m = String(Math.floor((totalSecs % 3600) / 60)).padStart(2, '0');
    const s = String(totalSecs % 60).padStart(2, '0');
    masterUptime.textContent = `${h}:${m}:${s}`;
  }

  // --- TELEMETRY DATA HANDLER ---
  function handleTelemetry(metrics) {
    if (!metrics) return;

    // Bitrate
    const br = metrics.bitrateKbps || 0;
    telBitrate.textContent = br;
    const maxBar = 8000;
    const pct = Math.min(100, (br / maxBar) * 100);
    telBitrateBar.style.width = `${pct}%`;

    // FPS & Res
    telFps.textContent = (metrics.fps || 0).toFixed(1);
    if (metrics.resolution) {
      telResolution.textContent = `Target: ${metrics.resolution}`;
    }

    // Health
    telHealthDot.className = 'health-dot';
    if (metrics.networkHealth === 'GOOD') {
      telHealthDot.classList.add('health-good');
      telHealthText.textContent = 'GOOD';
    } else if (metrics.networkHealth === 'FAIR') {
      telHealthDot.classList.add('health-fair');
      telHealthText.textContent = 'FAIR';
    } else if (metrics.networkHealth === 'POOR') {
      telHealthDot.classList.add('health-poor');
      telHealthText.textContent = 'POOR';
    } else {
      telHealthDot.classList.add('health-gray');
      telHealthText.textContent = 'IDLE';
    }

    telSpeed.textContent = `Speed: ${metrics.speed || '0.0x'}`;
    telFrames.textContent = metrics.frames || 0;
  }

  // --- WEBSOCKET / SSE TELEMETRY CONNECTION ---
  function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws/telemetry`;

    try {
      ws = new WebSocket(wsUrl);

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'init') {
            if (msg.activeSession) {
              activeSessionId = msg.activeSession.sessionId;
              streamStartedAt = Date.now() - (msg.activeSession.metrics?.uptimeSeconds || 0) * 1000;
              updateMasterStatus(msg.activeSession.status);
              handleTelemetry(msg.activeSession.metrics);
              if (msg.activeSession.logs) {
                msg.activeSession.logs.forEach(appendLog);
              }
            }
          } else if (msg.type === 'telemetry') {
            handleTelemetry(msg.data?.metrics);
            if (msg.data?.status) {
              updateMasterStatus(msg.data.status);
            }
          } else if (msg.type === 'log') {
            appendLog(msg.log?.line);
          } else if (msg.type === 'session_update') {
            updateMasterStatus(msg.status?.status);
            if (msg.status?.error) {
              appendLog(`[ERROR] ${msg.status.error}`);
            }
          }
        } catch (_) {}
      };

      ws.onclose = () => {
        setTimeout(connectWebSocket, 4000);
      };

      ws.onerror = () => {
        // Fallback polling
        checkActiveSession();
      };
    } catch (_) {
      setTimeout(connectWebSocket, 5000);
    }
  }

  // --- SOURCE MODE SWITCHING (LIVE URL vs DOWNLOADED FILE) ---
  if (sourceModeUrlBtn && sourceModeFileBtn) {
    sourceModeUrlBtn.addEventListener('click', () => {
      currentSourceMode = 'url';
      sourceModeUrlBtn.classList.add('active-toggle');
      sourceModeFileBtn.classList.remove('active-toggle');
      sourceUrlSection.style.display = 'block';
      sourceFileSection.style.display = 'none';
      validationFeedback.style.display = 'none';
    });

    sourceModeFileBtn.addEventListener('click', () => {
      currentSourceMode = 'file';
      sourceModeFileBtn.classList.add('active-toggle');
      sourceModeUrlBtn.classList.remove('active-toggle');
      sourceUrlSection.style.display = 'none';
      sourceFileSection.style.display = 'block';
      validationFeedback.style.display = 'none';
      populateSourceDownloadedSelect();
    });
  }

  if (refreshDownloadedBtn) {
    refreshDownloadedBtn.addEventListener('click', () => populateSourceDownloadedSelect());
  }

  async function populateSourceDownloadedSelect(preselectName) {
    if (!sourceDownloadedSelect) return;
    try {
      const [dlRes, clipRes] = await Promise.all([
        fetch('/api/download/files').then(r => r.json()).catch(() => ({ files: [] })),
        fetch('/api/clips').then(r => r.json()).catch(() => ({ clips: [] }))
      ]);

      const dlFiles = dlRes.files || [];
      const clips = clipRes.clips || [];

      sourceDownloadedSelect.innerHTML = '<option value="">-- Choose a downloaded video or clip --</option>';

      if (dlFiles.length > 0) {
        const grp = document.createElement('optgroup');
        grp.label = 'Downloaded Stream Videos';
        dlFiles.forEach(f => {
          const opt = document.createElement('option');
          opt.value = f.fileName;
          opt.dataset.category = 'downloads';
          opt.textContent = `${f.fileName} (${(f.fileSizeBytes / (1024 * 1024)).toFixed(1)} MB)`;
          if (preselectName && preselectName === f.fileName) opt.selected = true;
          grp.appendChild(opt);
        });
        sourceDownloadedSelect.appendChild(grp);
      }

      if (clips.length > 0) {
        const grpClips = document.createElement('optgroup');
        grpClips.label = 'Generated Shorts & Clips';
        clips.forEach(c => {
          const opt = document.createElement('option');
          opt.value = c.fileName;
          opt.dataset.category = 'clips';
          opt.textContent = `${c.title} [${c.layout}] (${c.durationSeconds}s)`;
          if (preselectName && preselectName === c.fileName) opt.selected = true;
          grpClips.appendChild(opt);
        });
        sourceDownloadedSelect.appendChild(grpClips);
      }

      if (preselectName) {
        sourceDownloadedSelect.value = preselectName;
        onSourceFileSelected(preselectName);
      }
    } catch (_) {}
  }

  if (sourceDownloadedSelect) {
    sourceDownloadedSelect.addEventListener('change', () => {
      const fileName = sourceDownloadedSelect.value;
      if (fileName) {
        onSourceFileSelected(fileName);
      }
    });
  }

  function onSourceFileSelected(fileName) {
    if (!fileName) return;
    const selectedOpt = sourceDownloadedSelect.options[sourceDownloadedSelect.selectedIndex];
    const cat = selectedOpt ? selectedOpt.dataset.category : 'downloads';
    const previewUrl = cat === 'clips' ? `/api/clips/preview/${encodeURIComponent(fileName)}` : `/api/download/file/${encodeURIComponent(fileName)}`;

    if (hlsInstance) {
      hlsInstance.destroy();
      hlsInstance = null;
    }
    noSignalOverlay.style.display = 'none';
    sourceVideoPlayer.style.display = 'block';
    sourceVideoPlayer.src = previewUrl;
    sourceVideoPlayer.play().catch(() => {});

    runSourceProbe({ sourceType: 'download', sourceFileName: fileName });
  }

  function switchAndBroadcastFile(fileName) {
    navItems.forEach(n => {
      if (n.getAttribute('data-tab') === 'control-room') n.classList.add('active');
      else n.classList.remove('active');
    });
    tabPanes.forEach(p => {
      if (p.id === 'tab-control-room') p.classList.add('active');
      else p.classList.remove('active');
    });

    currentSourceMode = 'file';
    if (sourceModeFileBtn && sourceModeUrlBtn) {
      sourceModeFileBtn.classList.add('active-toggle');
      sourceModeUrlBtn.classList.remove('active-toggle');
      sourceUrlSection.style.display = 'none';
      sourceFileSection.style.display = 'block';
    }

    populateSourceDownloadedSelect(fileName);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // --- SOURCE VALIDATION & PROBE ---
  async function runSourceProbe(payload) {
    validateUrlBtn.disabled = true;
    validateUrlBtn.textContent = 'Probing...';
    showValidationFeedback('Probing media streams and codecs with FFmpeg...', null);

    try {
      const res = await fetch('/api/stream/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Validation failed.');
      }

      sourceTypeBadge.textContent = data.detectedType || (payload.sourceType === 'download' ? 'LOCAL_VIDEO' : 'DIRECT');
      sourceTypeBadge.style.color = '#53FC18';

      const probe = data.probe || {};
      const feedback = `✓ Detected ${data.detectedType} (${probe.videoCodec}/${probe.audioCodec}, ${probe.resolution || 'auto'} @ ${probe.fps || 30}fps). ${probe.recommendation || (data.isLocalFile ? 'Ready to broadcast local video to Kick.' : '')}`;
      showValidationFeedback(feedback, true);
      probeResultText.textContent = `${probe.videoCodec} • ${probe.audioCodec} • ${probe.resolution || 'auto'}`;
    } catch (err) {
      showValidationFeedback(`✗ ${err.message}`, false);
      sourceTypeBadge.textContent = 'ERROR';
      sourceTypeBadge.style.color = '#FF3B30';
    } finally {
      validateUrlBtn.disabled = false;
      validateUrlBtn.textContent = 'Validate & Probe';
    }
  }

  validateUrlBtn.addEventListener('click', () => {
    if (currentSourceMode === 'file') {
      const fileName = sourceDownloadedSelect.value;
      if (!fileName) {
        showValidationFeedback('Please choose a downloaded video file first.', false);
        return;
      }
      runSourceProbe({ sourceType: 'download', sourceFileName: fileName });
    } else {
      const url = streamSourceUrl.value.trim();
      if (!url) {
        showValidationFeedback('Please enter a stream URL first.', false);
        return;
      }
      runSourceProbe({ sourceUrl: url });
    }
  });

  function showValidationFeedback(msg, isSuccess) {
    validationFeedback.textContent = msg;
    validationFeedback.style.display = 'block';
    validationFeedback.className = 'validation-feedback';
    if (isSuccess === true) validationFeedback.classList.add('feedback-success');
    else if (isSuccess === false) validationFeedback.classList.add('feedback-error');
  }

  // --- SOURCE PREVIEW PLAYER (HLS.js / Local Video) ---
  previewSourceBtn.addEventListener('click', () => {
    if (currentSourceMode === 'file') {
      const fileName = sourceDownloadedSelect.value;
      if (!fileName) {
        alert('Please choose a downloaded video file to preview.');
        return;
      }
      onSourceFileSelected(fileName);
      return;
    }

    const url = streamSourceUrl.value.trim();
    if (!url) {
      alert('Please enter a source livestream URL to preview.');
      return;
    }

    if (hlsInstance) {
      hlsInstance.destroy();
      hlsInstance = null;
    }

    noSignalOverlay.style.display = 'none';
    sourceVideoPlayer.style.display = 'block';

    if (url.includes('.m3u8') && Hls && Hls.isSupported()) {
      hlsInstance = new Hls({ enableWorker: true });
      hlsInstance.loadSource(url);
      hlsInstance.attachMedia(sourceVideoPlayer);
      hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
        sourceVideoPlayer.play().catch(() => {});
      });
    } else {
      sourceVideoPlayer.src = url;
      sourceVideoPlayer.play().catch(() => {});
    }
  });

  // --- KICK DESTINATION SELECTOR ---
  kickAccountSelect.addEventListener('change', () => {
    if (kickAccountSelect.value === 'manual') {
      manualKeySection.style.display = 'block';
      manualStreamKeyInput.required = true;
    } else {
      manualKeySection.style.display = 'none';
      manualStreamKeyInput.required = false;
    }
  });

  // --- START BROADCAST ---
  broadcastForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    if (!ownershipConfirmCheck.checked) {
      alert('You must confirm ownership or legal authorization to rebroadcast.');
      return;
    }

    const kickAccountId = kickAccountSelect.value !== 'manual' ? kickAccountSelect.value : null;
    const customStreamKey = kickAccountSelect.value === 'manual' ? manualStreamKeyInput.value.trim() : null;
    const qualityPreset = qualityPresetSelect.value;

    if (!kickAccountId && !customStreamKey) {
      alert('Please select a saved Kick account or enter a Stream Key.');
      return;
    }

    let payload = {
      kickAccountId,
      customStreamKey,
      qualityPreset,
      ownershipConfirmed: true
    };

    if (currentSourceMode === 'file') {
      const fileName = sourceDownloadedSelect.value;
      if (!fileName) {
        alert('Please choose a downloaded video file to broadcast.');
        return;
      }
      payload.sourceType = 'download';
      payload.sourceFileName = fileName;
      payload.loopVideo = loopVideoCheck ? loopVideoCheck.checked : true;
      payload.title = `Broadcast: ${fileName}`;
    } else {
      const sourceUrl = streamSourceUrl.value.trim();
      if (!sourceUrl) {
        alert('Source livestream URL is required.');
        return;
      }
      payload.sourceUrl = sourceUrl;
    }

    updateMasterStatus('STARTING');
    appendLog(`[UI] Launching broadcast job (${currentSourceMode === 'file' ? 'Downloaded File' : 'Livestream URL'})...`);

    try {
      const res = await fetch('/api/stream/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to start stream.');
      }

      activeSessionId = data.session?.sessionId;
      streamStartedAt = Date.now();
      updateMasterStatus('STARTING');
    } catch (err) {
      updateMasterStatus('OFFLINE');
      alert(`Start failed: ${err.message}`);
    }
  });

  // --- STOP BROADCAST ---
  async function triggerStop() {
    updateMasterStatus('STOPPING');
    appendLog('[UI] Stop request dispatched to engine...');
    try {
      const res = await fetch('/api/stream/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: activeSessionId })
      });
      const data = await res.json();
      updateMasterStatus('OFFLINE');
      activeSessionId = null;
    } catch (err) {
      alert(`Stop failed: ${err.message}`);
    }
  }

  stopBroadcastBtn.addEventListener('click', triggerStop);
  quickStopBtn.addEventListener('click', triggerStop);

  // --- CHECK ACTIVE SESSION ON LOAD ---
  async function checkActiveSession() {
    try {
      const res = await fetch('/api/stream/active');
      const data = await res.json();
      if (data.active && data.session) {
        activeSessionId = data.session.sessionId;
        streamStartedAt = Date.now() - (data.session.metrics?.uptimeSeconds || 0) * 1000;
        updateMasterStatus(data.session.status);
        handleTelemetry(data.session.metrics);
        streamSourceUrl.value = data.session.sourceUrl || '';
      } else {
        updateMasterStatus('OFFLINE');
      }
    } catch (_) {}
  }

  // --- LOAD KICK ACCOUNTS & SETTINGS ---
  async function loadKickSettings() {
    try {
      const res = await fetch('/api/kick/status');
      const data = await res.json();
      if (data.success) {
        // Update sidebar
        if (data.connected && data.primaryAccount) {
          sidebarAccountName.textContent = `@${data.primaryAccount.kickUsername}`;
          sidebarAccountStatus.textContent = 'Linked (AES-256)';
          activeChannelDisplay.textContent = `Kick: @${data.primaryAccount.kickUsername}`;
        } else {
          sidebarAccountName.textContent = 'No Kick Account';
          sidebarAccountStatus.textContent = 'Connect Key';
          activeChannelDisplay.textContent = 'Manual Stream Key';
        }

        // Update dropdown in form
        kickAccountSelect.innerHTML = '';
        if (data.accounts && data.accounts.length > 0) {
          data.accounts.forEach(acc => {
            const opt = document.createElement('option');
            opt.value = acc.id;
            opt.textContent = `Kick: @${acc.kickUsername} (${acc.maskedStreamKey})`;
            kickAccountSelect.appendChild(opt);
          });
        }
        const manualOpt = document.createElement('option');
        manualOpt.value = 'manual';
        manualOpt.textContent = 'Manual Stream Key';
        kickAccountSelect.appendChild(manualOpt);

        if (data.accounts.length > 0) {
          manualKeySection.style.display = 'none';
          manualStreamKeyInput.required = false;
        } else {
          manualKeySection.style.display = 'block';
          manualStreamKeyInput.required = true;
        }

        // Update connected list in settings tab
        const listEl = document.getElementById('connectedAccountsList');
        if (listEl) {
          if (!data.accounts || data.accounts.length === 0) {
            listEl.innerHTML = '<p class="text-muted">No Kick accounts saved yet.</p>';
          } else {
            listEl.innerHTML = '';
            data.accounts.forEach(acc => {
              const card = document.createElement('div');
              card.className = 'account-card-item';
              card.innerHTML = `
                <div class="account-card-left">
                  <div class="account-avatar-placeholder">K</div>
                  <div>
                    <div class="account-card-username">@${escapeHtml(acc.kickUsername)}</div>
                    <div class="account-card-key">Key: ${escapeHtml(acc.maskedStreamKey)} • Ingest: ${escapeHtml(acc.rtmpUrl)}</div>
                  </div>
                </div>
                <button type="button" class="btn btn-danger-sm delete-kick-btn" data-id="${escapeHtml(acc.id)}">Disconnect</button>
              `;
              listEl.appendChild(card);
            });

            // Bind disconnect
            document.querySelectorAll('.delete-kick-btn').forEach(btn => {
              btn.addEventListener('click', async () => {
                if (confirm('Disconnect this Kick account?')) {
                  await fetch(`/api/kick/account/${btn.getAttribute('data-id')}`, { method: 'DELETE' });
                  loadKickSettings();
                }
              });
            });
          }
        }
      }
    } catch (_) {}
  }

  // Connect Kick Account Form
  const kickAccountForm = document.getElementById('kickAccountForm');
  if (kickAccountForm) {
    kickAccountForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const kickUsername = document.getElementById('kickUsernameInput').value.trim();
      const streamKey = document.getElementById('kickStreamKeyInput').value.trim();
      const rtmpUrl = document.getElementById('kickRtmpUrlInput').value.trim();

      try {
        const res = await fetch('/api/kick/connect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kickUsername, streamKey, rtmpUrl })
        });
        const data = await res.json();
        if (data.success) {
          alert('Kick account encrypted and linked successfully!');
          kickAccountForm.reset();
          loadKickSettings();
        } else {
          alert(data.error || 'Failed to save account.');
        }
      } catch (err) {
        alert(err.message);
      }
    });
  }

  // --- LOAD OVERVIEW KPIS ---
  async function loadOverviewKPIs() {
    try {
      const res = await fetch('/api/metrics');
      const data = await res.json();
      if (data.success && data.metrics) {
        const m = data.metrics;
        document.getElementById('kpiHours').textContent = m.totalStreamingHours || '0.0';
        document.getElementById('kpiBroadcasts').textContent = m.totalBroadcasts || 0;
        document.getElementById('kpiBandwidth').textContent = m.totalBandwidthGB || '0.00';
        document.getElementById('kpiKickStatus').textContent = m.kickConnected ? 'Connected' : 'Offline';
        document.getElementById('kpiKickChannel').textContent = m.primaryKick ? `@${m.primaryKick}` : 'No channel linked';
      }

      // Load recent broadcasts
      const histRes = await fetch('/api/stream/history');
      const histData = await histRes.json();
      const tbody = document.getElementById('recentBroadcastsBody');
      if (tbody && histData.sessions) {
        if (histData.sessions.length === 0) {
          tbody.innerHTML = '<tr><td colspan="7" class="text-center">No broadcasts recorded yet.</td></tr>';
        } else {
          tbody.innerHTML = '';
          histData.sessions.slice(0, 5).forEach(s => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
              <td><strong>${escapeHtml(s.title)}</strong></td>
              <td><span class="tag-badge">${escapeHtml(s.sourceFormat || 'DIRECT')}</span></td>
              <td>${escapeHtml(s.qualityPreset)}</td>
              <td>${escapeHtml(s.durationSeconds)}s</td>
              <td>${escapeHtml(s.videoBitrate || 0)} kbps</td>
              <td><span class="tag-badge" style="color: ${s.status === 'LIVE' ? '#53FC18' : '#A0AEC0'}">${escapeHtml(s.status)}</span></td>
              <td>${escapeHtml(new Date(s.createdAt).toLocaleDateString())}</td>
            `;
            tbody.appendChild(tr);
          });
        }
      }
    } catch (_) {}
  }

  // --- LOAD BROADCAST HISTORY ---
  async function loadBroadcastHistory() {
    const tbody = document.getElementById('historyTableBody');
    try {
      const res = await fetch('/api/stream/history');
      const data = await res.json();
      if (data.sessions && data.sessions.length > 0) {
        tbody.innerHTML = '';
        data.sessions.forEach(s => {
          const tr = document.createElement('tr');
          tr.innerHTML = `
            <td><code>${escapeHtml(s.id)}</code></td>
            <td><strong>${escapeHtml(s.title)}</strong></td>
            <td style="max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(s.sourceUrl)}</td>
            <td><span class="tag-badge">${escapeHtml(s.sourceFormat || 'DIRECT')}</span></td>
            <td>${escapeHtml(s.resolution || 'auto')}</td>
            <td>${escapeHtml(s.durationSeconds || 0)}s</td>
            <td><span class="tag-badge">${escapeHtml(s.status)}</span></td>
            <td>${s.endTime ? escapeHtml(new Date(s.endTime).toLocaleTimeString()) : 'In Progress'}</td>
          `;
          tbody.appendChild(tr);
        });
      } else {
        tbody.innerHTML = '<tr><td colspan="8" class="text-center">No broadcast sessions in history.</td></tr>';
      }
    } catch (_) {}
  }

  // --- SCHEDULER TAB ---
  const schedulerForm = document.getElementById('schedulerForm');
  if (schedulerForm) {
    schedulerForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const title = document.getElementById('schedTitle').value.trim();
      const sourceUrl = document.getElementById('schedSourceUrl').value.trim();
      const scheduledStartTime = document.getElementById('schedStartTime').value;
      const scheduledStopTime = document.getElementById('schedStopTime').value || null;
      const qualityPreset = document.getElementById('schedQualityPreset').value;
      const autoStart = document.getElementById('schedAutoStart').value === 'true';

      try {
        const res = await fetch('/api/schedule', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title,
            sourceUrl,
            scheduledStartTime,
            scheduledStopTime,
            qualityPreset,
            autoStart
          })
        });
        const data = await res.json();
        if (data.success) {
          alert('Broadcast scheduled successfully!');
          schedulerForm.reset();
          loadScheduledStreams();
        } else {
          alert(data.error || 'Failed to schedule.');
        }
      } catch (err) {
        alert(err.message);
      }
    });
  }

  async function loadScheduledStreams() {
    const tbody = document.getElementById('scheduledTableBody');
    try {
      const res = await fetch('/api/schedule');
      const data = await res.json();
      if (data.scheduled && data.scheduled.length > 0) {
        tbody.innerHTML = '';
        data.scheduled.forEach(s => {
          const tr = document.createElement('tr');
          tr.innerHTML = `
            <td><strong>${escapeHtml(s.title)}</strong></td>
            <td>${escapeHtml(new Date(s.scheduledStartTime).toLocaleString())}</td>
            <td>${escapeHtml(s.qualityPreset)}</td>
            <td><span class="tag-badge">${escapeHtml(s.status)}</span></td>
            <td>
              <button class="btn btn-danger-sm del-sched-btn" data-id="${escapeHtml(s.id)}">Delete</button>
            </td>
          `;
          tbody.appendChild(tr);
        });

        document.querySelectorAll('.del-sched-btn').forEach(btn => {
          btn.addEventListener('click', async () => {
            await fetch(`/api/schedule/${btn.getAttribute('data-id')}`, { method: 'DELETE' });
            loadScheduledStreams();
          });
        });
      } else {
        tbody.innerHTML = '<tr><td colspan="5" class="text-center">No scheduled events.</td></tr>';
      }
    } catch (_) {}
  }

  // --- VIDEO DOWNLOADER FROM URL ---
  const quickDlBtn = document.getElementById('quickDlBtn');
  if (quickDlBtn) {
    quickDlBtn.addEventListener('click', () => {
      const url = streamSourceUrl.value.trim();
      if (!url) {
        alert('Please enter a stream URL in the input field first.');
        return;
      }
      const dlVideoUrl = document.getElementById('dlVideoUrl');
      if (dlVideoUrl) dlVideoUrl.value = url;

      // Navigate to downloads tab
      const dlNav = document.querySelector('.sidebar-nav .nav-item[data-tab="downloads"]');
      if (dlNav) dlNav.click();
    });
  }

  const urlDownloaderForm = document.getElementById('urlDownloaderForm');
  const dlActiveBox = document.getElementById('dlActiveBox');
  const dlActiveList = document.getElementById('dlActiveList');
  let dlPollTimer = null;

  if (urlDownloaderForm) {
    urlDownloaderForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const sourceUrl = document.getElementById('dlVideoUrl').value.trim();
      const title = document.getElementById('dlVideoTitle').value.trim();
      const durationSeconds = document.getElementById('dlVideoDuration').value;

      if (!sourceUrl) {
        alert('Please enter a video or stream URL to download.');
        return;
      }

      try {
        const res = await fetch('/api/download/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sourceUrl, title, durationSeconds })
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
          throw new Error(data.error || 'Failed to start download.');
        }

        alert('Video download started! Monitoring capture below.');
        urlDownloaderForm.reset();
        startDlPolling();
      } catch (err) {
        alert(err.message);
      }
    });
  }

  function startDlPolling() {
    if (dlPollTimer) clearInterval(dlPollTimer);
    pollActiveDownloads();
    dlPollTimer = setInterval(pollActiveDownloads, 1500);
  }

  async function pollActiveDownloads() {
    try {
      const res = await fetch('/api/download/active');
      const data = await res.json();
      const active = data.active || [];

      if (!dlActiveBox || !dlActiveList) return;

      if (active.length === 0) {
        dlActiveBox.style.display = 'none';
        if (dlPollTimer) {
          clearInterval(dlPollTimer);
          dlPollTimer = null;
        }
        loadDownloadedFiles();
        return;
      }

      dlActiveBox.style.display = 'block';
      dlActiveList.innerHTML = '';

      active.forEach(item => {
        const mb = (item.downloadedBytes / (1024 * 1024)).toFixed(2);
        const card = document.createElement('div');
        card.className = 'download-progress-card';
        card.innerHTML = `
          <div>
            <div class="dl-filename"><strong>${escapeHtml(item.fileName)}</strong></div>
            <div class="dl-stats">Downloaded: <strong>${escapeHtml(mb)} MB</strong> • Duration: ${escapeHtml(item.durationSeconds)}s • Speed: ${escapeHtml(item.speed)}</div>
          </div>
          <button type="button" class="btn btn-danger-sm stop-capture-btn" data-id="${escapeHtml(item.id)}">Stop Capture</button>
        `;
        dlActiveList.appendChild(card);
      });

      document.querySelectorAll('.stop-capture-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          await fetch('/api/download/stop', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: btn.getAttribute('data-id') })
          });
          pollActiveDownloads();
        });
      });
    } catch (_) {}
  }

  async function loadDownloadedFiles() {
    const tbody = document.getElementById('dlFilesTableBody');
    if (!tbody) return;

    try {
      const res = await fetch('/api/download/files');
      const data = await res.json();
      if (data.files && data.files.length > 0) {
        tbody.innerHTML = '';
        data.files.forEach(f => {
          const mb = (Number(f.fileSizeBytes) / (1024 * 1024)).toFixed(1);
          const tr = document.createElement('tr');
          tr.innerHTML = `
            <td><code>${escapeHtml(f.fileName)}</code></td>
            <td>${escapeHtml(mb)} MB</td>
            <td>${escapeHtml(new Date(f.createdAt).toLocaleString())}</td>
            <td>
              <button class="btn btn-kick-primary-xs broadcast-file-btn" data-name="${encodeURIComponent(f.fileName)}" style="margin-right:6px;">🔴 Broadcast to Kick</button>
              <a href="${escapeHtml(f.downloadUrl)}" download class="btn btn-secondary-xs" style="text-decoration:none; margin-right:6px;">Download MP4</a>
              <button class="btn btn-danger-sm del-file-btn" data-name="${encodeURIComponent(f.fileName)}">Delete</button>
            </td>
          `;
          tbody.appendChild(tr);
        });

        document.querySelectorAll('.broadcast-file-btn').forEach(btn => {
          btn.addEventListener('click', () => {
            const fileName = decodeURIComponent(btn.getAttribute('data-name'));
            switchAndBroadcastFile(fileName);
          });
        });

        document.querySelectorAll('.del-file-btn').forEach(btn => {
          btn.addEventListener('click', async () => {
            const fileName = btn.getAttribute('data-name');
            if (confirm(`Delete ${decodeURIComponent(fileName)}?`)) {
              await fetch(`/api/download/file/${fileName}`, { method: 'DELETE' });
              loadDownloadedFiles();
            }
          });
        });
      } else {
        tbody.innerHTML = '<tr><td colspan="4" class="text-center">No downloaded files yet.</td></tr>';
      }
    } catch (_) {}
  }

  // --- OPENSHORTS CLIPPER CONTROLLER ---
  let selectedVideoData = null;

  const clipSourceUploadBtn = document.getElementById('clipSourceUploadBtn');
  const clipSourceDownloadedBtn = document.getElementById('clipSourceDownloadedBtn');
  const clipUploadSection = document.getElementById('clipUploadSection');
  const clipDownloadedSection = document.getElementById('clipDownloadedSection');
  const clipDropzone = document.getElementById('clipDropzone');
  const clipFileInput = document.getElementById('clipFileInput');
  const dropzonePrompt = document.getElementById('dropzonePrompt');
  const uploadProgressBox = document.getElementById('uploadProgressBox');
  const uploadProgressBar = document.getElementById('uploadProgressBar');
  const uploadStatusText = document.getElementById('uploadStatusText');
  const clipDownloadedSelect = document.getElementById('clipDownloadedSelect');

  const selectedVideoMetaBox = document.getElementById('selectedVideoMetaBox');
  const selectedVideoName = document.getElementById('selectedVideoName');
  const selectedVideoDuration = document.getElementById('selectedVideoDuration');
  const selectedVideoRes = document.getElementById('selectedVideoRes');

  const clipSourcePlayer = document.getElementById('clipSourcePlayer');
  const scrubberTimeBadge = document.getElementById('scrubberTimeBadge');
  const setStartFromCurrentBtn = document.getElementById('setStartFromCurrentBtn');
  const setEndFromCurrentBtn = document.getElementById('setEndFromCurrentBtn');
  const clipStartTime = document.getElementById('clipStartTime');
  const clipEndTime = document.getElementById('clipEndTime');
  const clipLayout = document.getElementById('clipLayout');
  const clipTitle = document.getElementById('clipTitle');
  const clipCaptionText = document.getElementById('clipCaptionText');
  const clipCaptionFont = document.getElementById('clipCaptionFont');
  const clipCaptionStyle = document.getElementById('clipCaptionStyle');
  const clipCaptionPosition = document.getElementById('clipCaptionPosition');
  const clipCaptionSize = document.getElementById('clipCaptionSize');
  const createClipBtn = document.getElementById('createClipBtn');
  const clipGenSpinner = document.getElementById('clipGenSpinner');
  const refreshClipsBtn = document.getElementById('refreshClipsBtn');
  const clipsGalleryGrid = document.getElementById('clipsGalleryGrid');

  function initClipperTab() {
    loadClipsList();
    populateDownloadedVideoSelect();
  }

  if (clipSourceUploadBtn && clipSourceDownloadedBtn) {
    clipSourceUploadBtn.addEventListener('click', () => {
      clipSourceUploadBtn.classList.add('active-toggle');
      clipSourceDownloadedBtn.classList.remove('active-toggle');
      clipUploadSection.style.display = 'block';
      clipDownloadedSection.style.display = 'none';
    });

    clipSourceDownloadedBtn.addEventListener('click', () => {
      clipSourceDownloadedBtn.classList.add('active-toggle');
      clipSourceUploadBtn.classList.remove('active-toggle');
      clipUploadSection.style.display = 'none';
      clipDownloadedSection.style.display = 'block';
      populateDownloadedVideoSelect();
    });
  }

  async function populateDownloadedVideoSelect() {
    if (!clipDownloadedSelect) return;
    try {
      const res = await fetch('/api/download/files');
      const data = await res.json();
      const files = data.files || [];
      clipDownloadedSelect.innerHTML = '<option value="">-- Choose a downloaded stream video --</option>';
      files.forEach(f => {
        const opt = document.createElement('option');
        opt.value = f.fileName;
        opt.textContent = `${f.fileName} (${(f.fileSizeBytes / (1024 * 1024)).toFixed(1)} MB)`;
        clipDownloadedSelect.appendChild(opt);
      });
    } catch (_) {}
  }

  if (clipDownloadedSelect) {
    clipDownloadedSelect.addEventListener('change', () => {
      const fileName = clipDownloadedSelect.value;
      if (!fileName) return;
      selectedVideoData = {
        fileName: fileName,
        sourceFileName: fileName,
        originalName: fileName
      };
      clipSourcePlayer.src = `/api/download/file/${encodeURIComponent(fileName)}`;
      clipSourcePlayer.load();
      selectedVideoName.textContent = fileName;
      selectedVideoDuration.textContent = 'Probing...';
      selectedVideoRes.textContent = 'Loading...';
      selectedVideoMetaBox.style.display = 'block';
      createClipBtn.disabled = false;
    });
  }

  if (clipDropzone && clipFileInput) {
    clipDropzone.addEventListener('click', () => clipFileInput.click());

    clipDropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      clipDropzone.classList.add('dragover');
    });

    clipDropzone.addEventListener('dragleave', () => {
      clipDropzone.classList.remove('dragover');
    });

    clipDropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      clipDropzone.classList.remove('dragover');
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        handleVideoUpload(e.dataTransfer.files[0]);
      }
    });

    clipFileInput.addEventListener('change', () => {
      if (clipFileInput.files && clipFileInput.files.length > 0) {
        handleVideoUpload(clipFileInput.files[0]);
      }
    });
  }

  function handleVideoUpload(file) {
    if (!file) return;
    dropzonePrompt.style.display = 'none';
    uploadProgressBox.style.display = 'block';
    uploadProgressBar.style.width = '0%';
    uploadStatusText.textContent = `Uploading ${file.name}...`;

    const formData = new FormData();
    formData.append('video', file);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/clips/upload', true);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded / e.total) * 100);
        uploadProgressBar.style.width = `${pct}%`;
        uploadStatusText.textContent = `Uploading ${file.name} (${pct}%)...`;
      }
    };

    xhr.onload = () => {
      uploadProgressBox.style.display = 'none';
      dropzonePrompt.style.display = 'block';

      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const res = JSON.parse(xhr.responseText);
          if (res.success && res.file) {
            selectedVideoData = res.file;
            selectedVideoName.textContent = res.file.originalName;
            selectedVideoDuration.textContent = `${res.file.durationSeconds}s`;
            selectedVideoRes.textContent = res.file.resolution;
            selectedVideoMetaBox.style.display = 'block';

            // Set up player with local object URL
            clipSourcePlayer.src = URL.createObjectURL(file);
            clipSourcePlayer.load();

            clipStartTime.value = '0';
            clipEndTime.value = String(Math.min(30, res.file.durationSeconds || 30));
            createClipBtn.disabled = false;
          } else {
            alert('Upload error: ' + (res.error || 'Unknown error'));
          }
        } catch (e) {
          alert('Upload failed parsing response.');
        }
      } else {
        alert('Upload failed with status ' + xhr.status);
      }
    };

    xhr.onerror = () => {
      uploadProgressBox.style.display = 'none';
      dropzonePrompt.style.display = 'block';
      alert('Network error while uploading video.');
    };

    xhr.send(formData);
  }

  // Scrubber sync
  if (clipSourcePlayer) {
    clipSourcePlayer.addEventListener('timeupdate', () => {
      const cur = Math.floor(clipSourcePlayer.currentTime);
      const dur = Math.floor(clipSourcePlayer.duration || 0);
      const fmt = (s) => {
        const m = Math.floor(s / 60);
        const rem = s % 60;
        return `${String(m).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
      };
      if (scrubberTimeBadge) scrubberTimeBadge.textContent = `${fmt(cur)} / ${fmt(dur)}`;
    });

    clipSourcePlayer.addEventListener('loadedmetadata', () => {
      const dur = Math.round(clipSourcePlayer.duration || 0);
      if (selectedVideoDuration && selectedVideoDuration.textContent === 'Probing...') {
        selectedVideoDuration.textContent = `${dur}s`;
      }
      if (selectedVideoRes && selectedVideoRes.textContent === 'Loading...') {
        selectedVideoRes.textContent = `${clipSourcePlayer.videoWidth}x${clipSourcePlayer.videoHeight}`;
      }
      clipEndTime.value = String(Math.min(30, dur || 30));
    });
  }

  if (setStartFromCurrentBtn && clipSourcePlayer) {
    setStartFromCurrentBtn.addEventListener('click', () => {
      clipStartTime.value = Math.floor(clipSourcePlayer.currentTime);
    });
  }

  if (setEndFromCurrentBtn && clipSourcePlayer) {
    setEndFromCurrentBtn.addEventListener('click', () => {
      clipEndTime.value = Math.ceil(clipSourcePlayer.currentTime);
    });
  }

  // Create clip action
  if (createClipBtn) {
    createClipBtn.addEventListener('click', async () => {
      if (!selectedVideoData) {
        alert('Please select or upload a video first.');
        return;
      }

      createClipBtn.disabled = true;
      if (clipGenSpinner) clipGenSpinner.style.display = 'block';

      try {
        const res = await fetch('/api/clips/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sourceVideoPath: selectedVideoData.filePath || null,
            sourceFileName: selectedVideoData.fileName || selectedVideoData.sourceFileName,
            startTime: clipStartTime.value,
            endTime: clipEndTime.value,
            layout: clipLayout.value,
            title: clipTitle.value || 'short_clip',
            captionText: clipCaptionText ? clipCaptionText.value.trim() : null,
            captionFont: clipCaptionFont ? clipCaptionFont.value : 'segoe',
            captionStyle: clipCaptionStyle ? clipCaptionStyle.value : 'kick_green',
            captionPosition: clipCaptionPosition ? clipCaptionPosition.value : 'top_hook',
            captionSize: clipCaptionSize ? clipCaptionSize.value : 'medium'
          })
        });

        const data = await res.json();
        if (data.success && data.clip) {
          loadClipsList();
          alert(`Success! Clip "${data.clip.title}" created with layout ${data.clip.layout}${data.clip.captionText ? ' and modern captions' : ''}.`);
        } else {
          alert('Error generating clip: ' + (data.error || 'Unknown error'));
        }
      } catch (err) {
        alert('Clip creation failed: ' + err.message);
      } finally {
        createClipBtn.disabled = false;
        if (clipGenSpinner) clipGenSpinner.style.display = 'none';
      }
    });
  }

  if (refreshClipsBtn) {
    refreshClipsBtn.addEventListener('click', loadClipsList);
  }

  async function loadClipsList() {
    if (!clipsGalleryGrid) return;
    try {
      const res = await fetch('/api/clips');
      const data = await res.json();
      const clips = data.clips || [];

      if (clips.length === 0) {
        clipsGalleryGrid.innerHTML = '<p class="text-muted" style="grid-column: 1 / -1; text-align: center; padding: 24px;">No clips generated yet. Upload or pick a video above and generate a 9:16 short.</p>';
        return;
      }

      clipsGalleryGrid.innerHTML = '';
      clips.forEach(clip => {
        const card = document.createElement('div');
        card.className = 'clip-card';
        const mb = (Number(clip.fileSizeBytes) / (1024 * 1024)).toFixed(1);
        const layoutLabels = {
          vertical_blur: '9:16 Vertical Blur',
          vertical_crop: '9:16 Center Crop',
          square: '1:1 Square',
          landscape: '16:9 Landscape'
        };
        const layoutName = layoutLabels[clip.layout] || clip.layout;

        const captionBadge = clip.captionText ? `
          <div style="font-size: 11px; color: #53fc18; background: rgba(83, 252, 24, 0.08); padding: 4px 6px; border-radius: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeHtml(clip.captionText)}">
            💬 <strong>Hook:</strong> "${escapeHtml(clip.captionText)}"
          </div>
        ` : '';

        card.innerHTML = `
          <div class="clip-card-video-wrap">
            <video controls playsinline preload="metadata" src="${escapeHtml(clip.previewUrl)}"></video>
          </div>
          <div class="clip-card-body">
            <div class="clip-card-title" title="${escapeHtml(clip.title)}">${escapeHtml(clip.title)}</div>
            ${captionBadge}
            <div class="clip-card-meta">
              <span class="dest-badge" style="background: rgba(83, 252, 24, 0.1); color: #53fc18; font-size: 10px; padding: 2px 6px;">${escapeHtml(layoutName)}</span>
              <span>${escapeHtml(clip.durationSeconds)}s • ${escapeHtml(mb)} MB</span>
            </div>
            <div class="clip-card-actions">
              <button type="button" class="btn btn-kick-primary-xs broadcast-clip-btn" data-name="${encodeURIComponent(clip.fileName)}">🔴 Broadcast to Kick</button>
              <a href="${escapeHtml(clip.downloadUrl)}" download class="btn btn-secondary-xs" style="text-decoration:none; text-align:center;">Download</a>
              <button type="button" class="btn btn-danger-sm del-clip-btn" data-id="${escapeHtml(clip.id)}">Delete</button>
            </div>
          </div>
        `;
        clipsGalleryGrid.appendChild(card);
      });

      document.querySelectorAll('.broadcast-clip-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const fileName = decodeURIComponent(btn.getAttribute('data-name'));
          switchAndBroadcastFile(fileName);
        });
      });

      document.querySelectorAll('.del-clip-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const id = btn.getAttribute('data-id');
          if (confirm('Delete this clip?')) {
            await fetch(`/api/clips/${id}`, { method: 'DELETE' });
            loadClipsList();
          }
        });
      });
    } catch (_) {}
  }

  // --- INITIALIZE STUDIO ---
  connectWebSocket();
  checkActiveSession();
  loadKickSettings();
})();
