import { XMLBuilder, XMLParser } from "fast-xml-parser";
import { parseHTML } from "linkedom";
import {
  decodeHtmlEntities,
  resolveSafeUrl,
  safeFetchText,
  sanitizeArticleHtml,
  stripHtmlToText,
} from "../lib/net";
import type { FeedItem, FeedResponse } from "../lib/types";

type XmlNode = Record<string, unknown>;

// Fast enough for a feed and small enough to bundle on Workers. rss-parser was replaced because it
// pulls node:http/https/streams and xml2js (which needs node:events + timers); this stays Web-only.
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "_",
  trimValues: true,
  processEntities: true,
  parseTagValue: false,
  parseAttributeValue: false,
});
const builder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "_",
  format: false,
});

/** Element text, or the re-serialised children for Atom's `<content type="xhtml">` form. */
function nodeText(node: unknown): string | undefined {
  if (typeof node === "string") return node;
  if (typeof node === "number" || typeof node === "boolean") return String(node);
  if (!node || typeof node !== "object") return undefined;
  const element = node as XmlNode;
  const text = element._;
  if (typeof text === "string" || typeof text === "number") return String(text);
  const children = Object.keys(element).filter((key) => !key.startsWith("@_"));
  if (!children.length) return undefined;
  return builder.build(Object.fromEntries(children.map((key) => [key, element[key]])));
}

function nodeAttr(node: unknown, name: string): string | undefined {
  if (!node || typeof node !== "object") return undefined;
  const value = (node as XmlNode)[`@_${name}`];
  return typeof value === "string" ? value : undefined;
}

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function child(node: unknown, key: string): unknown {
  if (!node || typeof node !== "object") return undefined;
  return (node as XmlNode)[key];
}

function isoOrUndefined(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}

/** Every `<media:thumbnail>` / `<media:content>` / `<link rel="enclosure">` URL, in document order. */
function mediaUrls(node: unknown, baseUrl: string): string[] {
  const urls = [
    // Thumbnail before content: the thumbnail is the deliberately cropped 1:1 art.
    ...asArray(child(node, "media:thumbnail")).map((entry) => nodeAttr(entry, "url")),
    ...asArray(child(node, "media:content")).map((entry) => nodeAttr(entry, "url")),
    ...asArray(child(node, "link"))
      .filter((entry) => nodeAttr(entry, "rel") === "enclosure")
      .map((entry) => nodeAttr(entry, "href")),
  ];
  return urls
    .map((url) => resolveSafeUrl(url, baseUrl))
    .filter((url): url is string => Boolean(url));
}

interface RawItem {
  id?: string;
  title?: string;
  link?: string;
  isoDate?: string;
  author?: string;
  /** Description / summary text, used for the card teaser when present. */
  summaryHtml?: string;
  /** Unsanitised body HTML: content:encoded / Atom content, falling back to the description or summary. */
  bodyHtml?: string;
  enclosureUrl?: string;
  enclosureType?: string;
  media: string[];
}

interface RawFeed {
  title?: string;
  description?: string;
  link?: string;
  items: RawItem[];
}

function atomLink(node: unknown): string | undefined {
  const links = asArray(child(node, "link"));
  const alternate = links.find((entry) => (nodeAttr(entry, "rel") ?? "alternate") === "alternate");
  return nodeAttr(alternate ?? links[0], "href");
}

function parseAtomEntry(entry: unknown, baseUrl: string): RawItem {
  const content = nodeText(child(entry, "content"));
  const summary = nodeText(child(entry, "summary"));
  const enclosureLink = asArray(child(entry, "link")).find(
    (link) => nodeAttr(link, "rel") === "enclosure",
  );
  return {
    id: nodeText(child(entry, "id")),
    title: nodeText(child(entry, "title")),
    link: atomLink(entry),
    isoDate: isoOrUndefined(
      nodeText(child(entry, "published")) ?? nodeText(child(entry, "updated")),
    ),
    author: nodeText(child(child(entry, "author"), "name")) ?? nodeText(child(entry, "author")),
    // Same teaser source the rss-parser path used: Atom's contentSnippet came from <content>,
    // falling back to <summary>.
    summaryHtml: content ?? summary,
    bodyHtml: content ?? summary,
    enclosureUrl: resolveSafeUrl(nodeAttr(enclosureLink, "href"), baseUrl),
    enclosureType: nodeAttr(enclosureLink, "type"),
    media: mediaUrls(entry, baseUrl),
  };
}

function parseRssItem(item: unknown, baseUrl: string): RawItem {
  const description = nodeText(child(item, "description"));
  const encoded = nodeText(child(item, "content:encoded"));
  return {
    id: nodeText(child(item, "guid")) ?? nodeText(child(item, "id")),
    title: nodeText(child(item, "title")),
    link: nodeText(child(item, "link")) ?? nodeAttr(child(item, "link"), "href"),
    isoDate: isoOrUndefined(nodeText(child(item, "pubDate")) ?? nodeText(child(item, "dc:date"))),
    author: nodeText(child(item, "dc:creator")) ?? nodeText(child(item, "author")),
    summaryHtml: description,
    bodyHtml: encoded ?? description,
    enclosureUrl: resolveSafeUrl(nodeAttr(child(item, "enclosure"), "url"), baseUrl),
    enclosureType: nodeAttr(child(item, "enclosure"), "type"),
    media: mediaUrls(item, baseUrl),
  };
}

/**
 * RSS 2.0 / RSS 1.0 (RDF) / Atom → the one shape the UI consumes. Throws when the document is not
 * a feed, which the handler turns into a 400 with the parser's message.
 */
function parseFeed(xml: string, baseUrl: string): RawFeed {
  const doc = parser.parse(xml) as XmlNode;
  const rss = child(doc, "rss");
  const rdf = child(doc, "rdf:RDF");
  const atom = child(doc, "feed");

  if (rss || rdf) {
    const channel = child(rss ?? rdf, "channel");
    // RSS 1.0 puts <item> next to <channel> inside <rdf:RDF>; RSS 2.0 nests them under it.
    const rawItems = asArray(child(channel, "item"));
    const items = (rawItems.length ? rawItems : asArray(child(rdf, "item"))).map((item) =>
      parseRssItem(item, baseUrl),
    );
    return {
      title: nodeText(child(channel, "title")),
      description: nodeText(child(channel, "description")) ?? nodeText(child(channel, "subtitle")),
      link: nodeText(child(channel, "link")) ?? atomLink(channel),
      items,
    };
  }

  if (atom) {
    return {
      title: nodeText(child(atom, "title")),
      description: nodeText(child(atom, "subtitle")) ?? nodeText(child(atom, "description")),
      link: atomLink(atom),
      items: asArray(child(atom, "entry")).map((entry) => parseAtomEntry(entry, baseUrl)),
    };
  }

  throw new Error("Feed not recognized as RSS or Atom");
}

// ponytail: in-memory TTL cache (ceiling: one Workers isolate, so hits are per-isolate, 200 feeds max; upgrade to KV/Cache API if cross-isolate hits matter)
const FEED_CACHE_TTL_MS = 3 * 60 * 1000;
const FEED_CACHE_MAX = 200;
const feedCache = new Map<string, { expiresAt: number; data: FeedResponse }>();

function cacheGet(key: string): FeedResponse | null {
  const entry = feedCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    feedCache.delete(key);
    return null;
  }
  return entry.data;
}

function cacheSet(key: string, data: FeedResponse) {
  if (feedCache.size >= FEED_CACHE_MAX) {
    const oldestKey = feedCache.keys().next().value;
    if (oldestKey) feedCache.delete(oldestKey);
  }
  feedCache.set(key, { expiresAt: Date.now() + FEED_CACHE_TTL_MS, data });
}

function normalizeInputUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  // Leave any explicit scheme alone so the guard can reject it with a real message. Prepending
  // https:// here used to turn `file:///etc/passwd` into `https://file:///etc/passwd`, a hostname
  // lookup for "file" instead of a scheme rejection.
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function discoverFeedUrl(html: string, baseUrl: string): string | null {
  try {
    const { document } = parseHTML(html);
    const links = Array.from(document.querySelectorAll('link[rel~="alternate"]'));
    for (const link of links) {
      const type = (link.getAttribute("type") || "").toLowerCase();
      const href = link.getAttribute("href");
      if (
        href &&
        (type.includes("rss") ||
          type.includes("atom") ||
          type === "application/xml" ||
          type === "text/xml")
      ) {
        const resolved = resolveSafeUrl(href, baseUrl);
        if (resolved) return resolved;
      }
    }
  } catch {
    // Ignore HTML parse errors
  }
  return null;
}

function extractImageFromItem(item: RawItem, baseUrl: string): string | undefined {
  if (item.enclosureUrl && (!item.enclosureType || item.enclosureType.startsWith("image/"))) {
    return item.enclosureUrl;
  }

  if (item.media[0]) return item.media[0];

  if (item.bodyHtml) {
    const match = item.bodyHtml.match(/<img[^>]+src=["']([^"']+)["']/i);
    if (match?.[1]) {
      const resolved = resolveSafeUrl(match[1], baseUrl);
      if (resolved) return resolved;
    }
  }

  return undefined;
}

function looksLikeHtml(text: string, contentType: string): boolean {
  const ct = contentType.toLowerCase();
  if (ct.includes("xml") || ct.includes("rss") || ct.includes("atom")) return false;
  const head = text.trimStart().slice(0, 300).toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html") || ct.includes("text/html");
}

const ARTICLE_SEGMENTS = new Set([
  "noticia",
  "noticias",
  "news",
  "article",
  "articles",
  "story",
  "post",
  "blog",
]);
const NON_ARTICLE_SEGMENTS = new Set([
  "tag",
  "tags",
  "categoria",
  "categorias",
  "category",
  "categories",
  "autor",
  "autores",
  "author",
  "authors",
  "login",
  "entrar",
  "signin",
  "signup",
  "search",
  "busca",
  "newsletter",
  "assinar",
  "subscribe",
  "contato",
  "contact",
  "sobre",
  "about",
  "termos",
  "privacidade",
  "privacy",
]);
const MIN_HEADLINE_CHARS = 15;

function cleanText(value: string | null | undefined): string {
  return decodeHtmlEntities(stripHtmlToText(value ?? "", 300))
    .replace(/\s+/g, " ")
    .trim();
}

/** Comparison key: the same article with tracking params or a trailing slash is one item. */
function urlKey(url: string): string {
  try {
    const { hostname, pathname } = new URL(url);
    return `${hostname.replace(/^www\./, "")}${pathname.replace(/\/+$/, "")}`;
  } catch {
    return url;
  }
}

function dateFromPath(pathname: string): string | undefined {
  const match = pathname.match(/\/(20\d{2})\/(\d{1,2})\/(\d{1,2})\//);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  return new Date(Date.UTC(year, month - 1, day)).toISOString();
}

function anchorTitle(anchor: Element, slug: string): string {
  const fromText = cleanText(anchor.innerHTML);
  if (fromText.length >= MIN_HEADLINE_CHARS) return fromText;
  const fromAttr = cleanText(anchor.getAttribute("title"));
  if (fromAttr.length >= MIN_HEADLINE_CHARS) return fromAttr;
  const words = slug.replace(/[-_]+/g, " ").trim();
  if (words.length < MIN_HEADLINE_CHARS) return "";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function anchorImage(anchor: Element, baseUrl: string): string | undefined {
  // Cards rarely wrap the whole teaser in the anchor, so walk a few ancestors for the thumbnail.
  let node: Element | null = anchor;
  for (let depth = 0; node && depth < 5; depth++, node = node.parentElement) {
    const img = node.querySelector("img");
    const src = img?.getAttribute("src") ?? img?.getAttribute("data-src");
    const resolved = resolveSafeUrl(src ?? undefined, baseUrl);
    if (resolved) return resolved;
  }
  return undefined;
}

/**
 * Synthesises a feed from a page's own article links, for publishers that ship no RSS/Atom.
 *
 * ponytail: ceiling — this only sees anchor hrefs and text, so JavaScript-rendered section pages,
 * paywalled teasers, and sites whose links live in script payloads still yield nothing. It also
 * cannot recover summaries or bodies, so items carry no contentHtml and the reader fetches the
 * article on click. Upgrade path: per-publisher selectors keyed off the hostname, or an
 * og:image/Readability probe per candidate link.
 */
function buildSyntheticFeed(html: string, pageUrl: string): FeedResponse | null {
  let document: Document;
  try {
    ({ document } = parseHTML(html));
  } catch {
    return null;
  }

  const pageHost = new URL(pageUrl).hostname.replace(/^www\./, "");
  const pageKey = urlKey(pageUrl);
  const pageSegments = new URL(pageUrl).pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.toLowerCase());
  const pageTitle =
    cleanText(document.querySelector("title")?.textContent) ||
    cleanText(document.querySelector("h1")?.textContent);

  const items: Array<{ score: number; rank: number; item: FeedItem }> = [];
  const seen = new Set<string>();

  for (const anchor of Array.from(document.querySelectorAll("a[href]"))) {
    const resolved = resolveSafeUrl(anchor.getAttribute("href") ?? undefined, pageUrl);
    if (!resolved) continue;

    const url = new URL(resolved);
    const host = url.hostname.replace(/^www\./, "");
    // Hash-only and query-only links resolve to the page itself and die here too.
    if (host !== pageHost && !host.endsWith(`.${pageHost}`)) continue;
    const key = urlKey(resolved);
    if (key === pageKey || seen.has(key)) continue;

    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length < 2) continue;
    if (segments.some((segment) => NON_ARTICLE_SEGMENTS.has(segment.toLowerCase()))) continue;

    const slug = segments[segments.length - 1].replace(/\.[a-z]{2,6}$/i, "");
    const isoDate = dateFromPath(url.pathname);
    const title = anchorTitle(anchor, slug);
    if (!title) continue;

    // Ranking, not a filter: section and team hubs (/futebol/times/bayern-de-munique/) share the
    // depth of a real article, so depth alone lets nav win the first 40 slots. A date path, an
    // /article/-style segment, or a long hyphenated slug under a long headline is an article
    // shape; a short two-word taxonomy label is not. Segments shared with the page's own path
    // ("news" on /news) describe the section, not a story, so they don't count. Array#sort is
    // stable, so ties keep page order.
    const score =
      (isoDate ? 4 : 0) +
      (segments.some(
        (segment) =>
          ARTICLE_SEGMENTS.has(segment.toLowerCase()) &&
          !pageSegments.includes(segment.toLowerCase()),
      )
        ? 2
        : 0) +
      ((slug.match(/-/g) ?? []).length >= 4 && slug.length >= 30 && title.length >= 30 ? 1 : 0);
    if (!score) continue;

    seen.add(key);
    items.push({
      score,
      rank: items.length,
      item: {
        id: resolved,
        title,
        link: resolved,
        isoDate,
        image: anchorImage(anchor, pageUrl),
        feedTitle: pageTitle || undefined,
        feedUrl: pageUrl,
      },
    });
  }

  if (!items.length) return null;

  return {
    title: pageTitle || pageHost,
    link: pageUrl,
    favicon: `https://icons.duckduckgo.com/ip3/${encodeURIComponent(new URL(pageUrl).hostname)}.ico`,
    feedUrl: pageUrl,
    fetchedAt: new Date().toISOString(),
    // Keep the 40 highest scores, then restore page order (newest first): ranking is only there
    // to pick the survivors, and document order is the better reading order.
    items: items
      .sort((a, b) => b.score - a.score)
      .slice(0, 40)
      .sort((a, b) => a.rank - b.rank)
      .map(({ item }) => item),
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export async function handleFeed(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const rawUrl = params.get("url") ?? "";
  const bypassCache = params.get("refresh") === "1";
  const normalizedUrl = normalizeInputUrl(rawUrl);

  if (!normalizedUrl) {
    return json({ error: "Missing feed URL" }, 400);
  }

  if (!bypassCache) {
    const cached = cacheGet(normalizedUrl);
    if (cached) {
      return json(cached);
    }
  }

  try {
    let fetched = await safeFetchText(normalizedUrl, {
      accept:
        "application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.8",
    });

    // If user pasted a website URL instead of the feed URL, auto-discover the RSS/Atom link
    if (looksLikeHtml(fetched.text, fetched.contentType)) {
      const discovered = discoverFeedUrl(fetched.text, fetched.finalUrl);
      if (!discovered) {
        const synthetic = buildSyntheticFeed(fetched.text, fetched.finalUrl);
        if (!synthetic) {
          return json(
            {
              error:
                "No RSS or Atom feed found, and no article links could be extracted from this page.",
            },
            422,
          );
        }
        cacheSet(normalizedUrl, synthetic);
        if (fetched.finalUrl !== normalizedUrl) {
          cacheSet(fetched.finalUrl, synthetic);
        }
        return json(synthetic);
      }
      fetched = await safeFetchText(discovered, {
        accept: "application/rss+xml, application/atom+xml, application/xml, text/xml",
      });
    }

    const parsed = parseFeed(fetched.text, fetched.finalUrl);
    const siteLink = resolveSafeUrl(parsed.link, fetched.finalUrl) ?? fetched.finalUrl;
    let favicon: string | undefined;
    try {
      const host = new URL(siteLink).hostname;
      favicon = `https://icons.duckduckgo.com/ip3/${encodeURIComponent(host)}.ico`;
    } catch {
      favicon = undefined;
    }

    const items: FeedItem[] = parsed.items.slice(0, 40).map((item, idx) => {
      const itemLink = resolveSafeUrl(item.link, siteLink) ?? siteLink;
      const rawHtml = item.bodyHtml ?? "";
      // Was stripHtmlToText(contentSnippet || summary || rawHtml, 220). contentSnippet was the
      // already-stripped <content>/<description>, so the same source text lands here.
      const summarySource = item.summaryHtml ?? rawHtml;
      const summary = summarySource ? stripHtmlToText(summarySource, 220) : undefined;
      const contentHtml = rawHtml ? sanitizeArticleHtml(rawHtml, itemLink) : undefined;

      return {
        id: item.id || itemLink || `${fetched.finalUrl}#${idx}`,
        title: decodeHtmlEntities((item.title || "Untitled").trim()),
        link: itemLink,
        isoDate: item.isoDate,
        author: decodeHtmlEntities((item.author || "").trim()) || undefined,
        summary: summary ? decodeHtmlEntities(summary) : undefined,
        contentHtml,
        image: extractImageFromItem(item, itemLink),
        feedTitle: decodeHtmlEntities((parsed.title || "").trim()) || undefined,
        feedUrl: fetched.finalUrl,
      };
    });

    const payload: FeedResponse = {
      title: decodeHtmlEntities((parsed.title || new URL(fetched.finalUrl).hostname).trim()),
      description: parsed.description ? decodeHtmlEntities(parsed.description.trim()) : undefined,
      link: siteLink,
      favicon,
      feedUrl: fetched.finalUrl,
      fetchedAt: new Date().toISOString(),
      items,
    };

    cacheSet(normalizedUrl, payload);
    if (fetched.finalUrl !== normalizedUrl) {
      cacheSet(fetched.finalUrl, payload);
    }

    return json(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load feed";
    return json({ error: message }, 400);
  }
}
