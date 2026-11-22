import {
  AlertCircle,
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bookmark,
  BookmarkCheck,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Loader2,
  Type,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type {
  ArticleResponse,
  FeedItem,
  ReaderFont,
  ReaderPanel,
  ReaderSize,
  ThemeMode,
} from "@/lib/types";

interface ReaderDrawerProps {
  item: FeedItem | null;
  onClose: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  hasPrev: boolean;
  hasNext: boolean;
  isSaved: boolean;
  onToggleSave: (item: FeedItem) => void;
  theme: ThemeMode;
  onThemeChange: (t: ThemeMode) => void;
  readerFont: ReaderFont;
  onReaderFontChange: (f: ReaderFont) => void;
  readerSize: ReaderSize;
  onReaderSizeChange: (s: ReaderSize) => void;
  panel: ReaderPanel;
  onPanelChange: (p: ReaderPanel) => void;
}

function formatFullDate(iso?: string): string {
  if (!iso) return "";
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    })
      .format(new Date(iso))
      .toUpperCase();
  } catch {
    return "";
  }
}

function getHostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

const PANEL_LAYOUT: Record<ReaderPanel, { overlay: string; panel: string }> = {
  left: {
    overlay: "justify-start",
    panel: "w-full max-w-[760px] h-full sm:rounded-r-[24px] border-l-0 border-y-0",
  },
  center: {
    overlay: "items-center justify-center p-4 sm:p-6",
    panel: "w-full max-w-[840px] h-full max-h-[92vh] rounded-[24px]",
  },
  right: {
    overlay: "justify-end",
    panel: "w-full max-w-[760px] h-full sm:rounded-l-[24px] border-r-0 border-y-0",
  },
};

const PANEL_OPTIONS: { id: ReaderPanel; label: string; Icon: typeof AlignLeft }[] = [
  { id: "left", label: "Panel left", Icon: AlignLeft },
  { id: "center", label: "Panel center", Icon: AlignCenter },
  { id: "right", label: "Panel right", Icon: AlignRight },
];

export function ReaderDrawer({
  item,
  onClose,
  onPrev,
  onNext,
  hasPrev,
  hasNext,
  isSaved,
  onToggleSave,
  theme,
  onThemeChange,
  readerFont,
  onReaderFontChange,
  readerSize,
  onReaderSizeChange,
  panel,
  onPanelChange,
}: ReaderDrawerProps) {
  const [article, setArticle] = useState<ArticleResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sourceMode, setSourceMode] = useState<"reader" | "feed">("reader");
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [progress, setProgress] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  // The parent remounts this drawer per story (keyed by item id), so per-item state starts
  // fresh on every navigation and this effect only has to fetch.
  useEffect(() => {
    if (!item) return;

    const controller = new AbortController();

    fetch(`/api/article?url=${encodeURIComponent(item.link)}`, {
      signal: controller.signal,
    })
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || "Could not extract clean article");
        }
        return data as ArticleResponse;
      })
      .then((data) => {
        setArticle(data);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "Failed to load article");
        setLoading(false);
      });

    return () => controller.abort();
  }, [item]);

  useEffect(() => {
    if (!item) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (appearanceOpen) {
          setAppearanceOpen(false);
        } else {
          onClose();
        }
      } else if ((e.key === "ArrowLeft" || e.key === "k") && hasPrev && onPrev) {
        e.preventDefault();
        onPrev();
      } else if ((e.key === "ArrowRight" || e.key === "j") && hasNext && onNext) {
        e.preventDefault();
        onNext();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [item, onClose, onPrev, onNext, hasPrev, hasNext, appearanceOpen]);

  if (!item) return null;

  const fontClass =
    readerFont === "serif" ? "font-serif" : readerFont === "mono" ? "font-mono" : "font-sans";

  const sizeClass =
    readerSize === "sm" ? "text-[15.5px]" : readerSize === "lg" ? "text-[19px]" : "text-[17px]";

  const showCleanArticle = sourceMode === "reader" && article?.contentHtml;
  const fallbackHtml = item.contentHtml;
  // The article API strips the lead photo out of the body, so the hero renders exactly once.
  // In "Feed" mode the RSS HTML is raw, so fall back to a substring guard there.
  const leadImage = sourceMode === "reader" ? article?.leadImage : article?.leadImage || item.image;
  const showHeroImage = Boolean(
    leadImage && !(sourceMode === "feed" && fallbackHtml?.includes(leadImage)),
  );

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    if (max <= 0) {
      setProgress(100);
      return;
    }
    setProgress(Math.min(100, Math.round((el.scrollTop / max) * 100)));
  };

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the sheet has its own J/K/Escape key handling and close button
    <div
      className={`fixed inset-0 z-50 flex bg-black/75 backdrop-blur-[6px] transition-opacity ${PANEL_LAYOUT[panel].overlay}`}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={item.title}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: scroll container that must not dismiss the sheet */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: click containment only, not an interaction */}
      <div
        style={{ boxShadow: "var(--popover-shadow)" }}
        className={`relative flex flex-col bg-[var(--surface)] border border-[var(--border)] overflow-hidden transition-all duration-200 ${PANEL_LAYOUT[panel].panel}`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Cobalt reading progress line */}
        <div className="h-[2.5px] w-full bg-transparent shrink-0">
          <div
            className="h-full bg-[#2446E3] transition-[width] duration-150"
            style={{ width: `${progress}%` }}
          />
        </div>

        {/* Minimalist Technical Header */}
        <header className="flex items-center justify-between gap-2 px-6 sm:px-8 h-14 border-b border-[var(--border)] bg-[var(--surface)] shrink-0">
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={onPrev}
              disabled={!hasPrev}
              title="Previous story (K)"
              className="p-2 rounded-full text-[var(--fg-muted)] hover:text-[var(--fg)] hover:bg-[var(--surface-hover)] disabled:opacity-25 disabled:pointer-events-none transition cursor-pointer"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={onNext}
              disabled={!hasNext}
              title="Next story (J)"
              className="p-2 rounded-full text-[var(--fg-muted)] hover:text-[var(--fg)] hover:bg-[var(--surface-hover)] disabled:opacity-25 disabled:pointer-events-none transition cursor-pointer"
            >
              <ChevronRight className="w-4 h-4" />
            </button>

            {article && fallbackHtml && (
              <div className="ml-2 flex items-center rounded-full bg-[var(--bg)] border border-[var(--border)] p-0.5 font-mono text-[10px] uppercase tracking-[0.1em]">
                <button
                  type="button"
                  onClick={() => setSourceMode("reader")}
                  className={`px-3 py-1 rounded-full transition cursor-pointer ${
                    sourceMode === "reader"
                      ? "bg-[#2446E3] text-white"
                      : "text-[var(--fg-muted)] hover:text-[var(--fg)]"
                  }`}
                >
                  Reader
                </button>
                <button
                  type="button"
                  onClick={() => setSourceMode("feed")}
                  className={`px-3 py-1 rounded-full transition cursor-pointer ${
                    sourceMode === "feed"
                      ? "bg-[#2446E3] text-white"
                      : "text-[var(--fg-muted)] hover:text-[var(--fg)]"
                  }`}
                >
                  Feed
                </button>
              </div>
            )}
          </div>

          <div className="flex items-center gap-1 relative">
            {/* biome-ignore lint/a11y/useSemanticElements: a segmented toggle reads as a radiogroup, but the buttons are plain toggles */}
            <div
              role="group"
              aria-label="Reader panel position"
              className="hidden sm:flex items-center rounded-full bg-[var(--bg)] border border-[var(--border)] p-0.5 mr-1"
            >
              {PANEL_OPTIONS.map(({ id, label, Icon }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => onPanelChange(id)}
                  title={label}
                  aria-label={label}
                  aria-pressed={panel === id}
                  className={`p-1.5 rounded-full transition cursor-pointer ${
                    panel === id
                      ? "bg-[#2446E3] text-white"
                      : "text-[var(--fg-muted)] hover:text-[var(--fg)]"
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={() => setAppearanceOpen((v) => !v)}
              title="Typography & Theme"
              className={`p-2 rounded-full transition cursor-pointer ${
                appearanceOpen
                  ? "bg-[#2446E3] text-white"
                  : "text-[var(--fg-muted)] hover:text-[var(--fg)] hover:bg-[var(--surface-hover)]"
              }`}
            >
              <Type className="w-4 h-4" />
            </button>

            {appearanceOpen && (
              <>
                {/* biome-ignore lint/a11y/noStaticElementInteractions: transparent click-catcher that closes the popover */}
                {/* biome-ignore lint/a11y/useKeyWithClickEvents: Escape closes the whole reader sheet */}
                <div className="fixed inset-0 z-10" onClick={() => setAppearanceOpen(false)} />
                <div
                  style={{ boxShadow: "var(--popover-shadow)" }}
                  className="absolute right-0 top-12 z-20 w-64 rounded-2xl bg-[var(--surface-elevated)] border border-[var(--border)] p-4 space-y-4 text-xs"
                >
                  <div className="space-y-1.5">
                    <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--fg-muted)]">
                      Typeface
                    </span>
                    <div className="grid grid-cols-3 gap-1 p-1 rounded-xl bg-[var(--bg)] border border-[var(--border)]">
                      {(["sans", "serif", "mono"] as ReaderFont[]).map((f) => (
                        <button
                          key={f}
                          type="button"
                          onClick={() => onReaderFontChange(f)}
                          className={`py-1.5 rounded-lg font-mono text-[10px] uppercase tracking-[0.08em] transition cursor-pointer ${
                            readerFont === f
                              ? "bg-[#2446E3] text-white"
                              : "text-[var(--fg-muted)] hover:text-[var(--fg)]"
                          }`}
                        >
                          {f}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--fg-muted)]">
                      Scale
                    </span>
                    <div className="grid grid-cols-3 gap-1 p-1 rounded-xl bg-[var(--bg)] border border-[var(--border)]">
                      {(
                        [
                          { id: "sm", label: "S" },
                          { id: "md", label: "M" },
                          { id: "lg", label: "L" },
                        ] as { id: ReaderSize; label: string }[]
                      ).map((s) => (
                        <button
                          key={s.id}
                          type="button"
                          onClick={() => onReaderSizeChange(s.id)}
                          className={`py-1.5 rounded-lg font-mono text-[10px] uppercase transition cursor-pointer ${
                            readerSize === s.id
                              ? "bg-[#2446E3] text-white"
                              : "text-[var(--fg-muted)] hover:text-[var(--fg)]"
                          }`}
                        >
                          {s.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--fg-muted)]">
                      Canvas
                    </span>
                    <div className="grid grid-cols-3 gap-1.5">
                      {(
                        [
                          {
                            id: "dark",
                            label: "Dark",
                            swatch: "bg-[#111113] border-white/20 text-white",
                          },
                          {
                            id: "light",
                            label: "Light",
                            swatch: "bg-[#ffffff] border-black/15 text-black",
                          },
                          {
                            id: "sepia",
                            label: "Sepia",
                            swatch: "bg-[#f4efe6] border-amber-900/20 text-stone-900",
                          },
                        ] as { id: ThemeMode; label: string; swatch: string }[]
                      ).map((t) => (
                        <button
                          key={t.id}
                          type="button"
                          onClick={() => onThemeChange(t.id)}
                          className={`py-2 rounded-xl border font-mono text-[10px] uppercase tracking-[0.08em] transition cursor-pointer ${t.swatch} ${
                            theme === t.id ? "ring-2 ring-[#2446E3]" : ""
                          }`}
                        >
                          {t.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </>
            )}

            <button
              type="button"
              onClick={() => onToggleSave(item)}
              title={isSaved ? "Remove bookmark" : "Save for later"}
              className={`p-2 rounded-full transition cursor-pointer ${
                isSaved
                  ? "bg-[#2446E3] text-white"
                  : "text-[var(--fg-muted)] hover:text-[var(--fg)] hover:bg-[var(--surface-hover)]"
              }`}
            >
              {isSaved ? <BookmarkCheck className="w-4 h-4" /> : <Bookmark className="w-4 h-4" />}
            </button>

            <a
              href={item.link}
              target="_blank"
              rel="noopener noreferrer"
              title="Open original page"
              className="p-2 rounded-full text-[var(--fg-muted)] hover:text-[var(--fg)] hover:bg-[var(--surface-hover)] transition"
            >
              <ExternalLink className="w-4 h-4" />
            </a>

            <button
              type="button"
              onClick={onClose}
              title="Close (Esc)"
              className="p-2 rounded-full text-[var(--fg-muted)] hover:text-[var(--fg)] hover:bg-[var(--surface-hover)] transition cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </header>

        {/* Article Content */}
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="flex-1 overflow-y-auto px-7 sm:px-14 py-10"
        >
          <article className="max-w-[60ch] mx-auto pb-20">
            {/* Monospace Kicker */}
            <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] uppercase tracking-[0.14em] text-[var(--fg-muted)] mb-5">
              <span className="text-[#2446E3] font-semibold">
                {article?.siteName || item.feedTitle || getHostname(item.link)}
              </span>
              {item.isoDate && (
                <>
                  <span>·</span>
                  <span>{formatFullDate(item.isoDate)}</span>
                </>
              )}
              {article?.readingTimeMinutes && (
                <>
                  <span>·</span>
                  <span>{String(article.readingTimeMinutes).padStart(2, "0")} MIN READ</span>
                </>
              )}
            </div>

            {/* Heavy Display Headline */}
            <h1 className="font-display text-[26px] sm:text-[34px] uppercase tracking-[-0.025em] leading-[1.04] text-[var(--fg)] mb-4">
              {article?.title || item.title}
            </h1>

            {(article?.byline || item.author) && (
              <p className="font-mono text-[11px] uppercase tracking-[0.1em] text-[var(--fg-muted)] mb-8">
                By {(article?.byline || item.author || "").replace(/^by\s+/i, "")}
              </p>
            )}

            {loading && (
              <div className="flex items-center gap-2.5 font-mono text-[11px] uppercase tracking-[0.1em] text-[var(--fg-muted)] py-3 px-4 rounded-xl bg-[var(--bg)] border border-[var(--border)] mb-8">
                <Loader2 className="w-3.5 h-3.5 animate-spin text-[#2446E3]" />
                <span>Extracting clean article from {getHostname(item.link)}…</span>
              </div>
            )}

            {showHeroImage && (
              <img
                src={leadImage}
                alt=""
                className="w-full max-h-[380px] object-cover rounded-2xl mb-8 bg-[var(--bg)]"
              />
            )}

            {showCleanArticle ? (
              <div
                className={`reader-prose ${fontClass} ${sizeClass}`}
                // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized server-side by sanitizeArticleHtml
                dangerouslySetInnerHTML={{ __html: article.contentHtml }}
              />
            ) : fallbackHtml ? (
              <>
                {error && (
                  <div className="flex items-start gap-2.5 text-xs text-[var(--fg-muted)] p-4 rounded-xl bg-[var(--bg)] border border-[var(--border)] mb-8">
                    <AlertCircle className="w-4 h-4 shrink-0 text-[#2446E3] mt-0.5" />
                    <div>
                      <p className="font-mono text-[11px] uppercase tracking-[0.1em] text-[var(--fg)]">
                        Feed Content Mode
                      </p>
                      <p className="mt-1">{error}</p>
                    </div>
                  </div>
                )}
                <div
                  className={`reader-prose ${fontClass} ${sizeClass}`}
                  // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized server-side by sanitizeArticleHtml
                  dangerouslySetInnerHTML={{ __html: fallbackHtml }}
                />
              </>
            ) : !loading ? (
              <div className="space-y-5">
                {item.summary && (
                  <p className={`reader-prose ${fontClass} ${sizeClass}`}>{item.summary}</p>
                )}
                {error && (
                  <div className="p-5 rounded-2xl bg-[var(--bg)] border border-[var(--border)] text-xs text-[var(--fg-muted)] space-y-2.5">
                    <p className="font-mono uppercase tracking-[0.1em] text-[var(--fg)]">
                      Automatic Extraction Blocked
                    </p>
                    <p>{error}</p>
                    <a
                      href={item.link}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 font-mono uppercase tracking-[0.1em] text-[#2446E3] hover:underline pt-1"
                    >
                      Open original <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  </div>
                )}
              </div>
            ) : null}

            <footer className="mt-14 pt-6 border-t border-[var(--border)] flex items-center justify-between font-mono text-[11px] uppercase tracking-[0.12em] text-[var(--fg-muted)]">
              <span>{getHostname(item.link)}</span>
              <a
                href={item.link}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-[var(--fg)] hover:text-[#2446E3] transition"
              >
                Original <ExternalLink className="w-3.5 h-3.5" />
              </a>
            </footer>
          </article>
        </div>
      </div>
    </div>
  );
}
