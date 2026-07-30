// Device pairing (RFC 8628) — shared by the CLI script and the in-app
// Settings → Account panel.
// ----------------------------------------------------------------------------
// Farnsworth's desktop never "logs in". It PAIRS: the account approves this
// device once at app.farnsworth.tv/link, the API mints a long-lived device
// token carrying { userId, instanceId }, and that token lives in the macOS
// Keychain. relay-client.js presents it verbatim and the relay routes by
// userId.
//
// Before this module the only pairing surface was `node src/pair-device.js`
// from a terminal. This module extracts the flow so main.js can drive it from
// the UI, and so both paths mint tokens identically.
//
// Everything here is async and timeout-guarded on purpose: `security` blocks
// indefinitely on a locked Keychain waiting for a prompt, and doing that
// synchronously would freeze the whole main process (and every window with
// it). See [[long-mac-mini]] § Keychain locks on screen sleep.
// ----------------------------------------------------------------------------

const os = require('node:os');
const { execFile } = require('node:child_process');

const API = process.env.FARNSWORTH_API || 'https://api.farnsworth.tv';
const KEYCHAIN_SERVICE =
  process.env.FARNSWORTH_DEVICE_KEYCHAIN || 'farnsworth-device-token';

// `security` hangs forever on a locked Keychain. Cap it so a locked Mac
// degrades to "can't read the token" instead of wedging the process.
const SECURITY_TIMEOUT_MS = 10_000;

function platformName() {
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'win32') return 'windows';
  return 'linux';
}

function security(args, { timeout = SECURITY_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    execFile('security', args, { timeout }, (err, stdout, stderr) => {
      if (err) {
        resolve({
          ok: false,
          // execFile sets `killed` when the timeout fired. That is the locked
          // -Keychain signature, and it is worth distinguishing from "no such
          // item" so the UI can say something true.
          timedOut: Boolean(err.killed),
          error: (stderr || err.message || '').trim(),
        });
        return;
      }
      resolve({ ok: true, stdout: String(stdout || '') });
    });
  });
}

async function postJson(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

// Decode a JWT payload without verifying. We only use this to display which
// account/instance a stored token belongs to — the relay is what actually
// validates it.
function decodeTokenClaims(token) {
  try {
    const part = String(token).split('.')[1];
    if (!part) return null;
    const json = Buffer.from(
      part.replace(/-/g, '+').replace(/_/g, '/'),
      'base64'
    ).toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// --- Keychain -------------------------------------------------------------

async function readStoredToken() {
  // -g writes the attributes to stderr and the password to stderr too, so use
  // -w which prints just the secret on stdout.
  const r = await security(['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w']);
  if (!r.ok) {
    return {
      token: null,
      locked: r.timedOut,
      // "could not be found" is the normal unpaired case, not an error worth
      // surfacing as a failure.
      error: r.timedOut ? 'keychain-locked' : null,
    };
  }
  const token = r.stdout.trim();
  return { token: token || null, locked: false, error: null };
}

async function writeStoredToken(instanceId, token) {
  const r = await security([
    'add-generic-password',
    '-U',
    '-s', KEYCHAIN_SERVICE,
    '-a', instanceId,
    '-w', token,
  ]);
  if (!r.ok) {
    throw new Error(
      r.timedOut
        ? 'Keychain is locked — unlock the Mac and try pairing again.'
        : `Could not write to Keychain: ${r.error}`
    );
  }
}

async function deleteStoredToken() {
  const r = await security(['delete-generic-password', '-s', KEYCHAIN_SERVICE]);
  // Deleting something that isn't there is a success from the caller's view.
  if (!r.ok && r.timedOut) {
    throw new Error('Keychain is locked — unlock the Mac and try again.');
  }
  return true;
}

/**
 * Current pairing state, for the Settings → Account panel.
 * Never throws: a locked Keychain is a reportable state, not a crash.
 */
async function pairingStatus() {
  const { token, locked } = await readStoredToken();
  if (locked) {
    return { paired: false, locked: true, api: API, hostname: os.hostname() };
  }
  if (!token) {
    return { paired: false, locked: false, api: API, hostname: os.hostname() };
  }
  const claims = decodeTokenClaims(token) || {};
  return {
    paired: true,
    locked: false,
    api: API,
    hostname: os.hostname(),
    userId: claims.userId || claims.sub || null,
    instanceId: claims.instanceId || null,
    // exp is seconds since epoch in a JWT.
    expiresAt: claims.exp ? claims.exp * 1000 : null,
  };
}

/**
 * Run the device-code flow.
 *
 * `onCode` fires as soon as the user code exists so the UI can display it
 * while we poll. Returns the pairing result. Polling stops when `signal`
 * aborts, the code is approved, the server rejects, or the code expires.
 */
async function runDeviceFlow({ onCode, signal } = {}) {
  const code = await postJson('/api/device/code', {
    name: os.hostname(),
    platform: platformName(),
  });
  if (!code.user_code) throw new Error('The pairing server did not return a code.');

  if (typeof onCode === 'function') {
    onCode({
      userCode: code.user_code,
      verificationUri: code.verification_uri,
      verificationUriComplete: code.verification_uri_complete,
      expiresIn: code.expires_in || 600,
    });
  }

  const deadline = Date.now() + (code.expires_in || 600) * 1000;
  const intervalMs = (code.interval || 5) * 1000;

  while (Date.now() < deadline) {
    if (signal?.aborted) return { status: 'cancelled' };
    await new Promise((r) => setTimeout(r, intervalMs));
    if (signal?.aborted) return { status: 'cancelled' };

    const t = await postJson('/api/device/token', { device_code: code.device_code });
    if (t.status === 'pending') continue;

    if (t.status === 'approved' && t.token) {
      await writeStoredToken(t.instanceId, t.token);
      return { status: 'approved', instanceId: t.instanceId, token: t.token };
    }
    return { status: t.status || 'failed' };
  }
  return { status: 'expired' };
}

module.exports = {
  API,
  KEYCHAIN_SERVICE,
  platformName,
  pairingStatus,
  readStoredToken,
  deleteStoredToken,
  runDeviceFlow,
  decodeTokenClaims,
};
