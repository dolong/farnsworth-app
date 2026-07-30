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
//
// The flow itself lives in ./device-pairing.js, shared with the in-app
// Settings → Account panel, so both paths mint and store tokens identically.
// This file is just the terminal presentation of it.
// ----------------------------------------------------------------------------

const { runDeviceFlow, KEYCHAIN_SERVICE } = require('./device-pairing');

async function main() {
  const result = await runDeviceFlow({
    onCode: (code) => {
      console.log('\n  ┌─ Pair this device ───────────────────────────────');
      console.log(`  │  1. Open  ${code.verificationUri}`);
      console.log('  │  2. Sign in, then enter this code:');
      console.log('  │');
      console.log(`  │        ${code.userCode}`);
      console.log('  │');
      console.log(`  │  (shortcut: ${code.verificationUriComplete})`);
      console.log('  └──────────────────────────────────────────────────\n');
      process.stdout.write('  waiting for approval…\n');
    },
  });

  if (result.status === 'approved') {
    console.log(`\n  ✓ Paired.  instance ${result.instanceId}`);
    console.log(`  ✓ Device token stored in Keychain (${KEYCHAIN_SERVICE}).`);
    console.log('  → Relaunch Farnsworth to connect with your account.\n');
    return;
  }
  if (result.status === 'expired') {
    console.log('\n  ✗ Code expired before approval. Run pairing again.\n');
    return;
  }
  console.log(`\n  ✗ Pairing ${result.status}. Run pairing again.\n`);
  process.exitCode = 1;
}

main().catch((e) => {
  console.error('\n  pairing error:', e.message, '\n');
  process.exit(1);
});
