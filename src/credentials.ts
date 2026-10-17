/**
 * Credential storage and refresh.
 *
 * Tokens stored in ~/.gil/credentials.json with mode 0600 (user-only).
 * Format:
 *   {
 *     access_token: "gil_at_...",
 *     refresh_token: "gil_rt_...",
 *     expires_at: 1234567890,   // unix seconds
 *     client_id: "gil_client_...",
 *     base_url: "https://..."
 *   }
 */

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DIR = join(homedir(), '.gil');
const FILE = join(DIR, 'credentials.json');

export interface Credentials {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  client_id: string;
  base_url: string;
}

export function getBaseUrl(): string {
  return process.env.GIL_BASE_URL || 'https://gameindustrylibrary.com';
}

export async function loadCredentials(): Promise<Credentials | null> {
  try {
    const raw = await fs.readFile(FILE, 'utf8');
    return JSON.parse(raw) as Credentials;
  } catch {
    return null;
  }
}

export async function saveCredentials(creds: Credentials): Promise<void> {
  await fs.mkdir(DIR, { recursive: true, mode: 0o700 });
  await fs.writeFile(FILE, JSON.stringify(creds, null, 2), { mode: 0o600 });
}

export async function deleteCredentials(): Promise<void> {
  try {
    await fs.unlink(FILE);
  } catch {
    // Already gone — fine.
  }
}

/**
 * Refresh an access token using the stored refresh_token.
 * Returns the new credentials, or null if refresh failed (token expired/revoked).
 */
export async function refreshAccessToken(creds: Credentials): Promise<Credentials | null> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: creds.refresh_token,
    client_id: creds.client_id,
  });

  const res = await fetch(`${creds.base_url}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) return null;

  const json = await res.json() as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  const updated: Credentials = {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + json.expires_in,
    client_id: creds.client_id,
    base_url: creds.base_url,
  };
  await saveCredentials(updated);
  return updated;
}

/**
 * Refreshes in flight, so concurrent requests share one. The server rotates the
 * refresh token on every use: a second refresh with the same token would fail
 * and, worse, the first one's new pair would already have revoked it.
 */
let refreshing: Promise<Credentials | null> | null = null;

function refreshOnce(creds: Credentials): Promise<Credentials | null> {
  refreshing ??= refreshAccessToken(creds).finally(() => {
    refreshing = null;
  });
  return refreshing;
}

/**
 * Get a valid access token, refreshing if needed. `rejected` is a token the server
 * just answered with 401 (revoked before its expiry): it is refreshed unless the
 * stored token has already moved on, e.g. by a concurrent request's refresh.
 * Returns null if no credentials are stored or refresh failed.
 */
export async function getValidAccessToken(rejected?: string): Promise<string | null> {
  if (refreshing) return (await refreshing)?.access_token ?? null;

  const creds = await loadCredentials();
  if (!creds) return null;

  const now = Math.floor(Date.now() / 1000);
  const skew = 60; // refresh 60s before expiry to avoid clock skew issues
  const stale = rejected !== undefined && creds.access_token === rejected;
  if (!stale && creds.expires_at > now + skew) {
    return creds.access_token;
  }

  const refreshed = await refreshOnce(creds);
  return refreshed?.access_token ?? null;
}

export async function statusCommand(): Promise<void> {
  const creds = await loadCredentials();
  if (!creds) {
    process.stderr.write(`No credentials stored. Run 'gil-mcp login' or set GIL_API_KEY.\n`);
    if (process.env.GIL_API_KEY) {
      process.stderr.write(`(GIL_API_KEY is set — that will be used.)\n`);
    }
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  const expiresIn = creds.expires_at - now;
  const expiresMsg = expiresIn > 0 ? `expires in ${expiresIn}s` : `EXPIRED ${-expiresIn}s ago — will auto-refresh`;
  process.stderr.write(
    `Credentials stored at ${FILE}\n` +
      `  base_url:      ${creds.base_url}\n` +
      `  client_id:     ${creds.client_id}\n` +
      `  access_token:  ${creds.access_token.slice(0, 14)}... (${expiresMsg})\n` +
      `  refresh_token: ${creds.refresh_token.slice(0, 14)}...\n`,
  );
}

/**
 * RFC 7009 revocation, best effort: logging out must work offline too, so a
 * failure only means the server-side tokens expire on their own (1h / 30d).
 */
async function revokeToken(baseUrl: string, token: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/oauth/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function logoutCommand(): Promise<void> {
  const creds = await loadCredentials();
  if (creds) {
    const revoked = await Promise.all([
      revokeToken(creds.base_url, creds.refresh_token),
      revokeToken(creds.base_url, creds.access_token),
    ]);
    if (!revoked.every(Boolean)) {
      process.stderr.write(`Could not reach ${creds.base_url} to revoke the tokens — they expire on their own.\n`);
    }
  }
  await deleteCredentials();
  if (creds) {
    process.stderr.write(`Credentials removed.\n`);
  } else {
    process.stderr.write(`No credentials to remove.\n`);
  }
}
