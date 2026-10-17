<p align="center">
  <img src="assets/logo.svg" alt="Game Industry Library" width="96" height="96">
</p>

# gil-mcp-bridge

Stdio bridge for the **[Game Industry Library](https://gameindustrylibrary.com) MCP server**. Exposes the remote `/api/mcp` endpoint to MCP clients that only run local commands (stdio): older Claude Desktop setups, Cline, Continue, older Cursor versions, custom integrations.

If your client takes a server address (remote MCP over HTTP — the Claude app and claude.ai, ChatGPT, Claude Code, Cursor), connect it directly to `https://gameindustrylibrary.com/api/mcp` instead: it signs in with OAuth and needs no bridge. The guided setup at [/help/mcp-server](https://gameindustrylibrary.com/help/mcp-server) walks you through each client.

> **Requires Game Industry Library Pro.** Anyone can sign in, but tool calls without an active subscription come back as an error that says so. [Subscribe](https://gameindustrylibrary.com/subscribe).

## Install

Run directly from GitHub via `npx` — no install needed:

```bash
npx github:DerpBicycle/gil-mcp-bridge
```

Or pin a specific commit / tag:

```bash
npx github:DerpBicycle/gil-mcp-bridge#v0.2.0
```

Or clone + install:

```bash
git clone https://github.com/DerpBicycle/gil-mcp-bridge
cd gil-mcp-bridge
npm install   # runs prepare → tsc, then dist/ is ready
node dist/index.js
```

## Authentication

Two options:

### OAuth (recommended)

```bash
npx github:DerpBicycle/gil-mcp-bridge login
```

This opens your browser, registers a client via DCR, walks you through the consent screen, and stores tokens at `~/.gil/credentials.json` (mode 0600, user-only). Access tokens last an hour and are refreshed automatically; the session stays valid for 30 days unless you revoke it from `/account → Connected Apps` or run `logout`.

### API key

```bash
GIL_API_KEY=gil_xxx npx github:DerpBicycle/gil-mcp-bridge
```

Create a key at [/help/mcp-server](https://gameindustrylibrary.com/help/mcp-server) (signed in, with Pro). Keys don't expire but you can revoke them from the same page.

## Use in your MCP client

### Claude Desktop

Open Settings → Developer → Edit Config (`claude_desktop_config.json`) and add:

```json
{
  "mcpServers": {
    "game-industry-library": {
      "command": "npx",
      "args": ["github:DerpBicycle/gil-mcp-bridge"]
    }
  }
}
```

Restart Claude Desktop. On first run, the bridge prints a "no credentials" error — run `npx github:DerpBicycle/gil-mcp-bridge login` once in a terminal to sign in.

### Cline / Continue / other stdio clients

Same config — point the client at `npx github:DerpBicycle/gil-mcp-bridge` as the command.

### Custom

Speak newline-delimited JSON-RPC 2.0 to stdin (single messages or batches of up to 20 requests); receive responses on stdout, one per line. Errors and status messages go to stderr.

## What you get

The server's name and logo come through in the `initialize` response, along with research instructions for the model.

- **Tools:** `search`, `fetch`, `search_in_document`, `get_document`, `get_pages`, `list_documents`, `list_recent`, `list_popular`, `list_tags`, `get_facets`, `get_figures`, `get_tables`, `get_entities`, `get_citation`, `get_similar`, `get_related`, `list_collections`, `list_writers`, `get_glossary_term`
- **Resources:** `gil://documents/{slug}`, `gil://documents/{slug}/page/{page}`, `gil://documents/{slug}/figures`, `gil://collections/{slug}`, `gil://writers/{slug}`, `gil://glossary/{term}`
- **Prompts:** `summarize_document`, `compare_publishers`, `find_evidence`, `catch_up`

Fair use: 2,000 tool calls a day (resets at midnight UTC) and 30 a minute, per user across all keys and tokens. Each tool result reports what is left in `_meta.usage`.

## Commands

```
gil-mcp                Start the bridge (default — use this in client config)
gil-mcp login          Interactive OAuth login (stores ~/.gil/credentials.json)
gil-mcp logout         Revoke and remove stored credentials
gil-mcp status         Show current credential state
gil-mcp help           Show help
```

## Environment variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `GIL_API_KEY` | API key (`gil_…`). Takes precedence over OAuth. | — |
| `GIL_BASE_URL` | Override server URL. Useful for testing against staging or local dev. | `https://gameindustrylibrary.com` |

## How it works

The bridge is a thin transport translator. It reads JSON-RPC frames on stdin and forwards each one as `POST /api/mcp` (Streamable HTTP, protocol `2025-03-26`) with an `Authorization: Bearer` header, echoing the `Mcp-Session-Id` the server issues on `initialize`. Responses go back to stdout as one line each, whether the server answers with JSON or an SSE stream. No caching, no transformation: the server does all the work.

- **Tokens** are resolved per request. An OAuth token within 60s of expiry is refreshed first; a token the server rejects with 401 is refreshed once and the request retried. Concurrent requests share one refresh, because the server rotates the refresh token on every use. If the refresh fails, requests get an error telling you to run `login` again.
- **Errors** from the server — 403 without Pro, 429 at the fair-use limits — pass through as the JSON-RPC errors the server writes. Anything that is not JSON-RPC (a proxy's HTML error page, a network failure) becomes a JSON-RPC error for each request in the frame, so the client never hangs or reads garbage.
- **Shutdown:** when stdin closes, the bridge answers the requests still in flight, then exits.

## Build from source

```bash
git clone https://github.com/DerpBicycle/gil-mcp-bridge
cd gil-mcp-bridge
npm install
npm run build
node dist/index.js
```

## Files

- `src/index.ts` — CLI entry, command dispatch
- `src/bridge.ts` — stdio ↔ HTTP forwarding
- `src/login.ts` — OAuth interactive flow (DCR + PKCE + loopback)
- `src/credentials.ts` — `~/.gil/credentials.json` read/write/refresh/revoke
- `assets/` — the Game Industry Library logo (SVG, 512 and 192 px PNG)

## License

MIT
