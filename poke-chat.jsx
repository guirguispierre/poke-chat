import { useState, useEffect, useRef, useCallback } from "react";

const POLL_INTERVAL = 4000;

// TODO: Replace with your own MemoryVault MCP endpoint URL.
// See README.md for setup instructions.
const MEMORYVAULT_MCP_URL = "YOUR_MEMORYVAULT_URL";

const formatTime = (ts) =>
  new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

const ImagePreview = ({ src, onRemove }) => (
  <div className="relative inline-block">
    <img src={src} alt="attachment" className="max-h-24 rounded-lg border border-white/10 object-cover" />
    {onRemove && (
      <button
        onClick={onRemove}
        className="absolute -top-2 -right-2 w-5 h-5 bg-red-500 rounded-full flex items-center justify-center text-white text-xs font-bold hover:bg-red-400 transition-colors"
      >×</button>
    )}
  </div>
);

const Bubble = ({ msg }) => {
  if (msg.role === "system") return (
    <div className="flex justify-center mb-4">
      <div className="bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3 max-w-sm">
        <pre className="text-red-400/80 text-xs whitespace-pre-wrap font-mono leading-relaxed">{msg.text}</pre>
      </div>
    </div>
  );
  const isMe = msg.role === "user";
  return (
    <div className={`flex gap-3 mb-4 ${isMe ? "flex-row-reverse" : "flex-row"}`}>
      {!isMe && (
        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center text-black text-xs font-bold flex-shrink-0 mt-1 shadow-lg shadow-amber-500/20">
          P
        </div>
      )}
      <div className={`max-w-[72%] flex flex-col gap-1 ${isMe ? "items-end" : "items-start"}`}>
        {msg.image && (
          <img
            src={msg.image}
            alt="sent"
            className={`max-w-xs rounded-2xl ${isMe ? "rounded-tr-sm" : "rounded-tl-sm"} border border-white/10 shadow-md`}
          />
        )}
        {msg.text && (
          <div
            className={`px-4 py-2.5 rounded-2xl text-sm leading-relaxed shadow-md ${isMe
                ? "bg-blue-600 text-white rounded-tr-sm shadow-blue-900/30"
                : "bg-[#1E1E2E] text-[#E0E0F0] rounded-tl-sm border border-white/5"
              }`}
          >
            {msg.text}
          </div>
        )}
        <span className="text-[10px] text-white/25 px-1">{formatTime(msg.ts)}</span>
      </div>
    </div>
  );
};

const TypingIndicator = () => (
  <div className="flex gap-3 mb-4">
    <div className="w-8 h-8 rounded-full bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center text-black text-xs font-bold flex-shrink-0 mt-1 shadow-lg shadow-amber-500/20">
      P
    </div>
    <div className="px-4 py-3 rounded-2xl rounded-tl-sm bg-[#1E1E2E] border border-white/5 flex gap-1 items-center">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="w-1.5 h-1.5 rounded-full bg-white/40"
          style={{ animation: `bounce 1.2s ease-in-out ${i * 0.2}s infinite` }}
        />
      ))}
    </div>
  </div>
);

const SettingsModal = ({ apiKey, setApiKey, onClose }) => {
  const [draft, setDraft] = useState(apiKey);
  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="bg-[#12121A] border border-white/10 rounded-2xl p-6 w-96 shadow-2xl">
        <div className="flex justify-between items-center mb-5">
          <h2 className="text-white font-semibold text-base">Settings</h2>
          <button onClick={onClose} className="text-white/40 hover:text-white transition-colors text-lg">×</button>
        </div>
        <div className="mb-5">
          <label className="text-white/50 text-xs uppercase tracking-widest mb-2 block">Poke API Key</label>
          <input
            type="password"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="pk_..."
            className="w-full bg-[#0A0A0F] border border-white/10 rounded-xl px-4 py-3 text-white/80 text-sm placeholder-white/20 focus:outline-none focus:border-blue-500/50 transition-colors"
          />
          <p className="text-white/25 text-xs mt-2">Get yours at poke.com/settings/advanced</p>
        </div>
        <div className="mb-6 p-3 rounded-xl bg-amber-500/10 border border-amber-500/20">
          <p className="text-amber-400/80 text-xs leading-relaxed">
            <span className="font-semibold">Auto-replies via MCP:</span> Add a <code className="bg-black/30 px-1 rounded">store_poke_reply</code> tool to your Poke-connected MCP that writes to memoryvault with tag <code className="bg-black/30 px-1 rounded">poke_reply</code>. The chat will poll every 4s.
          </p>
        </div>
        <button
          onClick={() => { setApiKey(draft); onClose(); }}
          className="w-full bg-blue-600 hover:bg-blue-500 transition-colors text-white py-2.5 rounded-xl text-sm font-medium"
        >
          Save
        </button>
      </div>
    </div>
  );
};

export default function PokeChat() {
  const [messages, setMessages] = useState([
    { id: 1, role: "assistant", text: "Hey! What's on your mind?", ts: Date.now() - 60000 },
  ]);
  const [input, setInput] = useState("");
  const [pendingImage, setPendingImage] = useState(null);
  const [apiKey, setApiKey] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [isTyping, setIsTyping] = useState(false);
  const [sending, setSending] = useState(false);
  const [lastPolled, setLastPolled] = useState(Date.now());
  const [status, setStatus] = useState(null); // { type: 'error'|'success', text }
  const bottomRef = useRef(null);
  const fileRef = useRef(null);
  const textareaRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isTyping]);

  // Poll memoryvault for Poke replies via Claude API
  const pollReplies = useCallback(async () => {
    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1000,
          system: `You are a helper that retrieves messages. Search memoryvault for any memories tagged "poke_reply" that were created after timestamp ${lastPolled}. Return ONLY a JSON array of objects like: [{"text": "...", "ts": 1234567890}]. If none found, return []. No other text.`,
          messages: [{ role: "user", content: "Check for new Poke replies now." }],
          mcp_servers: [{ type: "url", url: MEMORYVAULT_MCP_URL, name: "memoryvault" }],
        }),
      });
      const data = await response.json();
      const textBlock = data.content?.find((b) => b.type === "text");
      if (!textBlock) return;
      const clean = textBlock.text.replace(/```json|```/g, "").trim();
      const replies = JSON.parse(clean);
      if (Array.isArray(replies) && replies.length > 0) {
        setIsTyping(true);
        setTimeout(() => {
          setIsTyping(false);
          setMessages((prev) => [
            ...prev,
            ...replies.map((r, i) => ({
              id: Date.now() + i,
              role: "assistant",
              text: r.text,
              ts: r.ts || Date.now(),
            })),
          ]);
          setLastPolled(Date.now());
        }, 800 + Math.random() * 600);
      }
    } catch (_) {
      // silent poll failure
    }
  }, [lastPolled]);

  useEffect(() => {
    const interval = setInterval(pollReplies, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [pollReplies]);

  const handleImageFile = (file) => {
    if (!file || !file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = (e) => setPendingImage(e.target.result);
    reader.readAsDataURL(file);
  };

  const handlePaste = (e) => {
    const item = Array.from(e.clipboardData.items).find((i) => i.type.startsWith("image/"));
    if (item) handleImageFile(item.getAsFile());
  };

  const sendMessage = async () => {
    if (!input.trim() && !pendingImage) return;
    if (!apiKey) { setShowSettings(true); return; }

    const userMsg = {
      id: Date.now(),
      role: "user",
      text: input.trim(),
      image: pendingImage,
      ts: Date.now(),
    };

    setMessages((prev) => [...prev, userMsg]);
    const msgText = input.trim();
    setInput("");
    setPendingImage(null);
    setSending(true);

    try {
      const payload = { message: msgText || "[image attached]" };
      let res;
      try {
        res = await fetch("https://corsproxy.io/?url=https://poke.com/api/v1/inbound-sms/webhook", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        });
      } catch (networkErr) {
        // Likely CORS
        setStatus({ type: "error", text: `Network error (likely CORS): ${networkErr.message}` });
        setMessages((prev) => [...prev, {
          id: Date.now() + 1, role: "system",
          text: `❌ Network/CORS error — browser blocked the request to poke.com.\n\nError: ${networkErr.message}`,
          ts: Date.now(),
        }]);
        return;
      }

      let body;
      try { body = await res.json(); } catch (_) { body = null; }

      if (!res.ok) {
        const detail = body ? JSON.stringify(body) : `HTTP ${res.status}`;
        setStatus({ type: "error", text: `Error ${res.status}` });
        setMessages((prev) => [...prev, {
          id: Date.now() + 1, role: "system",
          text: `❌ Poke API error ${res.status}:\n${detail}`,
          ts: Date.now(),
        }]);
        return;
      }

      setStatus({ type: "success", text: "Sent ✓" });
      setTimeout(() => setStatus(null), 2000);
    } catch (err) {
      setStatus({ type: "error", text: `Failed: ${err.message}` });
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Sora:wght@300;400;500;600&display=swap');
        * { font-family: 'Sora', sans-serif; box-sizing: border-box; }
        @keyframes bounce {
          0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
          30% { transform: translateY(-5px); opacity: 1; }
        }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 2px; }
        textarea { resize: none; }
      `}</style>

      <div className="flex flex-col h-screen bg-[#0A0A0F] text-white">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/5 bg-[#0A0A0F]/90 backdrop-blur-xl">
          <div className="flex items-center gap-3">
            <div className="relative">
              <div className="w-10 h-10 rounded-full bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center text-black font-bold text-sm shadow-lg shadow-amber-500/30">
                P
              </div>
              <span className="absolute bottom-0 right-0 w-3 h-3 bg-green-400 rounded-full border-2 border-[#0A0A0F]" />
            </div>
            <div>
              <div className="font-semibold text-sm text-white">Poke</div>
              <div className="text-xs text-white/35">poke.com</div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {status && (
              <span className={`text-xs px-3 py-1 rounded-full ${status.type === "error" ? "bg-red-500/20 text-red-400" : "bg-green-500/20 text-green-400"}`}>
                {status.text}
              </span>
            )}
            <button
              onClick={() => setShowSettings(true)}
              className="w-8 h-8 rounded-xl bg-white/5 hover:bg-white/10 transition-colors flex items-center justify-center text-white/50 hover:text-white/80"
              title="Settings"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </button>
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-4 py-5">
          {messages.map((msg) => <Bubble key={msg.id} msg={msg} />)}
          {isTyping && <TypingIndicator />}
          <div ref={bottomRef} />
        </div>

        {/* Pending image preview */}
        {pendingImage && (
          <div className="px-4 pb-2">
            <ImagePreview src={pendingImage} onRemove={() => setPendingImage(null)} />
          </div>
        )}

        {/* Input bar */}
        <div className="px-4 pb-5 pt-2 border-t border-white/5">
          {!apiKey && (
            <div className="mb-3 text-center">
              <button onClick={() => setShowSettings(true)} className="text-xs text-amber-400/70 hover:text-amber-400 transition-colors">
                ⚠ Add your Poke API key to start chatting
              </button>
            </div>
          )}
          <div className="flex gap-2 items-end bg-[#12121A] border border-white/8 rounded-2xl px-4 py-3 focus-within:border-white/15 transition-colors">
            <button
              onClick={() => fileRef.current?.click()}
              className="text-white/30 hover:text-white/60 transition-colors mb-0.5 flex-shrink-0"
              title="Attach image"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" />
              </svg>
            </button>
            <input type="file" accept="image/*" ref={fileRef} className="hidden" onChange={(e) => handleImageFile(e.target.files[0])} />
            <textarea
              ref={textareaRef}
              rows={1}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder="Message Poke..."
              className="flex-1 bg-transparent text-white/85 placeholder-white/20 text-sm focus:outline-none leading-relaxed max-h-32 overflow-y-auto"
              style={{ minHeight: "22px" }}
            />
            <button
              onClick={sendMessage}
              disabled={sending || (!input.trim() && !pendingImage)}
              className="w-8 h-8 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-30 disabled:cursor-not-allowed transition-all flex items-center justify-center flex-shrink-0 shadow-md shadow-blue-900/40"
            >
              {sending ? (
                <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5">
                  <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5">
                  <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
                </svg>
              )}
            </button>
          </div>
          <p className="text-center text-white/15 text-[10px] mt-2">Enter to send · Shift+Enter for newline · Paste images</p>
        </div>
      </div>

      {showSettings && (
        <SettingsModal apiKey={apiKey} setApiKey={setApiKey} onClose={() => setShowSettings(false)} />
      )}
    </>
  );
}
