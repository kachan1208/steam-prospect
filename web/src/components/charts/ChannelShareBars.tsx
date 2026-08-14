import type { ChannelMixRow } from "../../lib/api";
import { fmtInt, fmtPct } from "../../lib/format";
import { channelColor, channelLabel, channelSortOrder } from "../../lib/palette";

/**
 * Compact channel-mix bars — one horizontal share bar per marketing channel (Press /
 * YouTube / Reddit / Twitch / X), colored by CHANNEL IDENTITY (the fixed validated slots in
 * lib/palette's channelColor — color follows the channel, never its rank), sorted by share.
 *
 * The bar encodes share of MENTION VOLUME (share_mentions) on an absolute 0-100% track —
 * shares sum to 1 across channels, so bar lengths read as the whole split. The
 * reach-weighted share deliberately rides in the hover title instead of the bar: on real
 * data it collapses to ~100% for the biggest-audience channel (a creator mention counts
 * their whole subscriber base, a press article counts 1), which as a bar would erase every
 * other channel. Div-based meters (BulletMeter's pattern), not Recharts — this is a
 * five-row KPI split, not a chart that needs axes.
 */
export function ChannelShareBars({ channels }: { channels: ChannelMixRow[] }) {
  const rows = [...channels].sort(
    (a, b) =>
      (b.share_mentions ?? 0) - (a.share_mentions ?? 0) ||
      channelSortOrder(a.channel) - channelSortOrder(b.channel),
  );
  return (
    <div className="flex flex-col gap-2.5">
      {rows.map((r) => (
        <div
          key={r.channel}
          title={`${channelLabel(r.channel)}: ${fmtInt(r.n_mentions)} tracked mentions (${fmtPct(
            r.share_mentions,
          )} of volume) · ${fmtPct(r.share_reach_weighted)} of audience-weighted reach`}
        >
          <div className="mb-1 flex items-baseline justify-between text-xs">
            <span className="inline-flex items-center gap-1.5 text-ink-secondary">
              <span
                aria-hidden
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: channelColor(r.channel) }}
              />
              {channelLabel(r.channel)}
            </span>
            <span className="tabular font-medium text-ink-primary">{fmtPct(r.share_mentions, 0)}</span>
          </div>
          <div className="h-1.5 rounded-full bg-line-grid">
            <div
              className="h-full rounded-full"
              style={{
                width: `${Math.max(0, Math.min(100, (r.share_mentions ?? 0) * 100))}%`,
                backgroundColor: channelColor(r.channel),
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
