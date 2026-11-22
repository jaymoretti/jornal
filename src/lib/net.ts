import { parseHTML } from "linkedom";
import sanitizeHtml from "sanitize-html";

const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 3 * 1024 * 1024; // 3 MB

const USER_AGENT =
  "Mozilla/5.0 (compatible; jornalReader/1.0; +https://jornal.cc) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

type IPv4 = [number, number, number, number];

/**
 * Parses an IPv4 literal, including the legacy inet_aton forms a hostile URL can hide behind:
 * `2130706433` (32-bit decimal), `0x7f.0.0.1` (hex), `0177.0.0.1` (octal), `127.1` (short form).
 * Returns null for anything that is not a bare numeric IP literal, i.e. a hostname.
 */
function parseIPv4(host: string): IPv4 | null {
  const parts = host.split(".");
  if (parts.length > 4) return null;

  const nums: number[] = [];
  for (const part of parts) {
    if (/^0x[0-9a-f]+$/i.test(part)) {
      nums.push(parseInt(part.slice(2), 16));
    } else if (/^0[0-7]+$/.test(part)) {
      nums.push(parseInt(part, 8));
    } else if (/^\d+$/.test(part)) {
      nums.push(parseInt(part, 10));
    } else {
      return null;
    }
  }

  // inet_aton: the final part absorbs every byte the earlier parts did not claim.
  const last = nums.pop() as number;
  const remaining = 4 - nums.length;
  if (last >= 2 ** (8 * remaining)) return null;
  const octets = [...nums];
  for (let shift = remaining - 1; shift >= 0; shift--) {
    octets.push((last >>> (8 * shift)) & 0xff);
  }
  return octets as IPv4;
}

function isIpLiteral(host: string): boolean {
  return host.includes(":") || parseIPv4(host) !== null;
}

function isPrivateIPv4(ip: IPv4): boolean {
  const [a, b, c] = ip;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 169 && b === 254) return true; // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && c === 0) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true; // multicast / reserved
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const v6 = ip.toLowerCase();
  if (v6 === "::" || v6 === "::1") return true;

  // ::ffff:a.b.c.d and ::ffff:xxxx:yyyy are IPv4 addresses wearing a v6 mask.
  if (v6.startsWith("::ffff:")) {
    const tail = v6.slice(7);
    if (tail.includes(".")) return isPrivateIPv4(parseIPv4(tail) ?? [0, 0, 0, 0]);
    const groups = tail.split(":");
    if (groups.length === 2) {
      const hi = parseInt(groups[0], 16);
      const lo = parseInt(groups[1], 16);
      return isPrivateIPv4([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff]);
    }
    return true;
  }

  const head = v6.split(":")[0];
  if (!head) return false; // "::<x>" that is not IPv4-mapped — treat as global
  const first = parseInt(head, 16);
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

/**
 * True for any address we refuse to fetch. Accepts IPv4/IPv6 literals in any of the numeric
 * spellings above, and answers `true` for anything unrecognisable so callers stay fail-closed.
 */
export function isPrivateIp(ip: string): boolean {
  const host = ip
    .trim()
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  if (!host) return true;
  if (host.includes(":")) return isPrivateIPv6(host);
  const octets = parseIPv4(host);
  return octets ? isPrivateIPv4(octets) : true;
}

const IS_WORKERS = typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers";

/**
 * Resolves a hostname to its A/AAAA records, when the runtime can do it.
 *
 * Workers has no resolver, and its egress is already proxied by Cloudflare, so DNS is neither
 * possible nor needed there. Node still gets the full check, reached without an import specifier
 * so bundlers never see `node:dns`.
 *
 * ponytail: ceiling — on Workers the guard is hostname/IP-literal only, so a public hostname that
 * resolves into private space is not caught. Upgrade path: a DNS-over-HTTPS lookup (costs a
 * subrequest) if we ever need it, or lean on Cloudflare's network-level egress rules.
 */
async function resolveHostname(hostname: string): Promise<string[]> {
  if (IS_WORKERS) return [];
  const getBuiltinModule = (
    globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }
  ).process?.getBuiltinModule;
  if (typeof getBuiltinModule !== "function") return [];

  const dns = getBuiltinModule("node:dns/promises") as {
    lookup(host: string, options: { all: true }): Promise<Array<{ address: string }>>;
  };
  const records = await dns.lookup(hostname, { all: true });
  if (!records.length) {
    throw new Error("Could not resolve hostname");
  }
  return records.map((record) => record.address);
}

export async function assertPublicUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error("Invalid URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http and https URLs are allowed");
  }

  // The URL parser has already canonicalised decimal/octal/hex IPv4 forms into dotted quads,
  // so what's left here is the shape check plus the private-range test.
  const hostname = parsed.hostname
    .replace(/^\[|\]$/g, "")
    .toLowerCase()
    .replace(/\.$/, "");
  if (
    !hostname ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    throw new Error("Private or local hosts are not allowed");
  }

  if (isIpLiteral(hostname)) {
    if (isPrivateIp(hostname)) {
      throw new Error("Private IP addresses are not allowed");
    }
    return parsed;
  }

  for (const address of await resolveHostname(hostname)) {
    if (isPrivateIp(address)) {
      throw new Error("Host resolves to a private network address");
    }
  }
  return parsed;
}

export interface SafeFetchResult {
  text: string;
  contentType: string;
  finalUrl: string;
}

export async function safeFetchText(
  rawUrl: string,
  options?: { accept?: string; timeoutMs?: number; maxBytes?: number },
): Promise<SafeFetchResult> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;
  let currentUrl = rawUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const validated = await assertPublicUrl(currentUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(validated.toString(), {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "User-Agent": USER_AGENT,
          Accept:
            options?.accept ?? "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
        cache: "no-store",
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) {
          throw new Error(`Redirect (${response.status}) without Location header`);
        }
        currentUrl = new URL(location, validated).toString();
        continue;
      }

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new Error(
            `This publisher blocks server-side extraction (HTTP ${response.status}). Open the original article.`,
          );
        }
        throw new Error(`Upstream returned HTTP ${response.status}`);
      }

      const contentLength = Number(response.headers.get("content-length") ?? "0");
      if (contentLength > maxBytes) {
        throw new Error("Response exceeds maximum allowed size");
      }

      const reader = response.body?.getReader();
      if (!reader) {
        return {
          text: "",
          contentType: response.headers.get("content-type") ?? "",
          finalUrl: validated.toString(),
        };
      }

      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          reader.cancel().catch(() => {});
          throw new Error("Response exceeded size limit");
        }
        chunks.push(value);
      }

      const merged = new Uint8Array(totalBytes);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
      }

      const text = new TextDecoder("utf-8", { fatal: false }).decode(merged);
      return {
        text,
        contentType: response.headers.get("content-type") ?? "",
        finalUrl: validated.toString(),
      };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("Request timed out");
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error("Too many redirects");
}

export function resolveSafeUrl(href: string | undefined, baseUrl: string): string | undefined {
  if (!href) return undefined;
  try {
    const resolved = new URL(href.trim(), baseUrl);
    if (resolved.protocol === "http:" || resolved.protocol === "https:") {
      return resolved.toString();
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function sanitizeArticleHtml(html: string, baseUrl: string): string {
  return sanitizeHtml(html, {
    allowedTags: [
      "p",
      "br",
      "hr",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "ul",
      "ol",
      "li",
      "blockquote",
      "pre",
      "code",
      "em",
      "strong",
      "b",
      "i",
      "u",
      "s",
      "del",
      "mark",
      "small",
      "sub",
      "sup",
      "a",
      "img",
      "figure",
      "figcaption",
      "picture",
      "table",
      "thead",
      "tbody",
      "tr",
      "th",
      "td",
      "dl",
      "dt",
      "dd",
      "details",
      "summary",
      "div",
      "span",
    ],
    allowedAttributes: {
      a: ["href", "title", "target", "rel"],
      img: ["src", "alt", "title", "width", "height", "loading"],
      th: ["colspan", "rowspan"],
      td: ["colspan", "rowspan"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    transformTags: {
      a: (tagName, attribs): sanitizeHtml.Tag => {
        const href = resolveSafeUrl(attribs.href, baseUrl);
        if (!href) {
          return { tagName: "span", attribs: {} };
        }
        return {
          tagName,
          attribs: {
            href,
            title: attribs.title ?? "",
            target: "_blank",
            rel: "noopener noreferrer",
          },
        };
      },
      img: (tagName, attribs): sanitizeHtml.Tag => {
        const src = resolveSafeUrl(attribs.src, baseUrl);
        if (!src) {
          return { tagName: "span", attribs: {} };
        }
        // Drop 1x1 tracking pixels commonly embedded in RSS/news feeds
        const w = Number(attribs.width ?? "0");
        const h = Number(attribs.height ?? "0");
        if ((w > 0 && w <= 2) || (h > 0 && h <= 2)) {
          return { tagName: "span", attribs: {} };
        }
        return {
          tagName,
          attribs: {
            src,
            alt: attribs.alt ?? "",
            loading: "lazy",
          },
        };
      },
    },
    exclusiveFilter: (frame) => {
      // Drop empty tracking spans or common ad/newsletter boilerplate nodes
      if (frame.tag === "img" && !frame.attribs.src) return true;
      return false;
    },
  });
}

export function stripHtmlToText(html: string, maxLength = 240): string {
  const clean = sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} })
    .replace(/\s+/g, " ")
    .trim();
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, maxLength - 1).trimEnd()}…`;
}

/**
 * Decode HTML/XML entities left in plain text. Publishers ship titles inside CDATA, so
 * `&#039;` and `&amp;` arrive as literal text rather than parsed entities (Ars Technica,
 * The Verge). sanitize-html only strips tags and leaves `&amp;` dangling, so parse the
 * string as HTML text content instead. Returns the input unchanged when nothing to decode.
 * ponytail: one throwaway DOM node per field; fine for <=40 items, swap for a regex
 * fast-path only if feed parsing ever shows up in profiles.
 */
export function decodeHtmlEntities(text: string): string {
  if (!text?.includes("&")) return text;
  const { document } = parseHTML(`<span id="jornal-decode"></span>`);
  const node = document.getElementById("jornal-decode");
  if (!node) return text;
  node.innerHTML = text;
  return node.textContent ?? text;
}

/**
 * Identity for "same picture" checks. Publishers serve the hero image again inside the
 * article body under a different CDN host or resize query (?w=1200&q=80), so compare the
 * pathname with common size/CDN noise stripped rather than the raw URL.
 */
export function imageKey(url: string | undefined): string {
  if (!url) return "";
  try {
    const { hostname, pathname } = new URL(url);
    const host = hostname
      .replace(/^(i\d*\.|cdn\.|static\.|images\.|img\.|ichef\.)/, "")
      .replace(/^www\./, "");
    const file = pathname
      .toLowerCase()
      .replace(/\.(jpe?g|png|webp|gif|avif)$/, "")
      // Drop resize/quality path segments (/news/1024/branded_news/x) and size suffixes (-800x600, _1200w)
      .split("/")
      .filter((segment) => !/^(?:\d{2,4}|\d{2,4}x\d{2,4}|w\d{2,4}|h\d{2,4})$/.test(segment))
      .join("/")
      .replace(/[-_](?:\d{2,4}x\d{2,4}|\d{2,4}w|w\d{2,4}|h\d{2,4})$/, "");
    return `${host}${file}`;
  } catch {
    return url;
  }
}

/**
 * Readability returns the article body including its own lead photo, which then renders a
 * second time under the hero image. Drop body images that duplicate the hero and collapse
 * repeated body images, returning the HTML without leading photo and the hero to show.
 */
export function dedupeArticleImages(
  html: string,
  candidateHero: string | undefined,
  baseUrl: string,
): { contentHtml: string; heroImage?: string } {
  const { document } = parseHTML(`<div id="jornal-root">${html}</div>`);
  const root = document.getElementById("jornal-root");
  if (!root) return { contentHtml: html, heroImage: candidateHero };

  const images = Array.from(root.querySelectorAll("img"));

  // Hero source is the page's og:image only. Promoting an arbitrary first body image to the
  // hero slot would yank it out of its natural position mid-article, so don't.
  const heroImage = candidateHero;
  const heroKey = imageKey(candidateHero);

  const removeImage = (img: Element) => {
    const wrapper = img.closest("figure") ?? img.closest("picture") ?? img;
    const parent = wrapper.parentElement;
    wrapper.remove();
    if (parent && parent !== root && !parent.textContent?.trim() && !parent.querySelector("img")) {
      parent.remove();
    }
  };

  const seen = new Set<string>();
  for (const img of images) {
    const key = imageKey(resolveSafeUrl(img.getAttribute("src") ?? undefined, baseUrl));
    if (!key) continue;
    if ((heroKey && key === heroKey) || seen.has(key)) {
      removeImage(img);
      continue;
    }
    seen.add(key);
  }

  return { contentHtml: root.innerHTML, heroImage };
}
