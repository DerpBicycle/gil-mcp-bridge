/**
 * Stdio ↔ HTTP bridge.
 *
 * Reads newline-delimited JSON-RPC frames on stdin, forwards them to the GIL
 * MCP HTTP endpoint, and writes responses to stdout. Server-initiated SSE
 * notifications are not supported (the GIL server doesn't emit them).
 *
 * Token resolution order:
 *   1. GIL_API_KEY env var (legacy bearer)
 *   2. ~/.gil/credentials.json (OAuth, auto-refreshed)
 *
 * If neither is available, prints a helpful error and exits.
 */
import { createInterface } from 'node:readline';
import { getBaseUrl, getValidAccessToken } from './credentials.js';
async function resolveToken() {
    const fromEnv = process.env.GIL_API_KEY;
    if (fromEnv)
        return fromEnv;
    return getValidAccessToken();
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
    rl.on('line', (line) => {
        void handleLine(line.trim(), baseUrl, token);
    });
    rl.on('close', () => {
        process.exit(0);
    });
    process.stderr.write(`gil-mcp bridge ready. Forwarding to ${baseUrl}/api/mcp\n`);
}
async function handleLine(line, baseUrl, token) {
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
    const id = parsed?.id;
    try {
        const res = await fetch(`${baseUrl}/api/mcp`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`,
            },
            body: line,
        });
        // 202 = notification accepted, no body
        if (res.status === 202)
            return;
        const text = await res.text();
        if (!text)
            return;
        // Pass through whatever the server responded with.
        process.stdout.write(text);
        if (!text.endsWith('\n'))
            process.stdout.write('\n');
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Bridge: HTTP error: ${msg}\n`);
        if (id !== undefined && id !== null) {
            // Synthesize a JSON-RPC error so the client doesn't hang on a missing response
            const errorResponse = {
                jsonrpc: '2.0',
                id,
                error: { code: -32603, message: `Bridge transport error: ${msg}` },
            };
            process.stdout.write(JSON.stringify(errorResponse) + '\n');
        }
    }
}
