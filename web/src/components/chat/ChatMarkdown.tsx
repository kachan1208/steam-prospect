import type { ReactNode } from "react";
import clsx from "clsx";

/**
 * A small Markdown-ish renderer for assistant chat answers: paragraphs, **bold**,
 * *italic*, `code`, bullet/numbered lists, `##`/`###` headings, and GFM-style pipe
 * tables. This is a purpose-built line parser for what the chat model actually
 * produces (see api/app/routers/chat.py's SYSTEM_PROMPT) — not a general Markdown
 * engine, and deliberately has no external dependency.
 */

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  // Order matters: code first (so ** inside `code` isn't touched), then bold, then italic.
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let i = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    if (match[1] !== undefined) {
      nodes.push(
        <code key={`${keyPrefix}-${i}`} className="rounded bg-page px-1 py-0.5 text-[0.85em] text-ink-primary">
          {match[1]}
        </code>,
      );
    } else if (match[2] !== undefined) {
      nodes.push(
        <strong key={`${keyPrefix}-${i}`} className="font-semibold text-ink-primary">
          {match[2]}
        </strong>,
      );
    } else if (match[3] !== undefined) {
      nodes.push(<em key={`${keyPrefix}-${i}`}>{match[3]}</em>);
    }
    last = pattern.lastIndex;
    i += 1;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(line);
}

function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((c) => c.trim());
}

const HEADING_RE = /^(#{1,4})\s+(.*)$/;
const BULLET_RE = /^\s*[-*]\s+(.*)$/;
const NUMBERED_RE = /^\s*\d+[.)]\s+(.*)$/;

export function ChatMarkdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let blockKey = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") {
      i += 1;
      continue;
    }

    // Table: a "| ... |" row followed by a "| --- | --- |" separator row.
    if (line.trim().startsWith("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const header = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        rows.push(splitRow(lines[i]));
        i += 1;
      }
      blockKey += 1;
      blocks.push(
        <div key={`b${blockKey}`} className="my-2 overflow-x-auto">
          <table className="w-full min-w-[320px] border-collapse text-xs">
            <thead>
              <tr className="border-b border-chartborder text-left text-ink-muted">
                {header.map((h, ci) => (
                  <th key={ci} className="whitespace-nowrap px-2 py-1 font-medium">
                    {renderInline(h, `th${blockKey}-${ci}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri} className="border-b border-chartborder/60">
                  {r.map((c, ci) => (
                    <td key={ci} className="px-2 py-1 align-top text-ink-secondary">
                      {renderInline(c, `td${blockKey}-${ri}-${ci}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // Heading
    const headingMatch = HEADING_RE.exec(line);
    if (headingMatch) {
      const level = headingMatch[1].length;
      blockKey += 1;
      blocks.push(
        <p
          key={`b${blockKey}`}
          className={clsx("mt-2 text-ink-primary first:mt-0", level <= 2 ? "text-sm font-semibold" : "text-xs font-semibold")}
        >
          {renderInline(headingMatch[2], `h${blockKey}`)}
        </p>,
      );
      i += 1;
      continue;
    }

    // List (bullet or numbered) — consume consecutive list lines of the same kind.
    const bulletMatch = BULLET_RE.exec(line);
    const numberedMatch = NUMBERED_RE.exec(line);
    if (bulletMatch || numberedMatch) {
      const ordered = !!numberedMatch;
      const items: string[] = [];
      while (i < lines.length) {
        const m = ordered ? NUMBERED_RE.exec(lines[i]) : BULLET_RE.exec(lines[i]);
        if (!m) break;
        items.push(m[1]);
        i += 1;
      }
      blockKey += 1;
      const ListTag = ordered ? "ol" : "ul";
      blocks.push(
        <ListTag
          key={`b${blockKey}`}
          className={clsx("my-1.5 space-y-0.5 pl-4 text-ink-secondary", ordered ? "list-decimal" : "list-disc")}
        >
          {items.map((it, ii) => (
            <li key={ii}>{renderInline(it, `li${blockKey}-${ii}`)}</li>
          ))}
        </ListTag>,
      );
      continue;
    }

    // Paragraph: consume consecutive plain lines, joining with <br /> for soft line breaks.
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].trim().startsWith("|") &&
      !HEADING_RE.test(lines[i]) &&
      !BULLET_RE.test(lines[i]) &&
      !NUMBERED_RE.test(lines[i])
    ) {
      paraLines.push(lines[i]);
      i += 1;
    }
    blockKey += 1;
    blocks.push(
      <p key={`b${blockKey}`} className="my-1 leading-relaxed text-ink-secondary first:mt-0">
        {paraLines.map((pl, pi) => (
          <span key={pi}>
            {pi > 0 && <br />}
            {renderInline(pl, `p${blockKey}-${pi}`)}
          </span>
        ))}
      </p>,
    );
  }

  return <div className="text-sm">{blocks}</div>;
}
