# Poke Study Chatbot

Open-source React UI plus a local relay/MCP bridge that turns [Poke](https://poke.com) into a multi-session study chatbot with LaTeX rendering, image attachments, and reply polling.

## Requirements

- Node.js `20+`
- A Poke API key
- `npx poke` for tunneling the MCP endpoint
- Optional: `localtunnel` if the browser cannot reach your relay directly

## Architecture

```text
Browser (React UI)
  │
  ├─ POST /send ──► Relay (Express :4242) ──► Poke webhook
  │                                              │
  │                                     Poke processes message
  │                                     and calls store_reply
  │                                              │
  └─ GET /replies ◄── Relay ◄── MCP Server (:3000) ◄─┘
```

1. The React frontend in [`poke-study.jsx`](./poke-study.jsx) sends outbound messages to the relay.
2. The relay in [`poke-relay/`](./poke-relay) forwards them to the Poke inbound webhook.
3. Poke calls the MCP `store_reply` tool exposed by the relay package.
4. The frontend polls `/replies` and renders new assistant messages per study session.

## Quick Start

### 1. Install dependencies

```bash
npm install
cd poke-relay && npm install
```

### 2. Start the relay and MCP server

```bash
npm run relay:build
npm run relay:start
```

This starts:

- MCP server on `http://localhost:3000/mcp`
- Relay server on `http://localhost:4242`

### 3. Expose the MCP endpoint to Poke

```bash
npx poke tunnel -n "Poke Chatbot" http://localhost:3000/mcp
```

If your browser is not on the same machine as the relay, expose port `4242` too:

```bash
npx localtunnel --port 4242
```

### 4. Start the frontend

```bash
npm run dev
```

Open `http://localhost:5173`, click `Settings`, and enter:

- your Poke API key
- the relay URL
  - use `http://localhost:4242` if the browser can reach the relay directly
  - use your `https://*.loca.lt` URL if you tunneled the relay

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `MCP_PORT` | `3000` | Port for the MCP server |
| `RELAY_PORT` | `4242` | Port for the Express relay |

The Poke API key and relay URL are configured in the browser UI and stored in `localStorage` on that browser only.

## Features

- Multi-session chat with isolated message histories
- KaTeX rendering for inline and block math
- Image paste/upload with client-side resizing
- Relay health indicator and reply polling
- Local relay that keeps the browser off the Poke webhook directly

## Project Structure

```text
.
├── index.html
├── package.json
├── poke-study.jsx
├── src/
│   ├── main.jsx
│   └── reset.css
├── vite.config.js
└── poke-relay/
    ├── package.json
    ├── README.md
    ├── src/index.ts
    └── tsconfig.json
```

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

[MIT](./LICENSE)
