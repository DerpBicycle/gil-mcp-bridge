#!/usr/bin/env node
/**
 * gil-mcp-bridge — stdio bridge for the GIL MCP server.
 *
 * Forwards JSON-RPC frames on stdin to https://gameindustrylibrary.com/api/mcp
 * with a Bearer token, and writes the responses back to stdout. Dom met opzet —
 * geen caching, geen retry, geen request-merging.
 *
 * Usage:
 *   gil-mcp                      # Run the bridge (uses stored OAuth token or GIL_API_KEY env)
 *   gil-mcp login                # Interactive OAuth flow — stores tokens in ~/.gil/credentials.json
 *   gil-mcp logout               # Delete stored tokens
 *   gil-mcp status               # Show current credential state
 *
 * Environment variables:
 *   GIL_API_KEY    Legacy API key (gil_xxx). Takes precedence over stored OAuth tokens.
 *   GIL_BASE_URL   Override server URL (default: https://gameindustrylibrary.com)
 *
 * The MCP server is part of Game Industry Library Pro: tool calls without an
 * active subscription come back as a JSON-RPC error that says so.
 */

import { runBridge } from './bridge.js';
import { runLogin } from './login.js';
import { logoutCommand, statusCommand } from './credentials.js';

const command = process.argv[2];

(async () => {
  try {
    switch (command) {
      case 'login':
        await runLogin();
        break;
      case 'logout':
        await logoutCommand();
        break;
      case 'status':
        await statusCommand();
        break;
      case undefined:
      case 'serve':
        await runBridge();
        break;
      case '--help':
      case '-h':
      case 'help':
        printHelp();
        break;
      default:
        process.stderr.write(`Unknown command: ${command}\n\n`);
        printHelp();
        process.exit(1);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${msg}\n`);
    process.exit(1);
  }
})();

function printHelp() {
  process.stderr.write(`gil-mcp — Stdio bridge for the Game Industry Library MCP server

Usage:
  gil-mcp                Start the bridge (use this in your MCP client config)
  gil-mcp login          Interactive OAuth login (stores ~/.gil/credentials.json)
  gil-mcp logout         Remove stored credentials
  gil-mcp status         Show current credential state
  gil-mcp help           Show this message

Environment:
  GIL_API_KEY            Legacy API key (gil_xxx) — alternative to OAuth login
  GIL_BASE_URL           Override server URL (default: https://gameindustrylibrary.com)

Requires a Game Industry Library Pro subscription: https://gameindustrylibrary.com/subscribe
Docs: https://gameindustrylibrary.com/help/mcp-server
`);
}
