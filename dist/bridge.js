/**
 * Stdio ↔ HTTP bridge.
 *
 * Reads newline-delimited JSON-RPC frames on stdin (single messages or batches),
 * forwards them to the GIL MCP Streamable HTTP endpoint, and writes responses to
 * stdout. The GET notification stream is not opened: the GIL server sends no
 * server-initiated messages.
 *
 * Token resolution order, per request:
 *   1. GIL_API_KEY env var (legacy bearer)
 *   2. ~/.gil/credentials.json (OAuth, auto-refreshed — access tokens live 1h)
 *
 * If neither is available at startup, prints a helpful error and exits.
 */
import { createInterface } from 'node:readline';
import { getBaseUrl, getValidAccessToken } from './credentials.js';
const PROTOCOL_VERSION = '2025-03-26';
/** Issued by the server on `initialize`, echoed on every later request. */
let sessionId = null;
async function resolveToken(rejected) {
    const fromEnv = process.env.GIL_API_KEY;
    if (fromEnv)
        return fromEnv;
    return getValidAccessToken(rejected);
}
export async function runBridge() {
    const baseUrl = getBaseUrl();
    const token = await resolveToken();
    if (!token) {
        process.stderr.write(`No credentials available.\n\n` +
            `Run 'gil-mcp login' to log in via OAuth, or set GIL_API_KEY=gil_xxx in your environment.\n` +
            `Get an API key at: ${baseUrl}/help/mcp-server\n`);
        process.exit(1);
    }
    const rl = createInterface({ input: process.stdin, terminal: false });
    const inFlight = new Set();
    rl.on('line', (line) => {
        const p = handleLine(line.trim(), baseUrl).finally(() => inFlight.delete(p));
        inFlight.add(p);
    });
    // Answer what is still in flight before exiting: a client that writes its
    // requests and closes stdin (`echo … | gil-mcp`) still gets its responses.
    rl.on('close', async () => {
        await Promise.allSettled([...inFlight]);
        process.exit(0);
    });
    process.stderr.write(`gil-mcp bridge ready. Forwarding to ${baseUrl}/api/mcp\n`);
}
/** The ids of the requests in a frame, so a transport failure can answer each one. */
function requestIds(frame) {
    const messages = Array.isArray(frame) ? frame : [frame];
    return messages
        .map((m) => m?.id)
        .filter((id) => typeof id === 'string' || typeof id === 'number');
}
function writeError(ids, message, batch) {
    if (ids.length === 0)
        return;
    const errors = ids.map((id) => ({ jsonrpc: '2.0', id, error: { code: -32603, message } }));
    process.stdout.write(JSON.stringify(batch ? errors : errors[0]) + '\n');
}
/** One frame per line: re-serialized, since a pretty-printed body would span several. */
function writeFrame(json) {
    process.stdout.write(JSON.stringify(JSON.parse(json)) + '\n');
}
async function post(baseUrl, token, body) {
    const headers = {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${token}`,
        'MCP-Protocol-Version': PROTOCOL_VERSION,
    };
    if (sessionId)
        headers['Mcp-Session-Id'] = sessionId;
    return fetch(`${baseUrl}/api/mcp`, { method: 'POST', headers, body });
}
/** The JSON-RPC messages in an SSE body: one per `data:` event. */
function sseMessages(text) {
    return text
        .split(/\r?\n\r?\n/)
        .map((event) => event
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).replace(/^ /, ''))
        .join('\n'))
        .filter(Boolean);
}
async function handleLine(line, baseUrl) {
    if (!line)
        return;
    let parsed;
    try {
        parsed = JSON.parse(line);
    }
    catch (err) {
        process.stderr.write(`Bridge: dropped invalid JSON frame: ${err instanceof Error ? err.message : err}\n`);
        return;
    }
    // Notifications (no id) don't need a response — but we still forward.
    const ids = requestIds(parsed);
    const batch = Array.isArray(parsed);
    try {
        let token = await resolveToken();
        if (!token) {
            writeError(ids, `Not signed in to the Game Industry Library — run 'gil-mcp login'.`, batch);
            return;
        }
        let res = await post(baseUrl, token, line);
        // An OAuth access token expired or was revoked early: refresh once and retry.
        // A 403 is not retried — that is the Pro paywall, and its body says so.
        if (res.status === 401 && !process.env.GIL_API_KEY) {
            token = await resolveToken(token);
            if (!token) {
                writeError(ids, `Game Industry Library session expired — run 'gil-mcp login' again.`, batch);
                return;
            }
            res = await post(baseUrl, token, line);
        }
        const issued = res.headers.get('mcp-session-id');
        if (issued)
            sessionId = issued;
        // 202 = notification accepted, no body
        if (res.status === 202)
            return;
        const text = await res.text();
        const type = res.headers.get('content-type') ?? '';
        if (type.includes('text/event-stream')) {
            for (const message of sseMessages(text))
                writeFrame(message);
            return;
        }
        // Only JSON-RPC may reach stdout. A proxy's HTML error page would corrupt the
        // client's stream, so anything else becomes an error for each request.
        if (!type.includes('application/json')) {
            writeError(ids, `Server returned HTTP ${res.status} (${type || 'no content type'})`, batch);
            return;
        }
        if (!text)
            return;
        // Pass through whatever the server responded with — including the JSON-RPC
        // errors for the paywall (403) and the fair-use limits (429).
        writeFrame(text);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Bridge: HTTP error: ${msg}\n`);
        // Synthesize a JSON-RPC error so the client doesn't hang on a missing response
        writeError(ids, `Bridge transport error: ${msg}`, batch);
    }
}
