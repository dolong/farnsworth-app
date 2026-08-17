// Farnsworth Relay Client — outbound WS to farnsworth-relay (CommonJS)
// ============================================================================
// Opens a persistent WebSocket connection from the Farnsworth main process
// to a farnsworth-relay instance. Routes:
//   - outgoing chat (from renderer chat composer → relay → companions)
//   - incoming chat (from companion → relay → renderer chat composer)
//   - canvas state (future)
// Auth: HS256 JWT signed with RELAY_JWT_SECRET. Sub includes a stable
// machine id so the relay can replace the old connection on restart.
//
// Env / config:
//   RELAY_URL          (default: ws://localhost:7778/api/v1/ws)
//   RELAY_JWT_SECRET   (default: dev-secret)  -- shared with relay
//   RELAY_TENANT_ID    (default: 'default')
//   RELAY_DISABLED     (default: unset)       -- set to '1' to skip
// ============================================================================

const { WebSocket } = require('ws');
const os = require('node:os');
const crypto = require('node:crypto');

// ----- Minimal HS256 JWT (no jsonwebtoken dep) -----
function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function signJwt(payload, secret) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const claims = { iat: now, exp: now + 3600, ...payload };
  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify(claims));
  const sig = b64url(crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest());
  return `${h}.${p}.${sig}`;
}

// Default to the live relay, not localhost. RELAY_URL is exported by the
// /Applications wrapper script, but that is only ONE of the ways this app
// starts -- a dev-tree launch, or a second instance started with
// --instance=<name>, inherits no wrapper env at all and would silently dial a
// local relay that isn't running. It reconnects forever, never reaches the
// account, and never appears in the companion picker.
//
// Local relay development now opts IN by exporting RELAY_URL explicitly.
const RELAY_URL = process.env.RELAY_URL || 'wss://relay.farnsworth.tv/api/v1/ws';
const RELAY_JWT_SECRET = process.env.RELAY_JWT_SECRET || 'dev-secret';
const RELAY_TENANT_ID = process.env.RELAY_TENANT_ID || 'default';
// A paired desktop presents a long-lived device token (minted by
// api.farnsworth.tv, carries userId + instanceId). When present it supersedes
// the shared-secret self-signing path below.
const RELAY_DEVICE_TOKEN = process.env.RELAY_DEVICE_TOKEN || null;
const MACHINE_ID_HASH = crypto
  .createHash('sha256')
  .update(os.hostname() + (os.userInfo()?.username || ''))
  .digest('hex')
  .slice(0, 8);
// Instance name, set by main.js from --instance=<name> before this module is
// required. Machine identity alone is not enough any more: two Farnsworths can
// run on one Mac and the companion has to tell them apart.
const INSTANCE_NAME = String(process.env.FARNSWORTH_INSTANCE || 'default')
  .trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32) || 'default';
const IS_DEFAULT_INSTANCE = INSTANCE_NAME === 'default';

// The default instance keeps its historic sub verbatim so an already-paired
// desktop does not appear as a brand new device after upgrading.
const SUB = IS_DEFAULT_INSTANCE
  ? `farnsworth:${os.hostname()}-${MACHINE_ID_HASH}`
  : `farnsworth:${os.hostname()}-${MACHINE_ID_HASH}:${INSTANCE_NAME}`;

const RECONNECT_BASE_MS = 1000;
// A socket must stay open this long before we trust it enough to clear the
// backoff. See the 'open' handler.
const STABLE_RESET_MS = 15000;
const RECONNECT_MAX_MS = 30000;

class RelayClient {
  constructor(opts = {}) {
    this.url = opts.url || RELAY_URL;
    this.secret = opts.secret || RELAY_JWT_SECRET;
    this.tenantId = opts.tenantId || RELAY_TENANT_ID;
    this.sub = opts.sub || SUB;
    this.instanceName = opts.instanceName || INSTANCE_NAME;
    this.deviceToken = opts.deviceToken || RELAY_DEVICE_TOKEN;
    this.ws = null;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.stableTimer = null;
    this.stopped = false;
    this.handlers = new Map(); // type → [fn]
    this.statusListeners = new Set();
    this._status = 'idle'; // idle | connecting | connected | disconnected
  }

  token() {
    // Paired: present the account-scoped device token as-is (userId routing).
    // Unpaired: self-sign a short-lived token with the shared relay secret
    // (v1 tenantId routing) so an un-paired desktop still works.
    if (this.deviceToken) return this.deviceToken;
    return signJwt(
      { sub: this.sub, role: 'farnsworth', tenantId: this.tenantId },
      this.secret
    );
  }

  get paired() { return !!this.deviceToken; }

  /**
   * Swap the device token at runtime and reconnect with the new identity.
   *
   * Pairing from Settings → Account would otherwise need an app relaunch,
   * because the token is read from the Keychain by the launcher and handed in
   * as RELAY_DEVICE_TOKEN at process start. Passing null reverts to the
   * unpaired self-signed path.
   *
   * Returns true if a reconnect was actually kicked off.
   */
  applyDeviceToken(token) {
    const next = token || null;
    if (next === this.deviceToken) return false;
    this.deviceToken = next;
    if (this.stopped) return false;
    // Drop the current socket; connect() re-reads token() on the way out.
    this.reconnectAttempt = 0;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      const dying = this.ws;
      // Do NOT null this.ws here -- connect() overwrites it a line later, and
      // the close guard identifies the dying socket by comparison.
      try { dying.close(); } catch { /* already closing */ }
    }
    this.connect();
    return true;
  }

  start() {
    if (process.env.RELAY_DISABLED === '1') {
      console.log('[relay-client] RELAY_DISABLED=1, skipping');
      return;
    }
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close(1000, 'client stop');
      this.ws = null;
    }
    this._setStatus('disconnected');
  }

  connect() {
    if (this.stopped) return;
    this._setStatus('connecting');
    // The device token is minted per DEVICE and lives in one Keychain slot, so
    // every instance on this Mac presents the SAME token. The instance
    // qualifier is what lets the relay tell them apart without re-pairing.
    const qualifier = this.instanceName && this.instanceName !== 'default'
      ? `&instance=${encodeURIComponent(this.instanceName)}`
      : '';
    const url = `${this.url}?token=${this.token()}${qualifier}`;
    console.log(`[relay-client] connecting to ${this.url} (tenant=${this.tenantId})`);

    let ws;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      console.error('[relay-client] failed to create WebSocket:', e.message);
      this._scheduleReconnect();
      return;
    }

    this.ws = ws;

    ws.on('open', () => {
      console.log(`[relay-client] connected as sub=${this.sub} instance=${this.instanceName}`);
      // Do NOT clear the backoff here. The relay evicts any existing socket
      // that presents the same instance id, so two processes sharing one sub
      // (a second app on the machine, or an old build left running) open and
      // close each other about once a second -- forever -- because every
      // 'open' resets the counter back to a 1s delay. Clear it only once the
      // socket has proven it can stay up.
      if (this.stableTimer) clearTimeout(this.stableTimer);
      this.stableTimer = setTimeout(() => {
        this.stableTimer = null;
        this.reconnectAttempt = 0;
      }, STABLE_RESET_MS);
      this._setStatus('connected');
    });

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        console.warn('[relay-client] received invalid JSON');
        return;
      }
      this._dispatch(msg);
    });

    ws.on('close', (code, reason) => {
      // Only the CURRENT socket may drive reconnection.
      //
      // WebSocket.close() is asynchronous, so a socket we deliberately
      // superseded (applyDeviceToken swapping identity, or a racing
      // reconnect) fires its 'close' AFTER its replacement is already live.
      // Without this guard that late event nulled `this.ws` -- clobbering the
      // healthy socket -- and scheduled another connect. That second socket
      // made the relay evict the first as "replaced", whose close scheduled
      // another connect, and so on: a self-sustaining flap that reconnected
      // ~35 times in 45 seconds and never settled.
      if (this.ws !== ws) {
        console.log(`[relay-client] stale socket closed (code=${code}) — ignoring`);
        return;
      }
      console.log(`[relay-client] disconnected (code=${code} reason=${reason || ''})`);
      if (this.stableTimer) { clearTimeout(this.stableTimer); this.stableTimer = null; }
      this.ws = null;
      this._setStatus('disconnected');
      this._scheduleReconnect();
    });

    ws.on('error', (err) => {
      if (this.ws !== ws) return; // superseded socket; its close is ignored too
      console.warn(`[relay-client] ws error: ${err.message}`);
      // 'close' fires after, which handles reconnect
    });
  }

  _scheduleReconnect() {
    if (this.stopped) return;
    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempt),
      RECONNECT_MAX_MS
    );
    this.reconnectAttempt++;
    console.log(`[relay-client] reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})`);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  _setStatus(status) {
    if (this._status === status) return;
    this._status = status;
    for (const fn of this.statusListeners) {
      try { fn(status); } catch (e) { console.warn('[relay-client] status listener error:', e.message); }
    }
  }

  _dispatch(msg) {
    const handlers = this.handlers.get(msg.type) || [];
    const wildcard = this.handlers.get('*') || [];
    for (const fn of [...handlers, ...wildcard]) {
      try { fn(msg); } catch (e) { console.warn('[relay-client] handler error:', e.message); }
    }
  }

  // Public API --------------------------------------------------------------

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(fn);
    return () => {
      const arr = this.handlers.get(type) || [];
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    };
  }

  onStatus(fn) {
    this.statusListeners.add(fn);
    fn(this._status);
    return () => this.statusListeners.delete(fn);
  }

  get status() { return this._status; }

  send(msg) {
    if (!this.ws || this.ws.readyState !== 1) {
      console.warn('[relay-client] send dropped: not connected');
      return false;
    }
    this.ws.send(JSON.stringify(msg));
    return true;
  }
}

// Singleton for main.js
let singleton = null;
function getRelayClient() {
  if (!singleton) singleton = new RelayClient();
  return singleton;
}

module.exports = { RelayClient, getRelayClient };