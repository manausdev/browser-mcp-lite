# browser-mcp-lite

Drive a real Chrome from an AI agent over the [Model Context Protocol](https://modelcontextprotocol.io) — with **no browser extension, no native messaging, and zero npm dependencies**.

The browser is launched headless, driven through the [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/), and torn down when the session ends. If Chrome is not installed the tools say so; if it is, nothing needs to be installed into your browser profile.

```bash
npx -y github:lu4nn3ry/browser-mcp-lite doctor      # check Node, Chrome and the auth token
npx -y github:lu4nn3ry/browser-mcp-lite audit https://example.com --widths=390,768,1440
```

---

## Why this exists

Most browser MCP servers need a companion extension. That means the model can only see the browser a human has already set up, permissions live in `chrome://extensions`, and the whole thing breaks the moment the profile moves. Driving CDP directly removes the extension from the equation and makes the browser a disposable process instead of a shared, stateful one.

It also ships the two audits that manual screenshotting keeps failing to catch:

- **horizontal overflow** — finds the element that pushes the page wider than the viewport and names it with a CSS selector
- **WCAG AA contrast** — walks every text node, composites translucent and layered backgrounds, and reports the measured ratio

Both are available as MCP tools (`audit_page`) and as a CLI that exits non-zero, so they work in CI.

---

## Requirements

| | |
|---|---|
| Node | 22 or newer (uses the global `WebSocket`) |
| Browser | Chrome, Chromium or Edge. Auto-detected; override with `BML_CHROME` |

## Install

```bash
npm install -g lu4nn3ry/browser-mcp-lite      # CLI (bml) on your PATH
npm install lu4nn3ry/browser-mcp-lite         # or as a project dependency
```

Nothing else. There is no lockfile-sized dependency tree because there are no dependencies. The package is not on npm — the `browser-mcp-lite` name there belongs to an unrelated project — so both commands install straight from the GitHub repo.

## Wire it into an MCP client

**opencode**

```jsonc
// opencode.json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "browser": {
      "type": "local",
      "command": ["npx", "-y", "github:lu4nn3ry/browser-mcp-lite", "mcp"],
      "enabled": true
    }
  }
}
```

**Claude Code / Claude Desktop**

```json
{
  "mcpServers": {
    "browser": {
      "command": "npx",
      "args": ["-y", "github:lu4nn3ry/browser-mcp-lite", "mcp"]
    }
  }
}
```

**VS Code (`.vscode/mcp.json`)**

```json
{
  "servers": {
    "browser": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "github:lu4nn3ry/browser-mcp-lite", "mcp"]
    }
  }
}
```

### HTTP bridge

Some clients cannot spawn a process. The bridge speaks the same JSON-RPC over HTTP (and SSE) on loopback, guarded by a bearer token:

```bash
bml bridge
# listening on http://127.0.0.1:12307/mcp
# bearer token: 9f1c…
```

```bash
curl http://127.0.0.1:12307/mcp \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

The token is generated on first run and stored at `~/.browser-mcp-secrets.json` with `0600` permissions (or `~/.browser-mcp-secrets.token`). `bml token` prints it; `loadToken()` from `browser-mcp-lite/server/token.js` returns it for clients that need to authenticate themselves. `GET /health` is open and lists the tools without touching the browser.

The bridge binds to `127.0.0.1` and refuses requests without a valid token. `BML_INSECURE=1` disables the check for local debugging only.

## Tools

| Tool | What it does |
|---|---|
| `list_tabs` | Every open page with id, title and URL |
| `open_tab` | New tab at an absolute URL, returns the outline |
| `navigate_tab` | Navigate and wait for load |
| `reload_tab` | Reload, optionally bypassing the cache |
| `focus_tab` | Bring a tab to the foreground |
| `read_page` | YAML outline with `ref=<id>` on every interactive node |
| `click` | Click a `ref` or CSS selector with real mouse events |
| `type_text` | Type with real key events, optional clear and Enter |
| `scroll_page` | Wheel delta, jump to top/bottom, or scroll a selector into view |
| `screenshot` | PNG/JPEG, full page or clipped to a selector |
| `inject_script` | Evaluate JS, return the JSON result |
| `audit_page` | Overflow + WCAG AA contrast, optional geometry check and highlighted screenshot |

`read_page` is the important one. It returns landmarks, headings, links and controls as a compact outline instead of a wall of HTML, and stamps each node with a ref:

```yaml
url: https://example.com
title: "Example"
lang: pt-BR
viewport: 1440x900

- ref=r1 | role=banner | label="Example"
- ref=r2 | role=navigation | label="Main"
  - ref=r3 | role=link | label="Docs" | href=/docs
- ref=r4 | role=searchbox | label="Search" | placeholder=Search
- ref=r5 | role=button | label="Enviar"
```

Refs are re-generated on every `read_page`, so always re-read after navigating. `label` is the computed accessible name; everything after it is the raw attribute.

## CLI

```bash
bml doctor                                    # environment check
bml tools                                     # the tool catalogue as JSON
bml token                                     # print the bridge bearer token
bml shot https://example.com out.png --full --color-scheme=dark
bml audit https://example.com --widths=390,768,1440 --json=report.json
```

`bml audit` prints one line per URL × width and exits `1` on any failure, which makes it a CI step:

```yaml
- run: npx -y github:lu4nn3ry/browser-mcp-lite audit https://example.com --widths=390,768,1440
```

`--continue-on-fail` keeps the exit code at 0 when you only want the report. Nodes sitting on a background image or gradient are reported as `needsManualReview` rather than guessed at — a numeric ratio would be a lie there.

## Environment variables

| Variable | Purpose |
|---|---|
| `BML_CHROME` | Absolute path to the browser binary |
| `BML_HEADFUL=1` | Show the window instead of running headless |
| `BML_ENDPOINT` | HTTP endpoint override, default `http://127.0.0.1:12307/mcp` |
| `BML_HOST` | Bridge bind host, default `127.0.0.1` |
| `BML_PORT` | Bridge port, default `12307` |
| `BML_TOKEN` | Bearer token override |
| `BML_INSECURE=1` | Accept any token on the bridge (local debugging) |
| `BML_E2E=1` | Include the browser integration tests in `npm test` |
| `BML_E2E_TIMEOUT` | Hard cap in ms on `npm run test:e2e`, default `180000` |

## Development

```bash
npm test                # unit + protocol tests
BML_E2E=1 npm test      # also boots Chrome and drives a fixture page
npm run test:e2e        # the same plus a hard timeout — what CI runs
```

The unit tests cover colour maths, token handling and the JSON-RPC surface. The integration tests launch a real browser and assert the behaviour you actually depend on: refs resolve, clicks fire, `input` events reach framework listeners, screenshots are valid images, and both audits catch a page that is deliberately broken.

## Limitations

- Chromium-based browsers only. No WebKit, no Gecko.
- Headless by default; a headed session is available but not useful for interactive login flows.
- No network interception, request mocking or cookie management.
- Contrast is computed from computed styles, so text composited over a canvas or an image is flagged for manual review rather than measured.

## License

MIT
