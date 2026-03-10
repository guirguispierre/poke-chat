import { randomUUID } from "node:crypto";
import process from "node:process";
import cors from "cors";
import express from "express";
import type { Server as HttpServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const MCP_PORT = Number(process.env.MCP_PORT ?? 3000);
const RELAY_PORT = Number(process.env.RELAY_PORT ?? 4242);
const POKE_WEBHOOK_URL = "https://poke.com/api/v1/inbound-sms/webhook";
const MAX_REPLIES = 500;

type Reply = {
  id: string;
  text: string;
  sessionId: string | null;
  ts: number;
};

type SessionContext = {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
};

const replies: Reply[] = [];
const sessions = new Map<string, SessionContext>();
let replyCounter = 0;

const storeReplyInput = z.object({
  message: z.string().min(1, "message is required"),
  session_id: z.string().optional(),
});

const sendRequestSchema = z.object({
  message: z.string().min(1, "message is required"),
  apiKey: z.string().min(1, "apiKey is required"),
});

function makeReply(text: string, sessionId?: string): Reply {
  const reply: Reply = {
    id: `reply_${++replyCounter}`,
    text,
    sessionId: sessionId ?? null,
    ts: Date.now(),
  };

  replies.push(reply);
  if (replies.length > MAX_REPLIES) {
    replies.splice(0, replies.length - MAX_REPLIES);
  }

  return reply;
}

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "poke-relay",
    version: "1.0.0",
    title: "Poke Study Relay",
    description:
      "Routes replies from Poke into a web-based study chatbot that polls stored replies.",
  }, {
    instructions: [
      "This integration belongs to a web-based study chatbot, not a direct SMS/iMessage user.",
      "When the conversation includes session_id and session_name, treat that as the web chat context.",
      "For every final reply meant for the user, you must call the tool store_reply exactly once.",
      "Put the full student-facing answer in the tool argument message.",
      "If the incoming message includes session_id, pass that exact value to store_reply as session_id.",
      "If no session_id is present, still call store_reply without session_id.",
      "The website only displays replies that are sent through store_reply, so do not skip the tool call.",
    ].join(" "),
  });

  server.registerTool(
    "store_reply",
    {
      title: "Send Reply To Website",
      description:
        "Required for web-chat replies. Store the exact user-facing reply so the study chatbot UI can poll and display it. Pass through session_id unchanged when the conversation provides one.",
      inputSchema: storeReplyInput,
    },
    async ({ message, session_id }) => {
      const reply = makeReply(message, session_id);
      console.log(
        `[relay] stored reply ${reply.id} for ${reply.sessionId ?? "global"}: ${preview(message)}`,
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: true,
              reply_id: reply.id,
              session_id: reply.sessionId,
              ts: reply.ts,
            }),
          },
        ],
      };
    },
  );

  server.registerTool(
    "clear_replies",
    {
      title: "Clear Stored Website Replies",
      description: "Clear the in-memory reply store used by the relay server.",
      inputSchema: z.object({}),
    },
    async () => {
      const cleared = replies.length;
      replies.length = 0;
      replyCounter = 0;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: true,
              cleared,
            }),
          },
        ],
      };
    },
  );

  return server;
}

function readHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function readQuery(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return typeof value[0] === "string" ? value[0] : undefined;
  }

  return typeof value === "string" ? value : undefined;
}

function isInitializeRequest(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    "method" in body &&
    (body as { method?: unknown }).method === "initialize"
  );
}

async function createSessionContext(): Promise<SessionContext> {
  let context: SessionContext;
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sessionId) => {
      sessions.set(sessionId, context);
      console.log(`[MCP] session initialized: ${sessionId}`);
    },
  });

  transport.onclose = () => {
    const sessionId = transport.sessionId;
    if (!sessionId) {
      return;
    }

    sessions.delete(sessionId);
    console.log(`[MCP] session closed: ${sessionId}`);
  };

  transport.onerror = (error) => {
    console.error("[MCP] transport error:", error);
  };

  context = { server, transport };
  await server.connect(transport);
  return context;
}

function sendJsonRpcError(
  res: express.Response,
  status: number,
  code: number,
  message: string,
): void {
  res.status(status).json({
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
}

function preview(message: string, length = 120): string {
  const compact = message.replace(/\s+/g, " ").trim();
  return compact.length > length ? `${compact.slice(0, length)}...` : compact;
}

function tryParseJson(raw: string): unknown | undefined {
  if (!raw) {
    return undefined;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

async function closeHttpServer(server: HttpServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

const mcpApp = express();
mcpApp.use(cors());
mcpApp.use(express.json({ limit: "2mb" }));

mcpApp.post("/mcp", async (req, res) => {
  const sessionId = readHeader(req.headers["mcp-session-id"]);

  try {
    let context = sessionId ? sessions.get(sessionId) : undefined;

    if (!context) {
      if (sessionId) {
        sendJsonRpcError(res, 404, -32001, `Unknown MCP session: ${sessionId}`);
        return;
      }

      if (!isInitializeRequest(req.body)) {
        sendJsonRpcError(
          res,
          400,
          -32000,
          "Missing MCP session ID. Start with an initialize request first.",
        );
        return;
      }

      context = await createSessionContext();
    }

    await context.transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("[MCP] request failed:", error);
    if (!res.headersSent) {
      sendJsonRpcError(res, 500, -32603, "Internal MCP server error");
    }
  }
});

mcpApp.get("/mcp", async (req, res) => {
  const sessionId = readHeader(req.headers["mcp-session-id"]);
  const context = sessionId ? sessions.get(sessionId) : undefined;

  if (!sessionId || !context) {
    res.status(400).json({ error: "Invalid or missing MCP session ID." });
    return;
  }

  try {
    await context.transport.handleRequest(req, res);
  } catch (error) {
    console.error("[MCP] GET failed:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to handle MCP GET request." });
    }
  }
});

mcpApp.delete("/mcp", async (req, res) => {
  const sessionId = readHeader(req.headers["mcp-session-id"]);
  const context = sessionId ? sessions.get(sessionId) : undefined;

  if (!sessionId || !context) {
    res.status(400).json({ error: "Invalid or missing MCP session ID." });
    return;
  }

  try {
    await context.transport.handleRequest(req, res);
  } catch (error) {
    console.error("[MCP] DELETE failed:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to handle MCP DELETE request." });
    }
  }
});

const relayApp = express();
relayApp.use(cors());
relayApp.use(express.json({ limit: "20mb" }));

relayApp.get("/replies", (req, res) => {
  const sinceRaw = readQuery(req.query.since) ?? "0";
  const sessionId = readQuery(req.query.session);
  const since = Number(sinceRaw);

  if (!Number.isFinite(since) || since < 0) {
    res.status(400).json({ error: "Query parameter 'since' must be a non-negative number." });
    return;
  }

  const filteredReplies = replies.filter((reply) => {
    if (reply.ts <= since) {
      return false;
    }

    if (!sessionId) {
      return true;
    }

    return reply.sessionId === sessionId || reply.sessionId === null;
  });

  res.json({ replies: filteredReplies });
});

relayApp.post("/send", async (req, res) => {
  const parsed = sendRequestSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({
      error: "message and apiKey are required strings.",
      details: parsed.error.flatten(),
    });
    return;
  }

  const message = parsed.data.message.trim();
  const apiKey = parsed.data.apiKey.trim();

  if (!message || !apiKey) {
    res.status(400).json({
      error: "message and apiKey cannot be blank.",
    });
    return;
  }

  try {
    const upstreamResponse = await fetch(POKE_WEBHOOK_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message }),
    });

    const rawBody = await upstreamResponse.text();
    const parsedBody = tryParseJson(rawBody);

    console.log(
      `[relay] proxied /send (${upstreamResponse.status}) ${preview(message)}`,
    );

    if (parsedBody !== undefined) {
      res.status(upstreamResponse.status).json(parsedBody);
      return;
    }

    res.status(upstreamResponse.status).json({
      ok: upstreamResponse.ok,
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      raw: rawBody || null,
    });
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    console.error("[relay] upstream request failed:", error);
    res.status(502).json({
      error: `Failed to reach ${POKE_WEBHOOK_URL}`,
      details: messageText,
    });
  }
});

relayApp.get("/health", (_req, res) => {
  res.json({
    ok: true,
    timestamp: Date.now(),
    replyCount: replies.length,
    activeMcpSessions: sessions.size,
  });
});

const mcpHttpServer = mcpApp.listen(MCP_PORT, () => {
  console.log(`[MCP]   http://localhost:${MCP_PORT}/mcp`);
});

const relayHttpServer = relayApp.listen(RELAY_PORT, () => {
  console.log(`[Relay] http://localhost:${RELAY_PORT}`);
  console.log("");
  console.log("Workflow:");
  console.log("  1. cd poke-relay && npm run build && node dist/index.js");
  console.log('  2. npx poke tunnel -n "Poke Chatbot" http://localhost:3000/mcp');
  console.log("  3. npx localtunnel --port 4242");
  console.log("  4. Paste the loca.lt URL into poke-study.jsx Settings -> Relay URL");
});

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.log(`\nShutting down on ${signal}...`);

  for (const [sessionId, context] of sessions.entries()) {
    try {
      await context.server.close();
    } catch (error) {
      console.error(`[MCP] failed to close session ${sessionId}:`, error);
    }
  }

  sessions.clear();

  await Promise.allSettled([
    closeHttpServer(mcpHttpServer),
    closeHttpServer(relayHttpServer),
  ]);

  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
