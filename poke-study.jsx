import { useEffect, useRef, useState } from "react";
import renderMathInElement from "katex/contrib/auto-render";
import "katex/dist/katex.min.css";

const DEFAULT_RELAY_URL = "http://localhost:4242";
const POLL_INTERVAL_MS = 3000;
const HEALTH_INTERVAL_MS = 15000;
const SETTINGS_STORAGE_KEY = "poke-study-settings-v1";
const RELAY_TUNNEL_HEADERS = {
  "bypass-tunnel-reminder": "true",
};

function createId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `id_${Math.random().toString(36).slice(2, 10)}`;
}

function formatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function normalizeRelayUrl(value) {
  const nextValue = typeof value === "string" ? value.trim() : "";
  if (!nextValue) {
    return DEFAULT_RELAY_URL;
  }

  return nextValue.replace(/\/+$/, "");
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function stringifyDetail(value) {
  if (value == null) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function loadSavedSettings() {
  if (typeof window === "undefined") {
    return {
      apiKey: "",
      relayUrl: DEFAULT_RELAY_URL,
    };
  }

  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) {
      return {
        apiKey: "",
        relayUrl: DEFAULT_RELAY_URL,
      };
    }

    const parsed = JSON.parse(raw);
    return {
      apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey : "",
      relayUrl:
        typeof parsed.relayUrl === "string" && parsed.relayUrl.trim()
          ? parsed.relayUrl
          : DEFAULT_RELAY_URL,
    };
  } catch {
    return {
      apiKey: "",
      relayUrl: DEFAULT_RELAY_URL,
    };
  }
}

function createAssistantMessage(text) {
  return {
    id: createId(),
    role: "assistant",
    text,
    ts: Date.now(),
  };
}

function createSession(name, icon, welcomeText) {
  return {
    id: createId(),
    name,
    icon,
    messages: [createAssistantMessage(welcomeText)],
  };
}

function createDefaultSessions() {
  return [
    createSession(
      "General",
      "💬",
      "General study session ready. Ask for explanations, drills, or quick checks.",
    ),
    createSession(
      "ENGR 205",
      "⚡",
      "ENGR 205 session ready.\n\nTry: Solve for $V_x$ using KVL in $$\\sum V = 0$$",
    ),
    createSession(
      "Diff EQ",
      "∫",
      "Diff EQ session ready.\n\nExample: $$y'' + 3y' + 2y = e^{2t}$$",
    ),
  ];
}

function buildOutboundMessage(session, text, attachment) {
  const lines = [
    "integration_name: Poke Study Relay",
    "routing_mode: web_study_chatbot",
    "reply_tool: store_reply",
    "reply_requirement: use the Poke Study Relay integration and call store_reply exactly once so the website can display the response",
    `session_name: ${session.name}`,
    `session_id: ${session.id}`,
    "",
    "message:",
    text || "[image attachment only]",
  ];

  if (attachment) {
    lines.push(
      "",
      `image_name: ${attachment.name}`,
      `image_type: ${attachment.type}`,
      `image_dimensions: ${attachment.width}x${attachment.height}`,
      "image_data_url:",
      attachment.dataUrl,
    );
  }

  return lines.join("\n");
}

async function fileToAttachment(file) {
  if (!file || !file.type.startsWith("image/")) {
    throw new Error("Only image attachments are supported.");
  }

  const objectUrl = URL.createObjectURL(file);

  try {
    const image = await new Promise((resolve, reject) => {
      const nextImage = new Image();
      nextImage.onload = () => resolve(nextImage);
      nextImage.onerror = () => reject(new Error("Could not read the image file."));
      nextImage.src = objectUrl;
    });

    const maxEdge = 960;
    const scale = Math.min(1, maxEdge / Math.max(image.width, image.height));
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Could not create a canvas for the image preview.");
    }

    context.drawImage(image, 0, 0, width, height);
    const nextType = file.type === "image/png" ? "image/png" : "image/jpeg";
    const dataUrl =
      nextType === "image/png"
        ? canvas.toDataURL(nextType)
        : canvas.toDataURL(nextType, 0.82);

    return {
      id: createId(),
      name: file.name || "attachment",
      type: nextType,
      width,
      height,
      dataUrl,
    };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function readRelayBody(response) {
  const raw = await response.text();
  return {
    raw,
    parsed: safeJsonParse(raw),
  };
}

function formatRelayError(response, body) {
  const statusLine = `${response.status} ${response.statusText}`.trim();
  const primary =
    body.parsed?.error ||
    body.parsed?.message ||
    body.raw ||
    "Request failed without a response body.";
  const details =
    body.parsed?.details && stringifyDetail(body.parsed.details) !== primary
      ? stringifyDetail(body.parsed.details)
      : body.parsed && !body.parsed.error
        ? stringifyDetail(body.parsed)
        : "";

  if (details) {
    return `Relay request failed (${statusLine}): ${primary}\n${details}`;
  }

  return `Relay request failed (${statusLine}): ${primary}`;
}

const MATH_BLOCK_PATTERN = /(\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\$[^$\n]+\$|\\\([^)\n]*\\\))/g;

function normalizeTextSegment(segment) {
  return segment
    .replace(/\\textbf\{([^{}]*)\}/g, "$1")
    .replace(/\\text\{([^{}]*)\}/g, "$1")
    .replace(/(^|[^$\w])([A-Za-z]+_\d+)(?=[^$\w]|$)/g, "$1$$$2$")
    .replace(/(^|[^$\w])(\d+\s*\\[A-Za-z]+)(?=[^$\w]|$)/g, "$1$$$2$");
}

function normalizeRenderableText(text) {
  if (!text) {
    return "";
  }

  const parts = [];
  let lastIndex = 0;

  for (const match of text.matchAll(MATH_BLOCK_PATTERN)) {
    const matchIndex = match.index ?? 0;
    const mathBlock = match[0];

    parts.push(normalizeTextSegment(text.slice(lastIndex, matchIndex)));
    parts.push(mathBlock);
    lastIndex = matchIndex + mathBlock.length;
  }

  parts.push(normalizeTextSegment(text.slice(lastIndex)));
  return parts.join("");
}

function MathText({ text, mathReady }) {
  const ref = useRef(null);
  const normalizedText = normalizeRenderableText(text);

  useEffect(() => {
    if (!ref.current || !mathReady) {
      return;
    }

    renderMathInElement(ref.current, {
      delimiters: [
        { left: "$$", right: "$$", display: true },
        { left: "$", right: "$", display: false },
        { left: "\\[", right: "\\]", display: true },
        { left: "\\(", right: "\\)", display: false },
      ],
      throwOnError: false,
    });
  }, [mathReady, normalizedText]);

  return (
    <div ref={ref} className="message-text">
      {normalizedText}
    </div>
  );
}

function Bubble({ message, mathReady }) {
  const isUser = message.role === "user";
  const isSystem = message.role === "system";

  if (isSystem) {
    return (
      <div className="system-wrap">
        <div className="system-bubble">
          <pre>{message.text}</pre>
        </div>
      </div>
    );
  }

  return (
    <div className={`bubble-row ${isUser ? "bubble-row-user" : ""}`}>
      {!isUser && <div className="assistant-avatar">P</div>}
      <div className={`bubble-stack ${isUser ? "bubble-stack-user" : ""}`}>
        {message.image && (
          <img className="message-image" src={message.image} alt="attachment preview" />
        )}
        {message.text && (
          <div className={`bubble ${isUser ? "bubble-user" : "bubble-assistant"}`}>
            <MathText text={message.text} mathReady={mathReady} />
          </div>
        )}
        <span className="message-time">{formatTime(message.ts)}</span>
      </div>
    </div>
  );
}

function TypingIndicator() {
  return (
    <div className="bubble-row">
      <div className="assistant-avatar">P</div>
      <div className="typing-bubble">
        <span />
        <span />
        <span />
      </div>
    </div>
  );
}

function SettingsModal({
  apiKey,
  relayUrl,
  onClose,
  onSave,
}) {
  const [draftApiKey, setDraftApiKey] = useState(apiKey);
  const [draftRelayUrl, setDraftRelayUrl] = useState(relayUrl);

  return (
    <div className="modal-shell">
      <div className="modal-card">
        <div className="modal-header">
          <div>
            <p className="modal-eyebrow">Settings</p>
            <h2>Poke Relay</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close settings">
            ×
          </button>
        </div>

        <label className="field">
          <span>Poke API key</span>
          <input
            type="password"
            value={draftApiKey}
            onChange={(event) => setDraftApiKey(event.target.value)}
            placeholder="pk_..."
          />
        </label>

        <label className="field">
          <span>Relay URL</span>
          <input
            type="text"
            value={draftRelayUrl}
            onChange={(event) => setDraftRelayUrl(event.target.value)}
            placeholder={DEFAULT_RELAY_URL}
          />
        </label>

        <div className="modal-note">
          <strong>Workflow</strong>
          <p>Run the relay on port 4242, expose it with localtunnel, then paste the `loca.lt` URL here.</p>
        </div>

        <button
          className="primary-button"
          onClick={() =>
            onSave({
              apiKey: draftApiKey,
              relayUrl: normalizeRelayUrl(draftRelayUrl),
            })
          }
        >
          Save settings
        </button>
      </div>
    </div>
  );
}

export default function PokeStudy() {
  const savedSettingsRef = useRef(null);
  const initialSessionsRef = useRef(null);

  if (!savedSettingsRef.current) {
    savedSettingsRef.current = loadSavedSettings();
  }

  if (!initialSessionsRef.current) {
    initialSessionsRef.current = createDefaultSessions();
  }

  const savedSettings = savedSettingsRef.current;
  const [sessions, setSessions] = useState(() => initialSessionsRef.current);
  const [activeId, setActiveId] = useState(() => initialSessionsRef.current[0]?.id || "");
  const [apiKey, setApiKey] = useState(savedSettings.apiKey);
  const [relayUrl, setRelayUrl] = useState(savedSettings.relayUrl);
  const [input, setInput] = useState("");
  const [pendingAttachment, setPendingAttachment] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [isAddingSession, setIsAddingSession] = useState(false);
  const [newSessionName, setNewSessionName] = useState("");
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState(null);
  const [typingSessionId, setTypingSessionId] = useState(null);
  const [relayState, setRelayState] = useState("unknown");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const bottomRef = useRef(null);
  const fileInputRef = useRef(null);
  const textareaRef = useRef(null);
  const pollStateRef = useRef({});
  const seenReplyIdsRef = useRef(new Set());
  const pollingRef = useRef(false);
  const statusTimeoutRef = useRef(null);

  const activeSession = sessions.find((session) => session.id === activeId) || sessions[0] || null;
  const normalizedRelayUrl = normalizeRelayUrl(relayUrl);

  function ensurePollState(sessionId) {
    if (!pollStateRef.current[sessionId]) {
      pollStateRef.current[sessionId] = {
        since: Date.now(),
        seenIds: new Set(),
      };
    }

    return pollStateRef.current[sessionId];
  }

  function pushStatus(nextStatus, timeoutMs = 2400) {
    if (statusTimeoutRef.current) {
      window.clearTimeout(statusTimeoutRef.current);
    }

    setStatus(nextStatus);

    if (!nextStatus || nextStatus.type === "sending" || !timeoutMs) {
      return;
    }

    statusTimeoutRef.current = window.setTimeout(() => {
      setStatus(null);
      statusTimeoutRef.current = null;
    }, timeoutMs);
  }

  function appendMessage(sessionId, message) {
    setSessions((currentSessions) =>
      currentSessions.map((session) =>
        session.id === sessionId
          ? {
              ...session,
              messages: [...session.messages, message],
            }
          : session,
      ),
    );
  }

  function appendSystemMessage(sessionId, text) {
    appendMessage(sessionId, {
      id: createId(),
      role: "system",
      text,
      ts: Date.now(),
    });
  }

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({
        apiKey,
        relayUrl: normalizedRelayUrl,
      }),
    );
  }, [apiKey, normalizedRelayUrl]);

  useEffect(() => () => {
    if (statusTimeoutRef.current) {
      window.clearTimeout(statusTimeoutRef.current);
    }
  }, []);

  useEffect(() => {
    sessions.forEach((session) => {
      ensurePollState(session.id);
    });

    Object.keys(pollStateRef.current).forEach((sessionId) => {
      if (!sessions.some((session) => session.id === sessionId)) {
        delete pollStateRef.current[sessionId];
      }
    });
  }, [sessions]);

  useEffect(() => {
    if (!activeSession) {
      return;
    }

    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [activeSession?.id, activeSession?.messages.length, typingSessionId]);

  useEffect(() => {
    if (!textareaRef.current) {
      return;
    }

    textareaRef.current.style.height = "0px";
    textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 164)}px`;
  }, [input]);

  useEffect(() => {
    let cancelled = false;

    async function checkRelayHealth() {
      try {
        const response = await fetch(`${normalizedRelayUrl}/health`, {
          headers: RELAY_TUNNEL_HEADERS,
        });

        if (!cancelled) {
          setRelayState(response.ok ? "online" : "offline");
        }
      } catch {
        if (!cancelled) {
          setRelayState("offline");
        }
      }
    }

    void checkRelayHealth();
    const timer = window.setInterval(checkRelayHealth, HEALTH_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [normalizedRelayUrl]);

  useEffect(() => {
    if (!activeSession) {
      return;
    }

    const sessionId = activeSession.id;
    let cancelled = false;

    async function pollReplies() {
      if (pollingRef.current) {
        return;
      }

      pollingRef.current = true;
      const pollState = ensurePollState(sessionId);

      try {
        const response = await fetch(
          `${normalizedRelayUrl}/replies?since=${encodeURIComponent(pollState.since)}&session=${encodeURIComponent(sessionId)}`,
          {
            headers: RELAY_TUNNEL_HEADERS,
          },
        );

        if (!response.ok) {
          if (!cancelled) {
            setRelayState("offline");
          }
          return;
        }

        const payload = await response.json();
        const replies = Array.isArray(payload?.replies) ? payload.replies : [];
        const unseenReplies = replies.filter((reply) => {
          if (
            !reply ||
            !reply.id ||
            pollState.seenIds.has(reply.id) ||
            seenReplyIdsRef.current.has(reply.id)
          ) {
            return false;
          }

          pollState.seenIds.add(reply.id);
          seenReplyIdsRef.current.add(reply.id);
          return true;
        });

        if (!cancelled) {
          setRelayState("online");
        }

        if (!unseenReplies.length) {
          return;
        }

        const maxTimestamp = unseenReplies.reduce((maxValue, reply) => {
          const nextTimestamp = Number(reply.ts) || Date.now();
          return Math.max(maxValue, nextTimestamp);
        }, pollState.since);

        pollState.since = maxTimestamp;
        if (!cancelled) {
          setTypingSessionId(sessionId);
        }

        window.setTimeout(() => {
          if (cancelled) {
            return;
          }

          setTypingSessionId((currentValue) =>
            currentValue === sessionId ? null : currentValue,
          );

          unseenReplies.forEach((reply) => {
            appendMessage(sessionId, {
              id: createId(),
              role: "assistant",
              text: reply.text || reply.message || "",
              ts: Number(reply.ts) || Date.now(),
            });
          });
        }, 750);
      } catch {
        if (!cancelled) {
          setRelayState("offline");
        }
      } finally {
        pollingRef.current = false;
      }
    }

    void pollReplies();
    const timer = window.setInterval(pollReplies, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeSession?.id, normalizedRelayUrl]);

  async function handleAttachment(file) {
    try {
      const attachment = await fileToAttachment(file);
      setPendingAttachment(attachment);
    } catch (error) {
      appendSystemMessage(
        activeSession.id,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async function sendMessage() {
    if (!activeSession || sending) {
      return;
    }

    const trimmedInput = input.trim();
    if (!trimmedInput && !pendingAttachment) {
      return;
    }

    if (!apiKey.trim()) {
      setShowSettings(true);
      appendSystemMessage(activeSession.id, "Poke API key is required before sending.");
      return;
    }

    const sessionId = activeSession.id;
    const attachment = pendingAttachment;
    const outboundMessage = buildOutboundMessage(activeSession, trimmedInput, attachment);

    appendMessage(sessionId, {
      id: createId(),
      role: "user",
      text: trimmedInput,
      image: attachment?.dataUrl,
      ts: Date.now(),
    });

    setInput("");
    setPendingAttachment(null);
    setSending(true);
    pushStatus({ type: "sending", text: "Sending..." }, 0);

    try {
      const response = await fetch(`${normalizedRelayUrl}/send`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...RELAY_TUNNEL_HEADERS,
        },
        body: JSON.stringify({
          message: outboundMessage,
          apiKey: apiKey.trim(),
        }),
      });

      const body = await readRelayBody(response);
      if (!response.ok) {
        appendSystemMessage(sessionId, formatRelayError(response, body));
        pushStatus({ type: "error", text: `Failed (${response.status})` });
        return;
      }

      pushStatus({ type: "success", text: "Sent" });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      appendSystemMessage(sessionId, `Network error: ${reason}`);
      pushStatus({ type: "error", text: "Relay unreachable" });
    } finally {
      setSending(false);
    }
  }

  function addSession() {
    const nextName = newSessionName.trim();
    if (!nextName) {
      return;
    }

    const nextSession = createSession(
      nextName,
      "📚",
      `${nextName} session ready. Drop in a problem, image, or derivation.`,
    );

    ensurePollState(nextSession.id);
    setSessions((currentSessions) => [...currentSessions, nextSession]);
    setActiveId(nextSession.id);
    setNewSessionName("");
    setIsAddingSession(false);
  }

  function deleteSession(sessionId) {
    if (sessions.length === 1) {
      return;
    }

    if (!window.confirm("Delete this study session?")) {
      return;
    }

    const remainingSessions = sessions.filter((session) => session.id !== sessionId);
    setSessions(remainingSessions);
    delete pollStateRef.current[sessionId];

    if (typingSessionId === sessionId) {
      setTypingSessionId(null);
    }

    if (activeId === sessionId) {
      setActiveId(remainingSessions[0]?.id || "");
    }
  }

  function relayStateLabel() {
    if (relayState === "online") {
      return "Relay online";
    }

    if (relayState === "offline") {
      return "Relay offline";
    }

    return "Relay checking";
  }

  if (!activeSession) {
    return null;
  }

  return (
    <>
      <style>{`
        @import url("https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@300;400;500;600;700&display=swap");

        :root {
          color-scheme: dark;
          --bg: #09090e;
          --panel: rgba(14, 15, 23, 0.9);
          --panel-strong: #10111a;
          --line: rgba(255, 255, 255, 0.08);
          --line-strong: rgba(255, 255, 255, 0.14);
          --text: rgba(242, 244, 255, 0.92);
          --muted: rgba(182, 189, 214, 0.56);
          --accent: #79b8ff;
          --accent-strong: #287cff;
          --assistant: rgba(255, 255, 255, 0.055);
          --danger: #ff8d8d;
          --danger-bg: rgba(255, 74, 74, 0.1);
          --success: #8ef2a0;
          --shadow: 0 24px 90px rgba(0, 0, 0, 0.45);
        }

        * {
          box-sizing: border-box;
        }

        body {
          margin: 0;
          background: var(--bg);
          color: var(--text);
          font-family: "IBM Plex Sans", sans-serif;
        }

        button,
        input,
        textarea {
          font: inherit;
        }

        textarea {
          resize: none;
        }

        .app-shell {
          position: relative;
          min-height: 100vh;
          background:
            radial-gradient(circle at top left, rgba(40, 124, 255, 0.16), transparent 22%),
            radial-gradient(circle at 85% 10%, rgba(255, 181, 74, 0.12), transparent 18%),
            linear-gradient(180deg, #09090e 0%, #0b0c12 100%);
          color: var(--text);
          overflow: hidden;
        }

        .app-shell::before {
          content: "";
          position: absolute;
          inset: 0;
          background-image:
            linear-gradient(rgba(255, 255, 255, 0.03) 1px, transparent 1px),
            linear-gradient(90deg, rgba(255, 255, 255, 0.03) 1px, transparent 1px);
          background-size: 80px 80px;
          mask-image: linear-gradient(180deg, rgba(0, 0, 0, 0.5), transparent);
          pointer-events: none;
        }

        .layout {
          position: relative;
          display: flex;
          min-height: 100vh;
          z-index: 1;
        }

        .sidebar {
          width: 284px;
          padding: 20px 18px;
          border-right: 1px solid var(--line);
          background: linear-gradient(180deg, rgba(15, 17, 26, 0.96), rgba(10, 10, 17, 0.9));
          backdrop-filter: blur(18px);
          display: flex;
          flex-direction: column;
          gap: 18px;
        }

        .brand {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 12px 14px;
          border: 1px solid var(--line);
          border-radius: 18px;
          background: rgba(255, 255, 255, 0.03);
          box-shadow: var(--shadow);
        }

        .brand-mark {
          width: 42px;
          height: 42px;
          border-radius: 14px;
          display: grid;
          place-items: center;
          background: linear-gradient(135deg, #ffb74a, #ff7f3f);
          color: #16130f;
          font-weight: 700;
          letter-spacing: 0.02em;
        }

        .brand-copy p,
        .header-copy p,
        .modal-eyebrow {
          margin: 0;
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.14em;
          color: var(--muted);
        }

        .brand-copy h1,
        .header-copy h2,
        .modal-header h2 {
          margin: 2px 0 0;
          font-size: 17px;
          font-weight: 600;
          color: var(--text);
        }

        .session-list {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .section-label {
          margin: 0 2px;
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.14em;
          color: var(--muted);
        }

        .session-button {
          width: 100%;
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 12px 12px 12px 14px;
          border-radius: 16px;
          border: 1px solid transparent;
          background: transparent;
          color: inherit;
          cursor: pointer;
          transition: background 140ms ease, border-color 140ms ease, transform 140ms ease;
        }

        .session-button:hover {
          background: rgba(255, 255, 255, 0.04);
          border-color: rgba(255, 255, 255, 0.05);
          transform: translateX(2px);
        }

        .session-button.active {
          background: rgba(40, 124, 255, 0.12);
          border-color: rgba(121, 184, 255, 0.24);
          box-shadow: inset 0 0 0 1px rgba(121, 184, 255, 0.12);
        }

        .session-icon {
          width: 34px;
          height: 34px;
          border-radius: 12px;
          display: grid;
          place-items: center;
          background: rgba(255, 255, 255, 0.06);
          font-size: 18px;
          flex-shrink: 0;
        }

        .session-copy {
          min-width: 0;
          text-align: left;
          flex: 1;
        }

        .session-copy strong {
          display: block;
          font-size: 13px;
          font-weight: 600;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .session-copy span {
          display: block;
          margin-top: 2px;
          font-size: 11px;
          color: var(--muted);
        }

        .delete-button,
        .icon-button {
          width: 34px;
          height: 34px;
          border-radius: 12px;
          border: 1px solid transparent;
          background: transparent;
          color: var(--muted);
          cursor: pointer;
          transition: background 140ms ease, border-color 140ms ease, color 140ms ease;
        }

        .delete-button:hover,
        .icon-button:hover {
          background: rgba(255, 255, 255, 0.05);
          border-color: var(--line);
          color: var(--text);
        }

        .sidebar-footer {
          margin-top: auto;
          display: flex;
          flex-direction: column;
          gap: 10px;
        }

        .new-session-box {
          padding: 12px;
          border-radius: 16px;
          border: 1px solid var(--line);
          background: rgba(255, 255, 255, 0.03);
          display: flex;
          flex-direction: column;
          gap: 10px;
        }

        .new-session-box input,
        .field input,
        .composer textarea {
          width: 100%;
          border-radius: 14px;
          border: 1px solid var(--line);
          background: rgba(7, 8, 14, 0.9);
          color: var(--text);
          outline: none;
        }

        .new-session-box input,
        .field input {
          padding: 12px 14px;
        }

        .new-session-actions {
          display: flex;
          gap: 8px;
        }

        .ghost-button,
        .primary-button,
        .secondary-button {
          border: 1px solid var(--line);
          border-radius: 14px;
          cursor: pointer;
          transition: transform 140ms ease, background 140ms ease, border-color 140ms ease;
        }

        .ghost-button,
        .secondary-button {
          background: rgba(255, 255, 255, 0.04);
          color: var(--text);
        }

        .ghost-button:hover,
        .secondary-button:hover,
        .primary-button:hover {
          transform: translateY(-1px);
        }

        .ghost-button {
          padding: 12px 14px;
        }

        .secondary-button {
          flex: 1;
          padding: 10px 12px;
        }

        .primary-button {
          background: linear-gradient(135deg, #3d96ff, #287cff);
          color: white;
          border-color: rgba(121, 184, 255, 0.4);
          box-shadow: 0 14px 30px rgba(40, 124, 255, 0.24);
          padding: 12px 14px;
        }

        .chat-panel {
          flex: 1;
          min-width: 0;
          display: flex;
          flex-direction: column;
        }

        .chat-header {
          display: flex;
          align-items: center;
          gap: 14px;
          padding: 18px 24px;
          border-bottom: 1px solid var(--line);
          background: rgba(9, 9, 14, 0.72);
          backdrop-filter: blur(18px);
        }

        .header-copy {
          min-width: 0;
          flex: 1;
        }

        .header-copy h2 {
          display: flex;
          align-items: center;
          gap: 10px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .status-pill,
        .relay-pill {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 8px 12px;
          border-radius: 999px;
          border: 1px solid var(--line);
          background: rgba(255, 255, 255, 0.04);
          font-size: 12px;
        }

        .status-pill.success {
          color: var(--success);
        }

        .status-pill.error {
          color: var(--danger);
        }

        .relay-dot {
          width: 8px;
          height: 8px;
          border-radius: 999px;
          background: #8aa0c4;
          box-shadow: 0 0 0 6px rgba(138, 160, 196, 0.12);
        }

        .relay-pill.online .relay-dot {
          background: #7af29f;
          box-shadow: 0 0 0 6px rgba(122, 242, 159, 0.12);
        }

        .relay-pill.offline .relay-dot {
          background: #ff8d8d;
          box-shadow: 0 0 0 6px rgba(255, 141, 141, 0.12);
        }

        .messages {
          flex: 1;
          overflow: auto;
          padding: 26px 24px 12px;
        }

        .messages-inner {
          max-width: 960px;
          margin: 0 auto;
        }

        .intro-banner {
          margin-bottom: 20px;
          padding: 14px 18px;
          border-radius: 18px;
          border: 1px solid rgba(255, 183, 74, 0.18);
          background: linear-gradient(135deg, rgba(255, 183, 74, 0.1), rgba(40, 124, 255, 0.08));
          color: rgba(255, 232, 192, 0.92);
        }

        .bubble-row {
          display: flex;
          gap: 12px;
          margin-bottom: 18px;
          align-items: flex-start;
        }

        .bubble-row-user {
          flex-direction: row-reverse;
        }

        .assistant-avatar {
          width: 36px;
          height: 36px;
          border-radius: 14px;
          display: grid;
          place-items: center;
          background: linear-gradient(135deg, #ffb74a, #ff7f3f);
          color: #17120e;
          font-weight: 700;
          flex-shrink: 0;
        }

        .bubble-stack {
          max-width: min(74%, 760px);
          display: flex;
          flex-direction: column;
          gap: 6px;
          align-items: flex-start;
        }

        .bubble-stack-user {
          align-items: flex-end;
        }

        .bubble {
          padding: 14px 16px;
          border-radius: 20px;
          line-height: 1.65;
          font-size: 14px;
          box-shadow: var(--shadow);
          border: 1px solid transparent;
        }

        .bubble-user {
          border-top-right-radius: 8px;
          background: linear-gradient(135deg, #2e8dff, #1c6dff);
          color: white;
        }

        .bubble-assistant {
          border-top-left-radius: 8px;
          background: var(--assistant);
          border-color: var(--line);
          color: var(--text);
        }

        .message-text {
          white-space: pre-wrap;
          word-break: break-word;
        }

        .message-image {
          max-width: min(320px, 100%);
          border-radius: 20px;
          border: 1px solid var(--line);
          box-shadow: var(--shadow);
        }

        .message-time {
          padding: 0 6px;
          font-size: 11px;
          color: var(--muted);
        }

        .system-wrap {
          display: flex;
          justify-content: center;
          margin-bottom: 18px;
        }

        .system-bubble {
          max-width: min(760px, 100%);
          padding: 12px 14px;
          border-radius: 16px;
          border: 1px solid rgba(255, 141, 141, 0.2);
          background: var(--danger-bg);
          color: var(--danger);
        }

        .system-bubble pre {
          margin: 0;
          white-space: pre-wrap;
          word-break: break-word;
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          font-size: 12px;
          line-height: 1.6;
        }

        .typing-bubble {
          padding: 14px 16px;
          border-radius: 20px;
          border-top-left-radius: 8px;
          border: 1px solid var(--line);
          background: var(--assistant);
          display: inline-flex;
          gap: 8px;
        }

        .typing-bubble span {
          width: 7px;
          height: 7px;
          border-radius: 999px;
          background: rgba(255, 255, 255, 0.55);
          animation: typing-bounce 1.2s infinite ease-in-out;
        }

        .typing-bubble span:nth-child(2) {
          animation-delay: 0.12s;
        }

        .typing-bubble span:nth-child(3) {
          animation-delay: 0.24s;
        }

        .composer-shell {
          padding: 18px 24px 24px;
          border-top: 1px solid var(--line);
          background: rgba(10, 11, 18, 0.88);
          backdrop-filter: blur(18px);
        }

        .composer-inner {
          max-width: 960px;
          margin: 0 auto;
        }

        .attachment-preview {
          display: inline-flex;
          align-items: center;
          gap: 12px;
          padding: 10px;
          margin-bottom: 12px;
          border-radius: 18px;
          border: 1px solid var(--line);
          background: rgba(255, 255, 255, 0.035);
        }

        .attachment-preview img {
          width: 74px;
          height: 74px;
          object-fit: cover;
          border-radius: 14px;
          border: 1px solid var(--line);
        }

        .attachment-copy {
          display: flex;
          flex-direction: column;
          gap: 2px;
          font-size: 12px;
        }

        .attachment-copy strong {
          color: var(--text);
        }

        .attachment-copy span {
          color: var(--muted);
        }

        .composer {
          display: flex;
          align-items: flex-end;
          gap: 12px;
          padding: 12px;
          border-radius: 22px;
          border: 1px solid var(--line-strong);
          background: rgba(255, 255, 255, 0.035);
          box-shadow: var(--shadow);
        }

        .composer textarea {
          min-height: 52px;
          max-height: 164px;
          padding: 14px 16px;
          border: none;
          background: transparent;
          color: var(--text);
          outline: none;
        }

        .composer-actions {
          display: flex;
          gap: 8px;
          flex-shrink: 0;
        }

        .composer-note {
          margin: 10px 2px 0;
          font-size: 12px;
          color: var(--muted);
        }

        .modal-shell {
          position: fixed;
          inset: 0;
          z-index: 20;
          display: grid;
          place-items: center;
          padding: 24px;
          background: rgba(3, 4, 8, 0.72);
          backdrop-filter: blur(12px);
        }

        .modal-card {
          width: min(100%, 460px);
          padding: 24px;
          border-radius: 24px;
          border: 1px solid var(--line);
          background: linear-gradient(180deg, rgba(18, 20, 31, 0.98), rgba(11, 12, 20, 0.98));
          box-shadow: var(--shadow);
        }

        .modal-header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: 16px;
          margin-bottom: 18px;
        }

        .field {
          display: flex;
          flex-direction: column;
          gap: 8px;
          margin-bottom: 16px;
        }

        .field span {
          font-size: 12px;
          color: var(--muted);
          letter-spacing: 0.04em;
        }

        .modal-note {
          padding: 14px 16px;
          margin-bottom: 18px;
          border-radius: 16px;
          border: 1px solid rgba(255, 183, 74, 0.18);
          background: rgba(255, 183, 74, 0.08);
        }

        .modal-note strong {
          display: block;
          margin-bottom: 4px;
          color: rgba(255, 232, 192, 0.94);
        }

        .modal-note p {
          margin: 0;
          font-size: 13px;
          color: rgba(255, 232, 192, 0.76);
          line-height: 1.6;
        }

        .katex {
          font-size: 1.04em;
        }

        .katex-display {
          overflow-x: auto;
          overflow-y: hidden;
          padding: 6px 0;
          margin: 0.6em 0;
        }

        @keyframes typing-bounce {
          0%, 60%, 100% {
            transform: translateY(0);
            opacity: 0.45;
          }
          30% {
            transform: translateY(-5px);
            opacity: 1;
          }
        }

        @media (max-width: 980px) {
          .sidebar {
            position: fixed;
            inset: 0 auto 0 0;
            width: min(84vw, 300px);
            z-index: 10;
            transform: translateX(0);
          }

          .sidebar.hidden {
            transform: translateX(-110%);
          }

          .bubble-stack {
            max-width: 86%;
          }
        }

        @media (max-width: 720px) {
          .chat-header,
          .messages,
          .composer-shell {
            padding-left: 16px;
            padding-right: 16px;
          }

          .relay-pill {
            display: none;
          }

          .bubble-stack {
            max-width: 100%;
          }

          .composer {
            align-items: stretch;
            flex-direction: column;
          }

          .composer-actions {
            justify-content: space-between;
          }

          .message-image {
            max-width: 100%;
          }
        }
      `}</style>

      <div className="app-shell">
        <div className="layout">
          <aside className={`sidebar ${sidebarOpen ? "" : "hidden"}`}>
            <div className="brand">
              <div className="brand-mark">P</div>
              <div className="brand-copy">
                <p>Poke.com artifact</p>
                <h1>Study Chatbot</h1>
              </div>
            </div>

            <div className="section-label">Sessions</div>
            <div className="session-list">
              {sessions.map((session) => (
                <div key={session.id} style={{ display: "flex", gap: 8 }}>
                  <button
                    className={`session-button ${session.id === activeId ? "active" : ""}`}
                    onClick={() => {
                      setActiveId(session.id);
                      if (window.innerWidth < 980) {
                        setSidebarOpen(false);
                      }
                    }}
                  >
                    <div className="session-icon">{session.icon}</div>
                    <div className="session-copy">
                      <strong>{session.name}</strong>
                      <span>{session.id}</span>
                    </div>
                  </button>
                  {sessions.length > 1 && (
                    <button
                      className="delete-button"
                      onClick={() => deleteSession(session.id)}
                      aria-label={`Delete ${session.name}`}
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
            </div>

            <div className="sidebar-footer">
              {isAddingSession ? (
                <div className="new-session-box">
                  <input
                    type="text"
                    value={newSessionName}
                    onChange={(event) => setNewSessionName(event.target.value)}
                    placeholder="Linear Algebra"
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        addSession();
                      }
                    }}
                  />
                  <div className="new-session-actions">
                    <button className="secondary-button" onClick={() => setIsAddingSession(false)}>
                      Cancel
                    </button>
                    <button className="primary-button" onClick={addSession}>
                      Add session
                    </button>
                  </div>
                </div>
              ) : (
                <button className="ghost-button" onClick={() => setIsAddingSession(true)}>
                  + New study session
                </button>
              )}

              <button className="ghost-button" onClick={() => setShowSettings(true)}>
                Settings
              </button>
            </div>
          </aside>

          <main className="chat-panel">
            <header className="chat-header">
              <button
                className="icon-button"
                onClick={() => setSidebarOpen((value) => !value)}
                aria-label="Toggle sidebar"
              >
                ☰
              </button>

              <div className="header-copy">
                <p>Active session</p>
                <h2>
                  <span>{activeSession.icon}</span>
                  <span>{activeSession.name}</span>
                </h2>
              </div>

              {status && (
                <div className={`status-pill ${status.type === "error" ? "error" : status.type === "success" ? "success" : ""}`}>
                  {status.text}
                </div>
              )}

              <div className={`relay-pill ${relayState}`}>
                <span className="relay-dot" />
                {relayStateLabel()}
              </div>
            </header>

            <section className="messages">
              <div className="messages-inner">
                {!apiKey && (
                  <div className="intro-banner">
                    Add your Poke API key in Settings before sending. The artifact will talk only to the relay.
                  </div>
                )}

                {activeSession.messages.map((message) => (
                  <Bubble key={message.id} message={message} mathReady />
                ))}

                {typingSessionId === activeSession.id && <TypingIndicator />}
                <div ref={bottomRef} />
              </div>
            </section>

            <footer className="composer-shell">
              <div className="composer-inner">
                {pendingAttachment && (
                  <div className="attachment-preview">
                    <img src={pendingAttachment.dataUrl} alt="pending attachment" />
                    <div className="attachment-copy">
                      <strong>{pendingAttachment.name}</strong>
                      <span>
                        {pendingAttachment.width} × {pendingAttachment.height}
                      </span>
                      <span>{pendingAttachment.type}</span>
                    </div>
                    <button
                      className="delete-button"
                      onClick={() => setPendingAttachment(null)}
                      aria-label="Remove attachment"
                    >
                      ×
                    </button>
                  </div>
                )}

                <div className="composer">
                  <button
                    className="icon-button"
                    onClick={() => fileInputRef.current?.click()}
                    aria-label="Attach an image"
                  >
                    +
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    style={{ display: "none" }}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) {
                        void handleAttachment(file);
                      }
                      event.target.value = "";
                    }}
                  />

                  <textarea
                    ref={textareaRef}
                    value={input}
                    rows={1}
                    placeholder={`Message ${activeSession.name}...`}
                    onChange={(event) => setInput(event.target.value)}
                    onPaste={(event) => {
                      const imageItem = Array.from(event.clipboardData.items).find((item) =>
                        item.type.startsWith("image/"),
                      );

                      if (imageItem) {
                        event.preventDefault();
                        const file = imageItem.getAsFile();
                        if (file) {
                          void handleAttachment(file);
                        }
                      }
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        void sendMessage();
                      }
                    }}
                  />

                  <div className="composer-actions">
                    <button className="secondary-button" onClick={() => setShowSettings(true)}>
                      Relay
                    </button>
                    <button
                      className="primary-button"
                      onClick={() => void sendMessage()}
                      disabled={sending || (!input.trim() && !pendingAttachment)}
                    >
                      {sending ? "Sending..." : "Send"}
                    </button>
                  </div>
                </div>

                <p className="composer-note">
                  Enter sends, Shift+Enter adds a newline, `$...$` renders inline math, `$$...$$` renders block math.
                </p>
              </div>
            </footer>
          </main>
        </div>
      </div>

      {showSettings && (
        <SettingsModal
          apiKey={apiKey}
          relayUrl={normalizedRelayUrl}
          onClose={() => setShowSettings(false)}
          onSave={({ apiKey: nextApiKey, relayUrl: nextRelayUrl }) => {
            setApiKey(nextApiKey);
            setRelayUrl(nextRelayUrl);
            setShowSettings(false);
            pushStatus({ type: "success", text: "Settings saved" });
          }}
        />
      )}
    </>
  );
}
