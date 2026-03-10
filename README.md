# Poke Study Chatbot

A self-hosted relay and React UI that turns [Poke](https://poke.com) into a multi-session study chatbot with LaTeX rendering, image attachments, and real-time reply polling.

## Architecture

```
Browser (React UI)
  │
  ├─ POST /send ──► Relay (Express :4242) ──► Poke webhook
  │                                              │
  │                                     Poke processes message,
  │                                     calls MCP tool store_reply
  │                                              │
  └─ GET /replies ◄── Relay ◄── MCP Server (:3000) ◄─┘
```

1. The **React frontend** (`poke-study.jsx`) sends user messages to the relay's `/send` endpoint.
2. The **relay server** (`poke-relay/`) proxies the message to the Poke inbound-SMS webhook with your API key.
3. Poke processes the message and calls the `store_reply` MCP tool exposed on `:3000`.
4. The frontend polls `/replies` every 3 seconds and renders new assistant messages.

## Screenshot

![Poke Study Chatbot UI](./screenshot.png)

## Quick Start

### 1. Install dependencies

```bash
# Frontend
npm install

# Relay
cd poke-relay
npm install
```

### 2. Build & start the relay

```bash
cd poke-relay
npm run build
node dist/index.js
```

The MCP server starts on `:3000` and the relay on `:4242`.

### 3. Expose the servers

In separate terminals:

```bash
# Expose the MCP endpoint so Poke can reach it
npx poke tunnel -n "Poke Chatbot" http://localhost:3000/mcp

# Expose the relay so the browser can reach it (if not on localhost)
npx localtunnel --port 4242
```

### 4. Start the frontend

```bash
npm run dev
```

Open `http://localhost:5173`, click **Settings**, paste your Poke API key and the `loca.lt` relay URL.

> **Note:** Add a screenshot named `screenshot.png` to the repo root for the README preview.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `MCP_PORT` | `3000` | Port for the MCP server |
| `RELAY_PORT` | `4242` | Port for the Express relay |

Set these as environment variables before starting the relay, or use the defaults.

The **Poke API key** and **Relay URL** are configured in the browser UI (Settings modal) and persisted in `localStorage`.

## Project Structure

```
poke chatbot/
├── index.html            # Vite entry point
├── vite.config.js        # Vite configuration
├── package.json          # Frontend dependencies
├── src/
│   ├── main.jsx          # React root — renders PokeStudy
│   └── reset.css         # Minimal CSS reset
├── poke-study.jsx        # Main multi-session study chatbot UI
└── poke-relay/
    ├── package.json      # Relay dependencies
    ├── tsconfig.json      # TypeScript configuration
    ├── README.md         # Relay-specific documentation
    └── src/
        └── index.ts      # MCP server + Express relay
```

## Features

- **Multi-session chat** — Create named study sessions (e.g. "Diff EQ", "ENGR 205") with independent message histories.
- **LaTeX rendering** — Inline and display math via KaTeX (`$...$`, `$$...$$`, `\(...\)`, `\[...\]`).
- **Image attachments** — Paste or upload images; they're resized client-side and sent as data URLs.
- **Real-time polling** — The UI polls the relay for new replies every 3 seconds with a typing indicator.
- **Relay health indicator** — Visual status dot shows whether the relay is reachable.
- **Dark mode UI** — Polished dark theme with IBM Plex Sans typography.

## License

[MIT](LICENSE)
