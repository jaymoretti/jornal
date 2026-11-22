import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import {
  dedupeArticleImages,
  resolveSafeUrl,
  safeFetchText,
  sanitizeArticleHtml,
  stripHtmlToText,
  userFacingError,
} from "../lib/net";
import type { ArticleResponse } from "../lib/types";

// ponytail: in-memory TTL cache (ceiling: one Workers isolate, so hits are per-isolate, 100 articles max; upgrade to KV/Cache API if cross-isolate hits matter)
const ARTICLE_CACHE_TTL_MS = 15 * 60 * 1000;
const ARTICLE_CACHE_MAX = 100;
const articleCache = new Map<string, { expiresAt: number; data: ArticleResponse }>();

function cacheGet(key: string): ArticleResponse | null {
  const entry = articleCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    articleCache.delete(key);
    return null;
  }
  return entry.data;
}

function cacheSet(key: string, data: ArticleResponse) {
  if (articleCache.size >= ARTICLE_CACHE_MAX) {
    const oldestKey = articleCache.keys().next().value;
    if (oldestKey) articleCache.delete(oldestKey);
  }
  articleCache.set(key, { expiresAt: Date.now() + ARTICLE_CACHE_TTL_MS, data });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export async function handleArticle(request: Request): Promise<Response> {
  const rawUrl = new URL(request.url).searchParams.get("url") ?? "";
  if (!rawUrl.trim()) {
    return json({ error: "Missing article URL" }, 400);
  }

  const cached = cacheGet(rawUrl);
  if (cached) {
    return json(cached);
  }

  try {
    const fetched = await safeFetchText(rawUrl, {
      accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
      timeoutMs: 12_000,
    });

    const { document } = parseHTML(fetched.text);

    // Grab lead metadata before Readability mutates the DOM
    const ogImage =
      document.querySelector('meta[property="og:image"]')?.getAttribute("content") ||
      document.querySelector('meta[name="twitter:image"]')?.getAttribute("content") ||
      undefined;
    const ogSite =
      document.querySelector('meta[property="og:site_name"]')?.getAttribute("content") || undefined;

    // Strip obvious noisy elements before Readability runs
    for (const selector of [
      "script",
      "style",
      "noscript",
      "iframe",
      "form",
      "[aria-label*='advertisement' i]",
      "[class*='ad-slot' i]",
      "[class*='newsletter' i]",
    ]) {
      document.querySelectorAll(selector).forEach((el) => {
        el.remove();
      });
    }

    const reader = new Readability(document as unknown as Document, {
      charThreshold: 120,
    });
    const parsed = reader.parse();

    if (!parsed?.content) {
      return json({ error: "Could not extract clean article text from this page." }, 422);
    }

    const contentHtml = sanitizeArticleHtml(parsed.content, fetched.finalUrl);
    const plainText = stripHtmlToText(contentHtml, 100_000);
    const wordCount = plainText.split(/\s+/).filter(Boolean).length;

    if (wordCount < 20) {
      return json(
        { error: "Extracted page content was too short (site may require JavaScript or login)." },
        422,
      );
    }

    // Readability keeps the article's own lead photo in the body; strip it so the hero
    // image isn't rendered twice, and collapse any repeated body images.
    const deduped = dedupeArticleImages(
      contentHtml,
      resolveSafeUrl(ogImage, fetched.finalUrl),
      fetched.finalUrl,
    );

    const payload: ArticleResponse = {
      title: parsed.title?.trim() || "Untitled",
      byline: parsed.byline?.trim() || undefined,
      siteName: parsed.siteName?.trim() || ogSite?.trim() || new URL(fetched.finalUrl).hostname,
      excerpt: parsed.excerpt?.trim() || undefined,
      contentHtml: deduped.contentHtml,
      leadImage: deduped.heroImage,
      readingTimeMinutes: Math.max(1, Math.round(wordCount / 220)),
      url: fetched.finalUrl,
    };

    cacheSet(rawUrl, payload);
    return json(payload);
  } catch (error) {
    const message = userFacingError(error, "Could not load this article.");
    return json({ error: message }, 400);
  }
}
