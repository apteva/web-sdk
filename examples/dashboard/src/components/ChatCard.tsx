import { useEffect, useMemo, useRef, useState } from "react";
import { MessageSquare, Play, Send, Square } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AptevaError } from "@apteva/web-sdk";
import type { Agent, Chat, ChatMessage, StreamFrame, StreamHandle } from "@apteva/web-sdk";
import { apteva } from "../lib/apteva";

// Optionally pin the chat to a specific agent via the AGENT_ID build
// env. Empty → fall back to the first agent the server returns.
declare const __AGENT_ID__: string;
const TARGET_AGENT_ID = __AGENT_ID__ ? Number(__AGENT_ID__) : null;

// Reference chat UI built entirely on @apteva/web-sdk's chat namespace.
// Demonstrates the full loop: pick an agent → create/get its chat →
// load history → live-stream → optimistic send. Streaming bubbles are
// assembled from onDelta frames keyed by call_id.
//
// Simplification worth knowing: when a final agent message lands we
// clear the streaming buffers wholesale rather than matching each
// buffer to its final row (the SSE deltas carry call_id, the final
// ChatMessage carries a numeric id — no shared key). Fine for a
// turn-based chat; a production UI would thread call_id through.

interface DisplayMessage {
  key: string;
  role: ChatMessage["role"];
  content: string;
  streaming: boolean;
  thinking?: boolean;
}

export function ChatCard() {
  const [chat, setChat] = useState<Chat | null>(null);
  const [agent, setAgent] = useState<Agent | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streamBuffers, setStreamBuffers] = useState<Record<string, string>>({});
  const [thinkingSince, setThinkingSince] = useState<number | null>(null);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [lifecycleBusy, setLifecycleBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const subRef = useRef<StreamHandle | null>(null);

  // Boot: first agent → its default chat → history → live stream.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const agents = await apteva.agents.list();
        if (agents.length === 0) {
          setError("No agents on this server — create one first.");
          setLoading(false);
          return;
        }
        const agent =
          TARGET_AGENT_ID !== null
            ? agents.find((a) => a.id === TARGET_AGENT_ID)
            : agents[0];
        if (!agent) {
          setError(`Agent #${TARGET_AGENT_ID} not found on this server.`);
          setLoading(false);
          return;
        }
        const c = await apteva.chat.create(agent.id);
        const history = await apteva.chat.messages(c.id, { limit: 200 });
        if (cancelled) return;
        setAgent(agent);
        setChat(c);
        setMessages(history);
        setLoading(false);

        subRef.current = apteva.chat.stream(c.id, {
          since: history.length ? history[history.length - 1]!.id : 0,
          onMessage: (m) => {
            // Upsert by id; a final agent row clears streaming buffers
            // and the thinking indicator — the conversation has caught up.
            setMessages((prev) => {
              const next = prev.filter((p) => p.id !== m.id);
              next.push(m);
              return next;
            });
            if (m.role === "agent" && m.status === "final") {
              setStreamBuffers({});
              setThinkingSince(null);
            }
          },
          onDelta: (f: StreamFrame) => {
            // f.text is the FULL accumulated response so far, not a
            // delta — replace, don't append. (From the dashboard's
            // ChatPanel: "Frames carry monotonically growing text;
            // setting state to the latest is enough, no reducer.")
            setStreamBuffers((prev) => ({ ...prev, [f.call_id]: f.text }));
          },
        });

        // Thinking indicator: driven client-side off send→reply, not
        // off telemetry. Empirically, not every agent setup emits
        // llm.start (the dashboard's chosen signal), and event-shape
        // can drift across versions. Using the events we DO control
        // — user send and final agent message arrival — is both
        // reliable and simpler.
      } catch (err) {
        if (cancelled) return;
        setError(
          err instanceof AptevaError ? err.body || `error ${err.status}` : "failed to load chat",
        );
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      subRef.current?.close();
    };
  }, []);

  // Merge persisted rows + in-flight streaming buffers into one list.
  // Sort by created_at (ISO-8601 strings sort lexically), id as tiebreaker.
  // Chronological order keeps optimistic temp rows at the bottom while
  // they're pending, regardless of the temp id's sign.
  const display = useMemo<DisplayMessage[]>(() => {
    const rows: DisplayMessage[] = messages
      .slice()
      .sort((a, b) => {
        const ca = a.created_at.localeCompare(b.created_at);
        return ca !== 0 ? ca : a.id - b.id;
      })
      .map((m) => ({
        key: `msg-${m.id}`,
        role: m.role,
        content: m.content,
        streaming: m.status === "streaming",
      }));
    for (const [callId, text] of Object.entries(streamBuffers)) {
      if (text) rows.push({ key: `stream-${callId}`, role: "agent", content: text, streaming: true });
    }
    // Inline thinking placeholder — shown only when we're waiting for
    // a reply and no streaming text has arrived yet. The streaming
    // bubble takes over as soon as the first frame lands.
    if (thinkingSince !== null && Object.keys(streamBuffers).length === 0) {
      rows.push({ key: "thinking", role: "agent", content: "", streaming: true, thinking: true });
    }
    return rows;
  }, [messages, streamBuffers, thinkingSince]);

  // Auto-scroll to the newest message.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [display]);

  const send = async () => {
    const text = input.trim();
    if (!text || !chat || sending) return;
    setInput("");
    setSending(true);
    setThinkingSince(Date.now()); // cleared when the agent's final reply lands
    // Optimistic: temp negative id so it can't collide with a real row.
    const tempId = -Date.now();
    setMessages((prev) => [
      ...prev,
      {
        id: tempId,
        chat_id: chat.id,
        role: "user",
        content: text,
        status: "final",
        created_at: new Date().toISOString(),
        components: [],
      },
    ]);
    try {
      const real = await apteva.chat.send(chat.id, text);
      // Swap the temp row for the persisted one. Dedupe against
      // real.id too — the SSE stream may have already delivered this
      // message via onMessage between the POST going out and coming
      // back. Without filtering real.id we'd end up with two copies.
      setMessages((prev) =>
        prev
          .filter((m) => m.id !== tempId && m.id !== real.id)
          .concat(real),
      );
    } catch (err) {
      setMessages((prev) => prev.filter((m) => m.id !== tempId));
      setError(
        err instanceof AptevaError ? err.body || `error ${err.status}` : "failed to send",
      );
    } finally {
      setSending(false);
    }
  };

  // Start or stop the agent process. start/stop both return the
  // updated Agent, so we just swap it into state.
  const toggleAgent = async () => {
    if (!agent || lifecycleBusy) return;
    setLifecycleBusy(true);
    setError(null);
    try {
      const updated =
        agent.status === "running"
          ? await apteva.agents.stop(agent.id)
          : await apteva.agents.start(agent.id);
      setAgent(updated);
    } catch (err) {
      setError(
        err instanceof AptevaError
          ? err.body || `error ${err.status}`
          : "agent lifecycle call failed",
      );
    } finally {
      setLifecycleBusy(false);
    }
  };

  const running = agent?.status === "running";

  return (
    <section className="surface flex flex-col" style={{ height: 480 }}>
      <header className="flex items-center gap-2 px-5 py-4 border-b border-[var(--color-border)]">
        <MessageSquare size={16} className="t-secondary" />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold t-primary">Chat</h2>
          <p className="text-xs t-tertiary mt-0.5 truncate flex items-center gap-1.5">
            {agent ? (
              <>
                <span
                  className={
                    "w-1.5 h-1.5 rounded-full shrink-0 " +
                    (running ? "bg-[var(--color-green)]" : "bg-[var(--color-text-tertiary)]")
                  }
                />
                Agent: {agent.name} · {agent.status}
              </>
            ) : (
              "channel-chat · live"
            )}
          </p>
        </div>
        {agent && (
          <button
            type="button"
            onClick={toggleAgent}
            disabled={lifecycleBusy}
            className="btn-ghost flex items-center gap-1.5 shrink-0"
            title={running ? "Stop the agent process" : "Start the agent process"}
          >
            {running ? <Square size={13} /> : <Play size={13} />}
            {lifecycleBusy ? "…" : running ? "Stop" : "Start"}
          </button>
        )}
      </header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
        {error ? (
          <div className="text-xs text-[var(--color-red)] bg-[var(--color-red-light)] rounded-lg px-3 py-2">
            {error}
          </div>
        ) : loading ? (
          <div className="text-xs t-tertiary py-8 text-center">Loading…</div>
        ) : display.length === 0 ? (
          <div className="text-xs t-tertiary py-10 text-center">
            No messages yet. Say hello below.
          </div>
        ) : (
          display.map((m) => <Bubble key={m.key} msg={m} />)
        )}
      </div>


      <form
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
        className="flex items-center gap-2 px-5 py-3 border-t border-[var(--color-border)]"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={loading || !!error || !chat}
          placeholder={chat ? "Message the agent…" : "Chat unavailable"}
          className="input flex-1"
        />
        <button
          type="submit"
          disabled={!input.trim() || sending || !chat}
          className="btn-primary h-9 px-3 flex items-center gap-1.5 shrink-0"
        >
          <Send size={14} />
        </button>
      </form>
    </section>
  );
}

function Bubble({ msg }: { msg: DisplayMessage }) {
  const mine = msg.role === "user";
  if (msg.role === "system") {
    return (
      <div className="text-center">
        <span className="text-[11px] t-tertiary bg-[var(--color-slate-light)] rounded-full px-2.5 py-1">
          {msg.content}
        </span>
      </div>
    );
  }
  // Empty-content streaming agent bubble = "thinking" placeholder.
  if (msg.thinking) {
    return (
      <div className="flex justify-start">
        <div className="surface-inset rounded-2xl px-3.5 py-2.5 inline-flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-text-tertiary)] animate-pulse" />
          <span
            className="w-1.5 h-1.5 rounded-full bg-[var(--color-text-tertiary)] animate-pulse"
            style={{ animationDelay: "150ms" }}
          />
          <span
            className="w-1.5 h-1.5 rounded-full bg-[var(--color-text-tertiary)] animate-pulse"
            style={{ animationDelay: "300ms" }}
          />
        </div>
      </div>
    );
  }
  return (
    <div className={`flex ${mine ? "justify-end" : "justify-start"}`}>
      <div
        className={
          "max-w-[78%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed break-words " +
          (mine
            ? "bg-[var(--color-accent)] text-white whitespace-pre-wrap"
            : "surface-inset t-primary")
        }
      >
        {mine ? (
          msg.content
        ) : (
          // Agent messages — render markdown (bold, lists, code, links,
          // tables via GFM). Mid-stream partial markdown is handled
          // gracefully by react-markdown.
          <div className="markdown-body">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {msg.content}
            </ReactMarkdown>
          </div>
        )}
        {msg.streaming && (
          <span className="inline-block w-1.5 h-3.5 ml-0.5 align-middle bg-current opacity-50 animate-pulse" />
        )}
      </div>
    </div>
  );
}

