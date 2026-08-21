import clsx from "clsx";

/** Brand glyphs as inline SVG. Four icons do not justify an icon-library dependency, and
 * inlining keeps them themeable — each path uses `currentColor`, so the links inherit the
 * surrounding ink colour and work in both themes without a second palette. */
const PATHS = {
  x: "M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z",
  discord:
    "M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z",
  youtube:
    "M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z",
  bluesky:
    "M12 10.8c-1.087-2.114-4.046-6.053-6.798-7.995C2.566.944 1.561 1.266.902 1.565.139 1.908 0 3.08 0 3.768c0 .69.378 5.65.624 6.479.815 2.736 3.713 3.66 6.383 3.364.136-.02.275-.039.415-.056-.138.022-.276.04-.415.056-3.912.58-7.387 2.005-2.83 7.078 5.013 5.19 6.87-1.113 7.823-4.308.953 3.195 2.05 9.271 7.733 4.308 4.267-4.308 1.172-6.498-2.74-7.078a8.741 8.741 0 0 1-.415-.056c.14.017.279.036.415.056 2.67.297 5.568-.628 6.383-3.364.246-.828.624-5.79.624-6.478 0-.69-.139-1.861-.902-2.206-.659-.298-1.664-.62-4.3 1.24C16.046 4.748 13.087 8.687 12 10.8Z",
} as const;

type Platform = keyof typeof PATHS;

const LABELS: Record<Platform, string> = {
  x: "X (Twitter)",
  discord: "Discord",
  youtube: "YouTube",
  bluesky: "Bluesky",
};

export function SocialIcon({ platform, className }: { platform: Platform; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className={clsx("h-3.5 w-3.5 shrink-0", className)}
    >
      <path d={PATHS[platform]} />
    </svg>
  );
}

export interface SocialLinksProps {
  x?: string | null;
  xUrl?: string | null;
  discordUrl?: string | null;
  youtubeUrl?: string | null;
  bluesky?: string | null;
  blueskyUrl?: string | null;
  className?: string;
}

/** Official links harvested from the developer's OWN pages (store page + dev website) — never
 * from the platforms themselves, so an account may belong to the game, the studio, or the
 * developer personally. Renders nothing when a game has no links, rather than empty slots:
 * absence here means "none found / not yet fetched", which is not worth a row of dead icons. */
export function SocialLinks({
  x,
  xUrl,
  discordUrl,
  youtubeUrl,
  bluesky,
  blueskyUrl,
  className,
}: SocialLinksProps) {
  const links: Array<{ platform: Platform; href: string; label: string }> = [];
  if (x) links.push({ platform: "x", href: xUrl || `https://x.com/${x}`, label: `@${x} on X` });
  if (discordUrl) links.push({ platform: "discord", href: discordUrl, label: "Discord server" });
  if (youtubeUrl) links.push({ platform: "youtube", href: youtubeUrl, label: "YouTube channel" });
  if (bluesky || blueskyUrl)
    links.push({
      platform: "bluesky",
      href: blueskyUrl || `https://bsky.app/profile/${bluesky}`,
      label: bluesky ? `@${bluesky} on Bluesky` : "Bluesky",
    });
  if (links.length === 0) return null;

  return (
    <div className={clsx("flex items-center gap-1", className)}>
      {links.map((l) => (
        <a
          key={l.platform}
          href={l.href}
          target="_blank"
          rel="noreferrer"
          title={`${LABELS[l.platform]} — ${l.label}. Linked from the game's own Steam page or developer site; may be the game's, the studio's, or the developer's personal account.`}
          aria-label={l.label}
          className="inline-flex items-center gap-1 border border-chartborder px-1.5 py-0.5 text-ink-secondary transition-colors hover:border-ink-muted hover:text-ink-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1"
        >
          <SocialIcon platform={l.platform} />
          {l.platform === "x" && x ? (
            <span className="text-[11px] leading-none">@{x}</span>
          ) : null}
        </a>
      ))}
    </div>
  );
}
