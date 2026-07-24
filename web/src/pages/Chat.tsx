import { useState } from "react";

import { Card } from "../components/ui/Card";

// The deployed app serves the MCP from its own origin at /mcp/ (trailing slash is canonical;
// /mcp 307-redirects to it). Deriving from window.location.origin keeps this correct wherever
// Prospect is hosted.
const MCP_URL = `${window.location.origin}/mcp/`;

const CAPABILITIES = [
  "Find under-served niches — demand vs. competition vs. quality gap",
  "Benchmark the market — median revenue, review counts, price bands",
  "Estimate revenue for a given price × review-count scenario",
  "Check launch timing & seasonality for a genre",
  "Look up or compare specific games",
  "Build press & creator pitch lists across Press, YouTube, Reddit, Twitch & X",
];

function CopyField({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — the text is selectable anyway */
    }
  };
  return (
    <div className="flex items-stretch gap-2">
      <code className="flex-1 overflow-x-auto whitespace-pre rounded-md border border-chartborder bg-page px-3 py-2 text-xs leading-relaxed text-ink-primary">
        {value}
      </code>
      <button
        type="button"
        onClick={copy}
        className="shrink-0 self-start rounded-md bg-series-1 px-3 py-2 text-[11px] font-semibold text-white transition-opacity hover:opacity-90"
      >
        {copied ? "Copied" : label ?? "Copy"}
      </button>
    </div>
  );
}

function ClientBlock({
  name,
  badge,
  children,
}: {
  name: string;
  badge?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2.5 border-t border-chartborder pt-4 first:border-t-0 first:pt-0">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold text-ink-primary">{name}</h3>
        {badge && (
          <span className="rounded-full bg-page px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-ink-muted">
            {badge}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

export default function Chat() {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-10">
      <div>
        <h1 className="text-lg font-semibold text-ink-primary">Use Prospect in your Claude</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Connect Prospect&apos;s market-intelligence tools to your own Claude — Desktop, Code, or
          claude.ai — and just ask. Answers come straight from Prospect&apos;s Steam marts, running on
          your own Claude. No API key, nothing to install on our side.
        </p>
      </div>

      {/* Server URL */}
      <div data-tour="tour-chat-mcp">
        <Card className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-ink-primary">MCP server URL</h2>
            <span className="text-[11px] text-ink-muted">Streamable HTTP · read-only · no auth</span>
          </div>
          <CopyField value={MCP_URL} label="Copy URL" />
        </Card>
      </div>

      {/* What you can ask */}
      <Card className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-ink-primary">What you can ask</h2>
        <ul className="grid gap-2 sm:grid-cols-2">
          {CAPABILITIES.map((c) => (
            <li key={c} className="flex items-start gap-2 text-xs text-ink-secondary">
              <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-series-1" />
              {c}
            </li>
          ))}
        </ul>
      </Card>

      {/* Connect */}
      <Card className="flex flex-col gap-4">
        <h2 className="text-sm font-semibold text-ink-primary">Add it to Claude</h2>

        <ClientBlock name="Claude Code" badge="CLI">
          <p className="text-xs text-ink-muted">Run this once — it registers Prospect for every session:</p>
          <CopyField value={`claude mcp add --transport http prospect ${MCP_URL}`} />
        </ClientBlock>

        <ClientBlock name="claude.ai / Claude Desktop" badge="Custom connector">
          <ol className="list-decimal space-y-1 pl-4 text-xs text-ink-secondary">
            <li>
              Open <span className="text-ink-primary">Settings → Connectors</span> and click{" "}
              <span className="text-ink-primary">Add custom connector</span>.
            </li>
            <li>
              Paste the MCP server URL above, name it <span className="text-ink-primary">Prospect</span>, and
              connect.
            </li>
            <li>In a chat, enable the Prospect connector and ask away.</li>
          </ol>
          <p className="text-[11px] text-ink-muted">
            Custom connectors need a Claude Pro, Max, Team, or Enterprise plan.
          </p>
        </ClientBlock>

        <ClientBlock name="Claude Desktop" badge="Config file">
          <p className="text-xs text-ink-muted">
            Prefer editing the config directly? Add this under{" "}
            <code className="rounded bg-page px-1 py-0.5 text-ink-secondary">mcpServers</code> (uses the{" "}
            <code className="rounded bg-page px-1 py-0.5 text-ink-secondary">mcp-remote</code> bridge):
          </p>
          <CopyField
            value={`"prospect": {\n  "command": "npx",\n  "args": ["mcp-remote", "${MCP_URL}"]\n}`}
          />
        </ClientBlock>
      </Card>

      <p className="px-1 text-[11px] text-ink-muted">
        Prospect exposes 15 read-only analytics tools plus a data-dictionary resource — ask Claude to read
        the dictionary first for definitions of opportunity, demand, competition, and quality-gap.
      </p>
    </div>
  );
}
