import "server-only";

export interface NewsItem {
  title: string;
  link: string;
  source: string;
  summary: string;
  date?: string;
}

/** Strip HTML/CDATA and clamp to a short original-style summary. */
function clean(text: string, max = 220): string {
  const stripped = text
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return stripped.length > max ? stripped.slice(0, max).trim() + "…" : stripped;
}

function tag(block: string, name: string): string {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, "i"));
  return m ? m[1] : "";
}

/** Only http(s) links are safe to turn into hrefs — reject javascript:, data:, etc. */
function isHttpUrl(value: string): boolean {
  try {
    const proto = new URL(value).protocol;
    return proto === "http:" || proto === "https:";
  } catch {
    return false;
  }
}

/** How long a fetched feed is reused before fetching it again. */
const FEED_TTL_MS = 60 * 60 * 1000;
const feedMemo = new Map<string, { at: number; items: NewsItem[] }>();

/**
 * Fetches finance/RBI headlines from a configurable RSS feed. /news renders per
 * request, so the parsed feed is kept in memory for an hour (per server
 * instance) instead of using Next's fetch cache — on Cloudflare the page cache
 * is read-only, so there's no ISR. A failed fetch isn't remembered.
 * Returns only headline + source + a short summary that links out (no full bodies).
 * Fails gracefully (empty list) if the feed is unreachable.
 */
export async function fetchNews(limit = 12): Promise<NewsItem[]> {
  const feedUrl =
    process.env.NEWS_RSS_URL ||
    process.env.NEXT_PUBLIC_NEWS_RSS ||
    "https://www.thehindubusinessline.com/money-and-banking/feeder/default.rss";
  const source = (() => {
    try {
      return new URL(feedUrl).hostname.replace(/^www\./, "");
    } catch {
      return "source";
    }
  })();

  // Only fetch http(s) feeds — guards against file:/other schemes via env misconfig.
  if (!isHttpUrl(feedUrl)) return [];

  const memo = feedMemo.get(feedUrl);
  if (memo && Date.now() - memo.at < FEED_TTL_MS) return memo.items.slice(0, limit);

  try {
    const res = await fetch(feedUrl, {
      cache: "no-store",
      headers: { "User-Agent": "LoanServ/1.0 (+https://loanserv.in)" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return [];
    const xml = await res.text();
    const blocks = xml.split(/<item[\s>]/i).slice(1);
    // Parse a fixed, generous number so the memo serves any `limit`.
    const items = blocks.slice(0, Math.max(limit, 24)).map((block) => {
      const title = clean(tag(block, "title"), 140);
      const link = clean(tag(block, "link") || tag(block, "guid"));
      const description = clean(tag(block, "description"));
      const date = clean(tag(block, "pubDate"), 40);
      return { title, link, source, summary: description, date };
    }).filter((i) => i.title && i.link && isHttpUrl(i.link));
    feedMemo.set(feedUrl, { at: Date.now(), items });
    return items.slice(0, limit);
  } catch {
    return [];
  }
}
