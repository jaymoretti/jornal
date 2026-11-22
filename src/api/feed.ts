import { XMLBuilder, XMLParser } from "fast-xml-parser";
import { parseHTML } from "linkedom";
import {
  decodeHtmlEntities,
  MAX_SCAN_BYTES,
  ResponseTooLargeError,
  resolveSafeUrl,
  type SafeFetchResult,
  safeFetchFeedText,
  sanitizeArticleHtml,
  stripHtmlToText,
  userFacingError,
} from "../lib/net.ts";
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

/** Robots.txt is small; a bigger one is not ours to read. */
const ROBOTS_MAX_BYTES = 256 * 1024;

/**
 * Sitemaps worth trying, in preference order. Bounded so one Add Block attempt makes a predictable
 * number of outbound requests: 1 robots + (2 sitemaps + their index child) + 7 path probes.
 */
const MAX_SITEMAP_TRIES = 2;

/** Feed paths nearly every CMS exposes, cheapest generic fallback when a site hides its tags. */
const COMMON_FEED_PATHS = [
  "/feed",
  "/feed.xml",
  "/rss",
  "/rss.xml",
  "/atom.xml",
  "/index.xml",
  "/feeds/all.rss",
];

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

/**
 * Readable headline from a URL slug, shared by the anchor scrape and sitemap discovery: strip the
 * extension, a trailing date (`-2026-11-22`) or numeric id, then hyphenate into words. Short
 * results are rejected — "news" is a section, not a story.
 */
function titleFromSlug(slug: string): string {
  const words = slug
    .replace(/\.[a-z]{2,6}$/i, "")
    .replace(/[-_]\d{4}([-_]\d{1,2}){0,2}$/, "")
    .replace(/[-_]\d{4,}$/, "")
    .replace(/[-_]+/g, " ")
    .trim();
  if (words.length < MIN_HEADLINE_CHARS) return "";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function anchorTitle(anchor: Element, slug: string): string {
  const fromText = cleanText(anchor.innerHTML);
  if (fromText.length >= MIN_HEADLINE_CHARS) return fromText;
  const fromAttr = cleanText(anchor.getAttribute("title"));
  if (fromAttr.length >= MIN_HEADLINE_CHARS) return fromAttr;
  return titleFromSlug(slug);
}

/** Absolute URL of a story-shaped link on the page's own site, or null when it is chrome/nav. */
function storyUrl(anchor: Element, pageUrl: string, pageHost: string, pageKey: string): URL | null {
  const resolved = resolveSafeUrl(anchor.getAttribute("href") ?? undefined, pageUrl);
  if (!resolved) return null;

  const url = new URL(resolved);
  const host = url.hostname.replace(/^www\./, "");
  // Hash-only and query-only links resolve to the page itself and die here too.
  if (host !== pageHost && !host.endsWith(`.${pageHost}`)) return null;
  if (urlKey(resolved) === pageKey) return null;

  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length < 2) return null;
  if (segments.some((segment) => NON_ARTICLE_SEGMENTS.has(segment.toLowerCase()))) return null;
  return url;
}

/** Ancestor → the story URLs it wraps. A single key means that subtree belongs to one story. */
type StoryUnits = Map<Element, Set<string>>;

/** Levels searched for a story's card: the anchor plus five ancestors. */
const UNIT_DEPTH = 6;

/** Chrome, not a story photo: BBC ships a grey placeholder <img> ahead of the real one. */
const DECORATIVE_IMAGE = /placeholder|spacer|\bpixel\b|[/_-]1x1(?:[./_-]|$)|\.svg(?:[?#]|$)/i;

function imageIn(node: Element, baseUrl: string): string | undefined {
  for (const img of Array.from(node.querySelectorAll("img"))) {
    const src = img.getAttribute("src") ?? img.getAttribute("data-src");
    if (!src || DECORATIVE_IMAGE.test(src)) continue;
    const resolved = resolveSafeUrl(src, baseUrl);
    if (resolved) return resolved;
  }
  return undefined;
}

/**
 * Map every story anchor's ancestors to the story keys they contain.
 *
 * A homepage grid cell usually wraps several stories, so the same ancestor is reached by each of
 * their anchors and its set holds several keys — that is exactly what tells a shared container
 * apart from a card that belongs to one story.
 */
function storyUnits(
  document: Document,
  pageUrl: string,
  pageHost: string,
  pageKey: string,
): StoryUnits {
  const units: StoryUnits = new Map();
  for (const anchor of Array.from(document.querySelectorAll("a[href]"))) {
    const url = storyUrl(anchor, pageUrl, pageHost, pageKey);
    if (!url) continue;
    const key = urlKey(url.toString());
    let node: Element | null = anchor;
    for (let depth = 0; node && depth < UNIT_DEPTH; depth++, node = node.parentElement) {
      const keys = units.get(node) ?? new Set<string>();
      keys.add(key);
      units.set(node, keys);
    }
  }
  return units;
}

/**
 * The story's own thumbnail, or nothing.
 *
 * Climb from the anchor while every ancestor still wraps only this story; the deepest such
 * ancestor is the card, and an <img> inside it is this story's photo. The moment an ancestor wraps
 * a second story, any image below it may belong to that other story, so the answer is "no image"
 * — a missing photo renders a clean card, a borrowed one tells a lie.
 *
 * ponytail: ceiling — grouping is inferred from link shape, so a layout that puts the photo in a
 * sibling of the card root, or in a script payload, still yields no image. Upgrade path:
 * per-publisher selectors keyed off the hostname, or an og:image probe per article URL.
 */
function anchorImage(
  anchor: Element,
  baseUrl: string,
  key: string,
  units: StoryUnits,
): string | undefined {
  let node: Element | null = anchor;
  for (let depth = 0; node && depth < UNIT_DEPTH; depth++, node = node.parentElement) {
    const keys = units.get(node);
    // Not a story anchor we counted, or a subtree that also holds another story: stop climbing.
    if (!keys?.has(key) || keys.size > 1) return undefined;
    const image = imageIn(node, baseUrl);
    if (image) return image;
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
export function buildSyntheticFeed(html: string, pageUrl: string): FeedResponse | null {
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
  const units = storyUnits(document, pageUrl, pageHost, pageKey);

  for (const anchor of Array.from(document.querySelectorAll("a[href]"))) {
    const url = storyUrl(anchor, pageUrl, pageHost, pageKey);
    if (!url) continue;
    const resolved = url.toString();
    const key = urlKey(resolved);
    if (seen.has(key)) continue;

    const segments = url.pathname.split("/").filter(Boolean);
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
        image: anchorImage(anchor, pageUrl, key, units),
        feedTitle: pageTitle || undefined,
        feedUrl: pageUrl,
      },
    });
  }

  if (!items.length) return null;

  // Ranking decides who makes the cut; the image is then claimed once, so one picture cannot show
  // up under two different headlines. First item in feed order wins.
  const claimed = new Set<string>();
  const feed = items
    .sort((a, b) => b.score - a.score)
    .slice(0, 40)
    .sort((a, b) => a.rank - b.rank)
    .map(({ item }) => {
      if (!item.image) return item;
      if (claimed.has(item.image)) return { ...item, image: undefined };
      claimed.add(item.image);
      return item;
    });

  return feedPayload(pageTitle || pageHost, pageUrl, feed);
}

/** The FeedResponse envelope every discovery step returns, so the UI sees one shape. */
function feedPayload(title: string, siteUrl: string, items: FeedItem[]): FeedResponse {
  return {
    title,
    link: siteUrl,
    favicon: `https://icons.duckduckgo.com/ip3/${encodeURIComponent(new URL(siteUrl).hostname)}.ico`,
    feedUrl: siteUrl,
    fetchedAt: new Date().toISOString(),
    items: items.slice(0, 40),
  };
}

interface SitemapEntry {
  loc: string;
  lastmod?: string;
  /** Google News sitemaps carry the real headline; sitemaps.org ones do not. */
  title?: string;
}

/** `<url>` entries from a `<urlset>`, or child sitemap URLs from a `<sitemapindex>`. */
function parseSitemap(xml: string, baseUrl: string): { urls: SitemapEntry[]; children: string[] } {
  const doc = parser.parse(xml) as XmlNode;
  const children = asArray(child(child(doc, "sitemapindex"), "sitemap"))
    .map((entry) => resolveSafeUrl(nodeText(child(entry, "loc")), baseUrl))
    .filter((url): url is string => Boolean(url));
  const urls: SitemapEntry[] = [];
  for (const entry of asArray(child(child(doc, "urlset"), "url"))) {
    const loc = resolveSafeUrl(nodeText(child(entry, "loc")), baseUrl);
    if (loc) {
      urls.push({
        loc,
        lastmod: isoOrUndefined(nodeText(child(entry, "lastmod"))),
        title: cleanText(nodeText(child(child(entry, "news:news"), "news:title"))) || undefined,
      });
    }
  }
  return { urls, children };
}

/** `/news/` sitemaps carry stories, `/article/` next, the rest last. Stable within each rank. */
function rankSitemaps(urls: string[]): string[] {
  const rank = (url: string) => (/news/i.test(url) ? 0 : /article/i.test(url) ? 1 : 2);
  return [...urls].sort((a, b) => rank(a) - rank(b));
}

/** Fetch XML for a discovery step, or null when this step fails (404, TLS, past the size cap). */
async function fetchXmlOrNull(url: string, maxBytes?: number): Promise<string | null> {
  try {
    const fetched = await safeFetchFeedText(url, {
      accept: "application/xml, text/xml, text/plain, */*;q=0.8",
      maxBytes,
    });
    return fetched.text;
  } catch {
    return null;
  }
}

/**
 * Step D: robots.txt → sitemap → article URLs. This is what rescues CNN, whose homepage is 6.9 MB
 * of JavaScript with no feed tag and no usable anchors, but whose robots.txt declares
 * /sitemap/news.xml with 111 dated article URLs and real `<news:title>` headlines.
 *
 * ponytail: ceiling — when a sitemap is a plain sitemaps.org one, titles fall back to the URL slug
 * ("house-races-midterms-votes-vis") because fetching 40 pages to learn their headlines costs 40
 * requests and seconds. Slugs are decent for news and poor for opaque ids; no summary, body or
 * image either, so the reader fetches the article on click. Upgrade path: an og:title probe per
 * item, batched with a concurrency limit.
 *
 * Every URL here (robots, sitemap, child sitemap, each loc) is fetched through safeFetchFeedText,
 * so a sitemap full of private addresses is rejected by the same guard as user input.
 */
async function discoverFromSitemaps(siteUrl: string): Promise<FeedResponse | null> {
  const site = new URL(siteUrl);
  const robots = await fetchXmlOrNull(new URL("/robots.txt", site).toString(), ROBOTS_MAX_BYTES);
  if (!robots) return null;

  const declared = [...robots.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((match) => match[1].trim());
  for (const candidate of rankSitemaps(declared).slice(0, MAX_SITEMAP_TRIES)) {
    const xml = await fetchXmlOrNull(candidate);
    if (!xml) continue;

    let { urls: entries, children } = parseSitemap(xml, candidate);
    if (!entries.length && children.length) {
      // One level only: a sitemapindex of sitemapindexes is not worth walking for a feed.
      const childUrl = rankSitemaps(children)[0];
      const childXml = await fetchXmlOrNull(childUrl);
      if (!childXml) continue;
      entries = parseSitemap(childXml, childUrl).urls;
    }

    const feed = feedFromSitemapEntries(entries, site);
    if (feed) return feed;
  }
  return null;
}

/** Article-shaped `<loc>`s → items, newest first when the sitemap dates them. */
function feedFromSitemapEntries(entries: SitemapEntry[], site: URL): FeedResponse | null {
  const siteHost = site.hostname.replace(/^www\./, "");
  const seen = new Set<string>();
  const items: FeedItem[] = [];

  for (const { loc, lastmod, title: newsTitle } of entries) {
    let url: URL;
    try {
      url = new URL(loc);
    } catch {
      continue;
    }
    const host = url.hostname.replace(/^www\./, "");
    if (host !== siteHost && !host.endsWith(`.${siteHost}`)) continue;

    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length < 2) continue;
    if (segments.some((segment) => NON_ARTICLE_SEGMENTS.has(segment.toLowerCase()))) continue;

    // Prefer the sitemap's own headline when it ships one; a slug is the fallback, not the goal.
    const title = newsTitle || titleFromSlug(segments[segments.length - 1]);
    if (!title) continue;
    const key = urlKey(loc);
    if (seen.has(key)) continue;

    seen.add(key);
    items.push({
      id: loc,
      title,
      link: loc,
      isoDate: lastmod ?? dateFromPath(url.pathname),
      feedTitle: site.hostname,
      feedUrl: site.toString(),
    });
  }

  if (!items.length) return null;
  items.sort((a, b) => (b.isoDate ?? "").localeCompare(a.isoDate ?? ""));
  return feedPayload(site.hostname, site.toString(), items);
}

/** Step E: probe the handful of feed paths almost every CMS answers. */
async function probeCommonFeedPaths(siteUrl: string): Promise<FeedResponse | null> {
  const origin = new URL(siteUrl).origin;
  for (const path of COMMON_FEED_PATHS) {
    let fetched: SafeFetchResult;
    try {
      fetched = await safeFetchFeedText(new URL(path, origin).toString(), { accept: FEED_ACCEPT });
    } catch {
      continue;
    }
    // A 200 HTML "not found" page is the common failure here; only a real feed counts.
    if (looksLikeHtml(fetched.text, fetched.contentType)) continue;
    try {
      return feedResponseFrom(fetched);
    } catch {
      // Not a feed after all; try the next path.
    }
  }
  return null;
}

/** Generic last resort for a page that gave us nothing: sitemaps first, then path probes. */
async function discoverSiteFeed(siteUrl: string): Promise<FeedResponse | null> {
  return (await discoverFromSitemaps(siteUrl)) ?? (await probeCommonFeedPaths(siteUrl));
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

const FEED_ACCEPT =
  "application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.8";

/**
 * Fetch exactly what the reader pasted. Deliberately no hostname→feed table: such a table only
 * helps readers who already know the site is special, needs manual maintenance, and rots as
 * publishers move their feeds. The generic chain in handleFeed treats every site the same way.
 * safeFetchFeedText adds the single https→http retry for TLS failures at the publisher's edge.
 */
function fetchFeedSource(normalizedUrl: string): Promise<SafeFetchResult> {
  return safeFetchFeedText(normalizedUrl, { accept: FEED_ACCEPT });
}

/** XML feed text → the FeedResponse the UI consumes. Throws when the document is not a feed. */
function feedResponseFrom(fetched: SafeFetchResult): FeedResponse {
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

  return {
    title: decodeHtmlEntities((parsed.title || new URL(fetched.finalUrl).hostname).trim()),
    description: parsed.description ? decodeHtmlEntities(parsed.description.trim()) : undefined,
    link: siteLink,
    favicon,
    feedUrl: fetched.finalUrl,
    fetchedAt: new Date().toISOString(),
    items,
  };
}

/**
 * Discovery chain, first success wins:
 *   A. the URL is already a feed → parse it
 *   B. `<link rel="alternate">` on the page
 *   C. article links in the page itself (synthetic feed)
 *   D. robots.txt → sitemap → `<loc>` URLs (synthetic feed)
 *   E. probe /feed, /rss.xml, … on the origin, first that parses wins
 * and then an honest 422. Only step A short-circuits; B–E all end in the same cache + return.
 */
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
    let fetched: SafeFetchResult | null = null;
    try {
      fetched = await fetchFeedSource(normalizedUrl);
    } catch (error) {
      // A page past the scan cap still has a robots.txt and a sitemap, so the page-shaped steps
      // (A/B/C) are skipped but discovery continues. Only the size cap is survivable here;
      // anything else (SSRF rejection, timeout, 404) is a real answer for the reader.
      if (!(error instanceof ResponseTooLargeError)) throw error;
    }

    if (fetched) {
      // A. The reader pasted a feed, not a homepage.
      if (!looksLikeHtml(fetched.text, fetched.contentType)) {
        return respond(normalizedUrl, fetched.finalUrl, feedResponseFrom(fetched));
      }

      // B. The publisher advertises its feed.
      const discovered = discoverFeedUrl(fetched.text, fetched.finalUrl);
      if (discovered) {
        const feedXml = await safeFetchFeedText(discovered, {
          accept: "application/rss+xml, application/atom+xml, application/xml, text/xml",
        });
        try {
          return respond(normalizedUrl, fetched.finalUrl, feedResponseFrom(feedXml));
        } catch {
          // An advertised tag pointing at HTML happens; keep walking the chain.
        }
      }

      // C. Article links are in the HTML we already paid for.
      const synthetic = buildSyntheticFeed(fetched.text, fetched.finalUrl);
      if (synthetic) return respond(normalizedUrl, fetched.finalUrl, synthetic);
    }

    // D + E. Generic discovery: sitemaps, then the usual feed paths on the origin.
    const siteFeed = await discoverSiteFeed(fetched?.finalUrl ?? normalizedUrl);
    if (siteFeed) return respond(normalizedUrl, siteFeed.feedUrl, siteFeed);

    // Nothing worked. Keep the size-cap wording when that is why the page steps were skipped:
    // "too large to scan, try the direct RSS link" is more useful than "no feed found".
    if (!fetched) throw new ResponseTooLargeError(MAX_SCAN_BYTES);

    return json(
      {
        error:
          "No RSS or Atom feed found for this site. Try the publisher's direct feed link if you know it.",
      },
      422,
    );
  } catch (error) {
    const message = userFacingError(error, "Could not load this feed. Try its direct RSS link.");
    return json({ error: message }, 400);
  }
}

/** Cache under both the key the reader typed and the URL we ended up at, then serialise. */
function respond(typedUrl: string, finalUrl: string, payload: FeedResponse): Response {
  cacheSet(typedUrl, payload);
  if (finalUrl !== typedUrl) {
    cacheSet(finalUrl, payload);
  }
  return json(payload);
}
