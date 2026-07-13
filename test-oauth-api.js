// One-off test: read the saved OAuth token from the Farnsworth DB, decrypt it
// with safeStorage (Keychain on macOS), and call api.anthropic.com/v1/messages.
// Prints the response status + body. Quits when done.

const { app, safeStorage } = require('electron');
const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');

app.whenReady().then(async () => {
  const dbPath = path.join(
    os.homedir(),
    'Library/Application Support/Farnsworth/farnsworth/farnsworth.db'
  );
  console.log('--- Farnsworth OAuth API test ---');
  console.log('DB:', dbPath);
  console.log('Encryption available:', safeStorage.isEncryptionAvailable());

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });

  const row = db.prepare(`
    SELECT access_token_encrypted, refresh_token_encrypted, expires_at, account_info
    FROM auth_tokens WHERE provider = ?
  `).get('anthropic-claudeai');

  if (!row) {
    console.log('No OAuth token for anthropic-claudeai. Sign in first.');
    db.close();
    app.quit();
    return;
  }

  console.log('expires_at:', row.expires_at);
  console.log('account_info:', row.account_info);

  const expiresAt = new Date(row.expires_at).getTime();
  const now = Date.now();
  const expired = expiresAt && expiresAt < now;
  console.log('expired:', expired, `(now=${new Date(now).toISOString()})`);

  let accessToken;
  try {
    accessToken = safeStorage.decryptString(row.access_token_encrypted);
  } catch (e) {
    console.log('decrypt failed:', e.message);
    db.close();
    app.quit();
    return;
  }
  console.log('token length:', accessToken.length);
  console.log('token prefix:', accessToken.slice(0, 24) + '…');

  // Try to refresh if expired and we have a refresh token
  if (expired && row.refresh_token_encrypted) {
    console.log('Token expired; attempting refresh…');
    try {
      const refreshToken = safeStorage.decryptString(row.refresh_token_encrypted);
      const params = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
      });
      const refreshRes = await fetch('https://platform.claude.com/v1/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });
      console.log('refresh status:', refreshRes.status);
      if (refreshRes.ok) {
        const data = await refreshRes.json();
        accessToken = data.access_token;
        console.log('refresh OK, new token prefix:', accessToken.slice(0, 24) + '…');
      } else {
        const body = await refreshRes.text();
        console.log('refresh body:', body.slice(0, 300));
      }
    } catch (e) {
      console.log('refresh failed:', e.message);
    }
  }

  // Test API call
  console.log('\n--- POST /v1/messages ---');
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20,claude-code-20250219,interleaved-thinking-2025-05-14',
      },
      body: JSON.stringify({
        model: 'claude-3-5-haiku-20241022',
        max_tokens: 40,
        messages: [{ role: 'user', content: 'Reply with just "pong". Nothing else.' }],
      }),
    });
    console.log('status:', res.status);
    console.log('request-id:', res.headers.get('request-id'));
    console.log('anthropic-organization-id:', res.headers.get('anthropic-organization-id'));
    const body = await res.text();
    console.log('body:', body);
  } catch (e) {
    console.log('API call failed:', e.message);
  }

  db.close();
  app.quit();
});

app.on('window-all-closed', () => app.quit());
// OAuth config audit (Jun 25 18:08 ET) — confirms what the authorize URL should look like.
// Per github.com/anthropics/claude-code/issues/36215, Claude Code's claudeai force-login
// flow uses these exact params:
//   https://claude.ai/oauth/authorize
//     ?code=true
//     &response_type=code
//     &client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e
//     &redirect_uri=http://localhost:PORT/callback  (loopback, dynamic port)
//     &scope=org:create_api_key+user:profile+user:inference+user:sessions:claude_code+user:mcp_servers+user:file_upload
//     &code_challenge=... &code_challenge_method=S256 &state=...
//
// platform.claude.com/oauth/authorize with https://platform.claude.com/oauth/code/callback
// is the WRONG URL — Anthropic's mutationFn returns 400 "Invalid request format".
// The 400 was happening because Farnsworth was hitting the wrong authorize host.
