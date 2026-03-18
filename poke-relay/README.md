# poke-relay

`poke-relay` is the local bridge for the Poke.com study chatbot. It runs:

- An MCP server on port `3000` at `/mcp` using `@modelcontextprotocol/sdk` and `StreamableHTTPServerTransport`
- An Express relay on port `4242` for browser-safe polling and message proxying

## Requirements

- Node.js `20+`
- npm

## Endpoints

### MCP server

- `POST /mcp`
- `GET /mcp`
- `DELETE /mcp`

Exposed MCP tools:

- `store_reply(message, session_id?)`
- `clear_replies()`

`store_reply` writes replies into an in-memory queue that the UI polls.

### Relay server

- `GET /replies?since=<timestamp>&session=<id>`
- `POST /send`
- `GET /health`

`POST /send` expects:

```json
{
  "message": "session_name: General\nsession_id: abc123\n\nmessage:\nHelp me solve this",
  "apiKey": "pk_..."
}
```

It forwards the request to `https://poke.com/api/v1/inbound-sms/webhook` with `Authorization: Bearer <apiKey>`.

## Build

```bash
cd poke-relay
npm install
npm run build
```

Compiled output lands in `dist/index.js`.

## Run

Terminal 1:

```bash
cd poke-relay
npm run build
node dist/index.js
```

Terminal 2:

```bash
npx poke tunnel -n "Poke Chatbot" http://localhost:3000/mcp
```

Terminal 3:

```bash
npx localtunnel --port 4242
```

Paste the relay URL into the frontend Settings modal.

## Frontend Integration

Use [`poke-study.jsx`](../poke-study.jsx) as the React frontend. It:

- posts outbound messages to `/send`
- polls `/replies` every 3 seconds
- renders LaTeX with KaTeX from a CDN
- prepends `session_name` and `session_id` to every outbound message

If the browser can reach the relay directly, use `http://localhost:4242` instead of tunneling the relay.

## Package As Tarball

This package is configured for `npm pack` and includes `dist/`, `src/`, `README.md`, and `tsconfig.json`.

```bash
cd poke-relay
npm run build
npm pack
```

That produces a tarball such as `poke-relay-1.0.0.tgz`.
