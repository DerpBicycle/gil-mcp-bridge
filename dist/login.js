/**
 * Interactive OAuth login.
 *
 * Flow:
 *   1. Generate PKCE pair
 *   2. POST /oauth/register to get a client_id
 *   3. Open the user's browser to /oauth/authorize?...redirect_uri=http://127.0.0.1:33418/cb
 *   4. Run a one-shot loopback HTTP server on localhost:33418 to catch the redirect
 *   5. Exchange the code at /oauth/token for access + refresh tokens
 *   6. Save to ~/.gil/credentials.json
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { saveCredentials, getBaseUrl } from './credentials.js';
const LOOPBACK_PORT = 33418;
const REDIRECT_URI = `http://127.0.0.1:${LOOPBACK_PORT}/cb`;
function pkcePair() {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    return { verifier, challenge };
}
function openBrowser(url) {
    const platform = process.platform;
    const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'start' : 'xdg-open';
    const child = spawn(cmd, [url], { detached: true, stdio: 'ignore' });
    child.unref();
}
async function registerClient(baseUrl) {
    const hostname = process.env.HOSTNAME || 'unknown-host';
    const res = await fetch(`${baseUrl}/oauth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            client_name: `gil-mcp on ${hostname}`,
            redirect_uris: [REDIRECT_URI],
        }),
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Client registration failed: ${res.status} ${text}`);
    }
    const json = await res.json();
    return json.client_id;
}
async function awaitRedirect() {
    return new Promise((resolve, reject) => {
        const server = createServer((req, res) => {
            if (!req.url?.startsWith('/cb')) {
                res.writeHead(404).end();
                return;
            }
            const url = new URL(req.url, `http://127.0.0.1:${LOOPBACK_PORT}`);
            const code = url.searchParams.get('code');
            const state = url.searchParams.get('state');
            const error = url.searchParams.get('error');
            if (error) {
                res.writeHead(400, { 'Content-Type': 'text/html' });
                res.end(`<html><body style="font-family:system-ui;padding:2rem"><h1>Authorization failed</h1><p>${error}</p><p>You can close this tab.</p></body></html>`);
                server.close();
                reject(new Error(`OAuth error: ${error}`));
                return;
            }
            if (!code || !state) {
                res.writeHead(400, { 'Content-Type': 'text/html' });
                res.end(`<html><body style="font-family:system-ui;padding:2rem"><h1>Missing code or state</h1></body></html>`);
                server.close();
                reject(new Error('Missing code or state in callback'));
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(`<html><body style="font-family:system-ui;padding:2rem;max-width:560px"><h1>✅ Connected</h1><p>You can close this tab and return to your terminal.</p></body></html>`);
            server.close();
            resolve({ code, state });
        });
        server.on('error', reject);
        server.listen(LOOPBACK_PORT, '127.0.0.1');
        // Timeout after 5 minutes
        setTimeout(() => {
            server.close();
            reject(new Error('OAuth flow timed out — no redirect received within 5 minutes'));
        }, 5 * 60_000);
    });
}
async function exchangeCode(params) {
    const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code: params.code,
        code_verifier: params.verifier,
        client_id: params.clientId,
        redirect_uri: REDIRECT_URI,
    });
    const res = await fetch(`${params.baseUrl}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Token exchange failed: ${res.status} ${text}`);
    }
    return res.json();
}
export async function runLogin() {
    const baseUrl = getBaseUrl();
    process.stderr.write(`Logging in to ${baseUrl}...\n`);
    const { verifier, challenge } = pkcePair();
    const expectedState = randomBytes(16).toString('base64url');
    process.stderr.write(`Registering client...\n`);
    const clientId = await registerClient(baseUrl);
    process.stderr.write(`  client_id: ${clientId}\n`);
    const authorizeUrl = new URL('/oauth/authorize', baseUrl);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('client_id', clientId);
    authorizeUrl.searchParams.set('redirect_uri', REDIRECT_URI);
    authorizeUrl.searchParams.set('scope', 'mcp');
    authorizeUrl.searchParams.set('state', expectedState);
    authorizeUrl.searchParams.set('code_challenge', challenge);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');
    process.stderr.write(`\nOpening your browser to authorize this client.\n`);
    process.stderr.write(`If it doesn't open automatically, visit:\n  ${authorizeUrl}\n\n`);
    openBrowser(authorizeUrl.toString());
    process.stderr.write(`Waiting for authorization (will timeout in 5 minutes)...\n`);
    const { code, state } = await awaitRedirect();
    if (state !== expectedState) {
        throw new Error('State mismatch — possible CSRF attack');
    }
    process.stderr.write(`Authorization received. Exchanging code for tokens...\n`);
    const tokens = await exchangeCode({ baseUrl, code, verifier, clientId });
    const creds = {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: Math.floor(Date.now() / 1000) + tokens.expires_in,
        client_id: clientId,
        base_url: baseUrl,
    };
    await saveCredentials(creds);
    process.stderr.write(`✅ Logged in. Credentials saved to ~/.gil/credentials.json.\n`);
    process.stderr.write(`Run 'gil-mcp' (no args) to start the bridge.\n`);
}
