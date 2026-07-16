#!/usr/bin/env node
// Pair this desktop Farnsworth to a farnsworth.tv account (RFC 8628).
// ----------------------------------------------------------------------------
// Requests a device code, shows it, polls until you approve it at
// app.farnsworth.tv/link, then stores the returned device token in the macOS
// Keychain. The launcher reads that token on next start and connects with your
// account identity (userId routing) instead of the shared relay secret.
//
//   node src/pair-device.js
//
// Env overrides: FARNSWORTH_API, FARNSWORTH_DEVICE_KEYCHAIN.
// ----------------------------------------------------------------------------

const os = require('node:os');
const { execFileSync } = require('node:child_process');

const API = process.env.FARNSWORTH_API || 'https://api.farnsworth.tv';
const KEYCHAIN_SERVICE = process.env.FARNSWORTH_DEVICE_KEYCHAIN || 'farnsworth-device-token';

function platformName() {
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'win32') return 'windows';
  return 'linux';
}

async function postJson(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function main() {
  const code = await postJson('/api/device/code', {
    name: os.hostname(),
    platform: platformName(),
  });
  if (!code.user_code) throw new Error('no user_code from server');

  console.log('\n  ┌─ Pair this device ───────────────────────────────');
  console.log(`  │  1. Open  ${code.verification_uri}`);
  console.log(`  │  2. Sign in, then enter this code:`);
  console.log(`  │`);
  console.log(`  │        ${code.user_code}`);
  console.log(`  │`);
  console.log(`  │  (shortcut: ${code.verification_uri_complete})`);
  console.log('  └──────────────────────────────────────────────────\n');
  process.stdout.write('  waiting for approval');

  const deadline = Date.now() + (code.expires_in || 600) * 1000;
  const interval = (code.interval || 5) * 1000;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval));
    const t = await postJson('/api/device/token', { device_code: code.device_code });

    if (t.status === 'pending') { process.stdout.write('.'); continue; }
    if (t.status === 'approved' && t.token) {
      execFileSync('security', [
        'add-generic-password', '-U',
        '-s', KEYCHAIN_SERVICE,
        '-a', t.instanceId,
        '-w', t.token,
      ]);
      console.log(`\n\n  ✓ Paired.  instance ${t.instanceId}`);
      console.log(`  ✓ Device token stored in Keychain (${KEYCHAIN_SERVICE}).`);
      console.log('  → Relaunch Farnsworth to connect with your account.\n');
      return;
    }
    console.log(`\n\n  ✗ Pairing ${t.status || 'failed'}. Run pairing again.\n`);
    return;
  }
  console.log('\n\n  ✗ Code expired before approval. Run pairing again.\n');
}

main().catch((e) => { console.error('\n  pairing error:', e.message, '\n'); process.exit(1); });
