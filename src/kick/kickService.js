const db = require('../db/database');
const { maskStreamKey } = require('../security/crypto');

class KickService {
  /**
   * Returns Kick integration status and connected accounts.
   */
  getIntegrationStatus() {
    const accounts = db.getKickAccounts(true);
    return {
      connected: accounts.length > 0,
      accountsCount: accounts.length,
      primaryAccount: accounts.length > 0 ? accounts[0] : null,
      accounts,
      defaultRtmpEndpoint: 'rtmps://fa723fc1b171.global-contribute.live-video.net/app/'
    };
  }

  /**
   * Connects a Kick channel account manually or via OAuth.
   */
  async connectAccount({ kickUsername, channelSlug, streamKey, rtmpUrl }) {
    if (!kickUsername || !streamKey) {
      throw new Error('Kick username and stream key are required.');
    }

    // Normalize RTMP URL
    let base = (rtmpUrl || 'rtmps://fa723fc1b171.global-contribute.live-video.net/app/').trim();
    base = base.replace(/\/+$/, '');
    if (!base.endsWith('/app')) {
      base += '/app';
    }
    base += '/';

    const account = db.saveKickAccount({
      kickUsername: kickUsername.trim(),
      channelSlug: (channelSlug || kickUsername).trim().toLowerCase(),
      streamKey: streamKey.trim(),
      rtmpUrl: base
    });

    return {
      success: true,
      message: `Kick account @${account.kickUsername} connected successfully.`,
      account
    };
  }

  /**
   * Removes a connected Kick account.
   */
  disconnectAccount(accountId) {
    return db.deleteKickAccount(accountId);
  }

  /**
   * Resolves the full RTMP destination URL with decrypted stream key for internal FFmpeg ingestion.
   * This decrypted key is strictly used in internal worker processes and NEVER returned to the client.
   */
  getBroadcastingCredentials(accountId) {
    let account = null;
    if (accountId) {
      account = db.getKickAccountById(accountId, true);
    } else {
      const all = db.data.kickAccounts;
      if (all.length > 0) {
        account = db.getKickAccountById(all[0].id, true);
      }
    }

    if (!account || !account.plainStreamKey) {
      throw new Error('No connected Kick account found. Please connect your Kick account in Settings.');
    }

    let rtmpBase = account.rtmpUrl || 'rtmps://fa723fc1b171.global-contribute.live-video.net/app/';
    if (!rtmpBase.endsWith('/')) rtmpBase += '/';

    return {
      accountId: account.id,
      kickUsername: account.kickUsername,
      channelSlug: account.channelSlug,
      rtmpBase,
      plainStreamKey: account.plainStreamKey,
      fullDestinationUrl: `${rtmpBase}${account.plainStreamKey}`,
      maskedDestination: `${rtmpBase}${maskStreamKey(account.plainStreamKey)}`
    };
  }

  /**
   * Generates Kick OAuth 2.0 Authorization URL for official Kick API connection.
   */
  getOAuthUrl() {
    const clientId = process.env.KICK_CLIENT_ID || 'kick_client_id_placeholder';
    const redirectUri = encodeURIComponent(process.env.KICK_REDIRECT_URI || 'http://localhost:3000/api/kick/callback');
    const scope = encodeURIComponent('channel:read streamkey:read');
    return `https://id.kick.com/oauth/authorize?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code&scope=${scope}`;
  }
}

module.exports = new KickService();
