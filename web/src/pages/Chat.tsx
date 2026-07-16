import { useEffect, useRef, useState } from "react";
import clsx from "clsx";

import { Card } from "../components/ui/Card";
import { ChatMarkdown } from "../components/chat/ChatMarkdown";
import { useChatStatus, useChatStream } from "../lib/api";

const EXAMPLE_PROMPTS = [
  "What's the best under-served niche right now?",
  "Estimate revenue for a $14.99 game with 500 reviews",
  "Who should I pitch for RPG press coverage?",
  "When's the best time of year to launch a roguelike?",
];

function ToolActivity({ name }: { name: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-chartborder bg-page px-2.5 py-1 text-[11px] text-ink-muted">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-series-1" />
      calling <code className="text-ink-secondary">{name}</code>…
    </span>
  );
}

function ThinkingDots() {
  return (
    <span className="inline-flex items-center gap-1 text-xs text-ink-muted">
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-ink-muted [animation-delay:-0.2s]" />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-ink-muted [animation-delay:-0.1s]" />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-ink-muted" />
    </span>
  );
}

function EmptyNoKeyState({ unreachable }: { unreachable?: boolean }) {
  return (
    <Card className="flex flex-col items-center gap-3 py-12 text-center">
      <div className="flex h-10 w-10 items-center justify-center rounded-full border border-chartborder text-ink-muted">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
          <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5Z" />
        </svg>
      </div>
      {unreachable ? (
        <>
          <h2 className="text-sm font-semibold text-ink-primary">Can&apos;t reach the API</h2>
          <p className="max-w-sm text-xs text-ink-muted">
            The Prospect API isn&apos;t responding. Make sure it&apos;s running, then reload this page.
          </p>
        </>
      ) : (
        <>
          <h2 className="text-sm font-semibold text-ink-primary">Sign in to Claude Code to start chatting</h2>
          <p className="max-w-sm text-xs text-ink-muted">
            Analytics Chat answers questions using real numbers from your marts. It runs on your Claude Code subscription — no API key needed.
          </p>
          <div className="mt-1 w-full max-w-md rounded-md border border-chartborder bg-page p-3 text-left text-[11px] text-ink-secondary">
            <ol className="list-decimal space-y-1.5 pl-4">
              <li>
                Install{" "}
                <a className="text-series-1 underline" href="https://claude.com/claude-code" target="_blank" rel="noreferrer">
                  Claude Code
                </a>{" "}
                if you haven&apos;t, then run <code className="rounded bg-surface px-1 py-0.5 text-ink-primary">claude</code> once to sign in with your subscription.
              </li>
              <li>Restart the API.</li>
              <li>Reload this page.</li>
            </ol>
          </div>
        </>
      )}
    </Card>
  );
}

export default function Chat() {
  const { data: status, isLoading: statusLoading, isError: statusError } = useChatStatus();
  const { turns, isStreaming, activeTool, error, send, stop, reset } = useChatStream();
  const [input, setInput] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, activeTool]);

  const ready = status?.ready ?? false;

  const submit = () => {
    if (!input.trim() || isStreaming) return;
    send(input);
    setInput("");
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="flex h-[calc(100vh-140px)] min-h-[480px] flex-col gap-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold text-ink-primary">Analytics Chat</h1>
          <p className="mt-0.5 text-sm text-ink-muted">
            Ask about niches, revenue benchmarks, specific games, or press contacts — answers are grounded in Prospect&apos;s marts.
          </p>
        </div>
        {turns.length > 0 && (
          <button
            type="button"
            onClick={reset}
            className="shrink-0 rounded-md border border-chartborder px-2.5 py-1.5 text-xs font-medium text-ink-secondary hover:text-ink-primary"
          >
            New chat
          </button>
        )}
      </div>

      {statusLoading ? (
        <Card className="py-10 text-center text-sm text-ink-muted">Checking chat availability…</Card>
      ) : statusError ? (
        <EmptyNoKeyState unreachable />
      ) : !ready ? (
        <EmptyNoKeyState />
      ) : (
        <Card className="flex min-h-0 flex-1 flex-col !p-0">
          <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
            {turns.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
                <p className="text-sm text-ink-muted">Try asking:</p>
                <div className="flex max-w-md flex-wrap justify-center gap-2">
                  {EXAMPLE_PROMPTS.map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => send(p)}
                      className="rounded-full border border-chartborder px-3 py-1.5 text-xs text-ink-secondary transition-colors hover:border-series-1 hover:text-ink-primary"
                    >
                      {p}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-4">
                {turns.map((t, idx) => {
                  const isLast = idx === turns.length - 1;
                  const isEmptyAssistant = t.role === "assistant" && t.content === "";
                  // An empty assistant bubble only earns screen space while it's actively
                  // streaming (thinking dots / tool activity). If a turn ended with no
                  // text at all — e.g. it errored before any output — skip it; the error
                  // banner below already explains what happened.
                  if (isEmptyAssistant && !(isLast && isStreaming)) return null;
                  return (
                    <div key={idx} className={clsx("flex flex-col gap-1", t.role === "user" ? "items-end" : "items-start")}>
                      <span className="px-1 text-[10px] font-medium uppercase tracking-wide text-ink-muted">
                        {t.role === "user" ? "You" : "Prospect"}
                      </span>
                      {t.role === "user" ? (
                        <div className="max-w-[80%] rounded-lg rounded-tr-sm bg-page px-3 py-2 text-sm text-ink-primary">{t.content}</div>
                      ) : (
                        <div className="max-w-[85%] rounded-lg rounded-tl-sm border border-chartborder px-3 py-2">
                          {t.content ? <ChatMarkdown text={t.content} /> : <ThinkingDots />}
                          {isLast && isStreaming && activeTool && (
                            <div className="mt-2">
                              <ToolActivity name={activeTool} />
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {error && (
            <div className="border-t border-chartborder bg-page px-4 py-2 text-xs text-status-serious">{error}</div>
          )}

          <div className="border-t border-chartborder p-3">
            <div className="flex items-end gap-2">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder="Ask about niches, games, revenue, press…"
                rows={2}
                disabled={isStreaming}
                className="flex-1 resize-none rounded-md border border-chartborder bg-page px-3 py-2 text-sm text-ink-primary outline-none placeholder:text-ink-muted focus:border-series-1 disabled:opacity-60"
              />
              {isStreaming ? (
                <button
                  type="button"
                  onClick={stop}
                  className="shrink-0 rounded-md border border-chartborder px-3 py-2 text-xs font-medium text-ink-secondary hover:text-ink-primary"
                >
                  Stop
                </button>
              ) : (
                <button
                  type="button"
                  onClick={submit}
                  disabled={!input.trim()}
                  className="shrink-0 rounded-md bg-series-1 px-3.5 py-2 text-xs font-semibold text-white transition-opacity disabled:opacity-40"
                >
                  Send
                </button>
              )}
            </div>
            <p className="mt-1.5 px-0.5 text-[10px] text-ink-muted">Enter to send · Shift+Enter for a new line</p>
          </div>
        </Card>
      )}
    </div>
  );
}
