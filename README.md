# @gameindustrylibrary/mcp

Stdio bridge for the **Game Industry Library MCP server**. Exposes the remote `/api/mcp` endpoint to MCP clients that only speak stdio (older Claude Desktop, Cline, Continue, custom integrations).

If your MCP client supports remote/HTTP transport (Claude Desktop ≥ 1.x, Claude.ai web, ChatGPT Connectors), you can connect directly without this bridge — see [the help page](https://gameindustrylibrary.com/help/mcp-server) for one-click connect instructions.

## Install

No install needed — use `npx`:

```bash
npx @gameindustrylibrary/mcp
```

Or install globally:

```bash
npm install -g @gameindustrylibrary/mcp
gil-mcp
```

## Authentication

Two options:

### OAuth (recommended)

```bash
npx @gameindustrylibrary/mcp login
```

This opens your browser, registers a client via DCR, walks you through the consent screen, and stores tokens at `~/.gil/credentials.json` (mode 0600, user-only). Refresh happens automatically — your session stays valid for 30 days unless you revoke it from `/account → Connected Apps`.

### Legacy API key

```bash
GIL_API_KEY=gil_xxx npx @gameindustrylibrary/mcp
```

Get a key from [/help/mcp-server](https://gameindustrylibrary.com/help/mcp-server) (logged in). Bearer keys don't expire but you can revoke them from the same page.

## Use in your MCP client

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "game-industry-library": {
      "command": "npx",
      "args": ["@gameindustrylibrary/mcp"]
    }
  }
}
```

Restart Claude Desktop. On first run, the bridge will print a "no credentials" error — run `npx @gameindustrylibrary/mcp login` once to authenticate.

### Cline / Continue / other VS Code clients

Same config — point the client at `npx @gameindustrylibrary/mcp` as the command.

### Custom

Speak newline-delimited JSON-RPC 2.0 to stdin; receive responses on stdout. Errors and status messages go to stderr.

## Commands

```
gil-mcp                Start the bridge (default — use this in client config)
gil-mcp login          Interactive OAuth login (stores ~/.gil/credentials.json)
gil-mcp logout         Remove stored credentials
gil-mcp status         Show current credential state
gil-mcp help           Show help
```

## Environment variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `GIL_API_KEY` | Legacy bearer key. Takes precedence over OAuth. | — |
| `GIL_BASE_URL` | Override server URL. Useful for testing against staging or local dev. | `https://gameindustrylibrary.com` |

## How it works

The bridge is a thin transport translator — ~80 lines of code per file. It reads JSON-RPC frames on stdin, forwards them as `POST /api/mcp` with a `Authorization: Bearer` header, and writes the response back to stdout. No caching, no retry, no transformation. The server does all the work.

OAuth tokens are refreshed automatically when they're within 60s of expiring (or already expired). If a refresh fails (e.g., the user revoked from `/account`), the bridge exits with a helpful error.

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
- `src/credentials.ts` — `~/.gil/credentials.json` read/write/refresh

## License

MIT
