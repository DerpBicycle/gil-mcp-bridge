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
import { hostname } from 'node:os';
import { saveCredentials, getBaseUrl } from './credentials.js';
const LOOPBACK_PORT = 33418;
const REDIRECT_URI = `http://127.0.0.1:${LOOPBACK_PORT}/cb`;
function pkcePair() {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    return { verifier, challenge };
}
/** The Game Industry Library mark (the site's icon.svg, also in assets/logo.svg). */
const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="48" height="48" aria-hidden="true"><rect width="32" height="32" rx="7" fill="#021e31"/><rect x="4.25" y="10" width="5" height="15" rx="1.2" fill="#f9fafb"/><rect x="11.75" y="6" width="5" height="19" rx="1.2" fill="#34d399"/><rect x="19.75" y="12" width="5" height="13" rx="1.2" fill="#f9fafb" transform="rotate(14 19.75 25)"/></svg>`;
function escapeHtml(text) {
    return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
/** The page the browser lands on after the consent screen. `body` is trusted HTML. */
function callbackPage(title, body) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · Game Industry Library</title>
<style>
:root{color-scheme:light dark;--bg:#f9fafb;--fg:#001122;--muted:#435662;--accent:#059669}
@media (prefers-color-scheme:dark){:root{--bg:#001122;--fg:#f9fafb;--muted:#95a2a9;--accent:#34d399}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,sans-serif}
main{max-width:520px;margin:12vh auto;padding:0 16px}
.brand{display:flex;align-items:center;gap:12px;font-weight:600;letter-spacing:-.01em;font-size:18px}
.brand span{color:var(--accent)}
h1{font-size:24px;margin:32px 0 8px}
p{color:var(--muted);margin:0 0 12px}
a{color:var(--accent)}
</style></head><body><main>
<div class="brand">${LOGO_SVG}<div>Game Industry <span>Library</span></div></div>
<h1>${escapeHtml(title)}</h1>
${body}
</main></body></html>`;
}
function openBrowser(url) {
    // `start` is a cmd.exe builtin, not a program; its first quoted argument is a window title.
    const [cmd, args] = process.platform === 'darwin'
        ? ['open', [url]]
        : process.platform === 'win32'
            ? ['cmd', ['/c', 'start', '""', url]]
            : ['xdg-open', [url]];
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => { }); // no browser opener — the URL is printed anyway
    child.unref();
}
async function registerClient(baseUrl) {
    const res = await fetch(`${baseUrl}/oauth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            client_name: `gil-mcp-bridge on ${hostname()}`,
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
        // Settles the promise once and frees the port and the timer, so the process
        // exits as soon as login is done instead of waiting out the timeout.
        const finish = (err, result) => {
            clearTimeout(timeout);
            server.close();
            if (err)
                reject(err);
            else
                resolve(result);
        };
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
                // The server explains a refusal here — e.g. that MCP needs a Pro subscription.
                const description = url.searchParams.get('error_description');
                const reason = description ? `${description} (${error})` : error;
                res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(callbackPage('Authorization failed', `<p>${escapeHtml(reason)}</p><p>You can close this tab.</p>`));
                finish(new Error(`OAuth error: ${reason}`));
                return;
            }
            if (!code || !state) {
                res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(callbackPage('Missing code or state', '<p>You can close this tab and try again.</p>'));
                finish(new Error('Missing code or state in callback'));
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(callbackPage('Connected', '<p>You can close this tab and return to your terminal.</p>'));
            finish(null, { code, state });
        });
        server.on('error', (err) => finish(err));
        server.listen(LOOPBACK_PORT, '127.0.0.1');
        const timeout = setTimeout(() => {
            finish(new Error('OAuth flow timed out — no redirect received within 5 minutes'));
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
    process.stderr.write(`Tool calls need a Game Industry Library Pro subscription: ${baseUrl}/subscribe\n`);
}
