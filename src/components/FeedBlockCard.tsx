import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Bookmark,
  CheckCheck,
  ChevronDown,
  ChevronUp,
  Copy,
  GripVertical,
  Minus,
  Plus,
  RefreshCw,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import type { CSSProperties } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { clampSpan, computeResizedSpan, MAX_ROW_SPAN } from "@/lib/grid";
import {
  BLOCK_SURFACES,
  type BlockSurface,
  type FeedBlock,
  type FeedItem,
  type FeedResponse,
  resolveBlockSurface,
  type ViewMode,
} from "@/lib/types";

interface FeedBlockCardProps {
  block: FeedBlock;
  columns: number;
  editGrid: boolean;
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  getGridWidth: () => number;
  refreshSignal: number;
  searchQuery: string;
  readSet: Set<string>;
  savedIds: Set<string>;
  canMovePrev: boolean;
  canMoveNext: boolean;
  onUpdate: (patch: Partial<FeedBlock>) => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onMoveOrder: (dir: -1 | 1) => void;
  onOpenArticle: (item: FeedItem, siblings: FeedItem[]) => void;
  onMarkManyRead: (ids: string[]) => void;
  onToggleSave: (item: FeedItem) => void;
  onDragStartBlock: (blockId: string) => void;
  onDragEndBlock: () => void;
  onDropOnBlock: (targetBlockId: string) => void;
  isDragging: boolean;
}

const PANEL_GAP = 12; // card edge -> panel edge
const VIEW_MARGIN = 16; // minimum breathing room from any viewport edge

interface PanelPlacement {
  side: boolean; // true = docked beside the card, false = centered dialog fallback
  top: number;
  left: number;
}

// Dock to the right of the card when a full panel width fits, else to the left, else center it.
// `height` is already capped by the panel's max-height (85vh), so both clamps below are satisfiable:
// top >= VIEW_MARGIN and top + height <= innerHeight - VIEW_MARGIN.
function computePanelPlacement(card: DOMRect, width: number, height: number): PanelPlacement {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const roomRight = vw - VIEW_MARGIN - (card.right + PANEL_GAP);
  const roomLeft = card.left - PANEL_GAP - VIEW_MARGIN;

  if (width <= roomRight || width <= roomLeft) {
    const left = width <= roomRight ? card.right + PANEL_GAP : card.left - PANEL_GAP - width;
    const maxTop = Math.max(VIEW_MARGIN, vh - VIEW_MARGIN - height);
    return {
      side: true,
      left: Math.max(VIEW_MARGIN, left),
      top: Math.min(Math.max(VIEW_MARGIN, card.top), maxTop),
    };
  }

  return {
    side: false,
    left: Math.max(VIEW_MARGIN, (vw - width) / 2),
    top: Math.max(VIEW_MARGIN, (vh - height) / 2),
  };
}

const VIEW_MODES: { value: ViewMode; label: string }[] = [
  { value: "compact", label: "Compact" },
  { value: "headlines", label: "Headlines" },
  { value: "cards", label: "Cards" },
  { value: "magazine", label: "Magazine" },
];

function relativeTime(iso?: string): string {
  if (!iso) return "";
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  const mins = Math.max(1, Math.floor(ms / 60_000));
  if (mins < 60) return `${mins}M`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}H`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}D`;
  return new Date(iso)
    .toLocaleDateString(undefined, { month: "short", day: "numeric" })
    .toUpperCase();
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="inline-flex items-center gap-2 text-[11px] font-mono uppercase tracking-[0.08em] text-[var(--c-secondary)] hover:text-[var(--c-fg)] transition cursor-pointer"
    >
      <span
        className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${
          checked ? "bg-[var(--c-pill-bg)]" : "bg-[var(--c-divider)]"
        }`}
      >
        <span
          className={`inline-block h-3 w-3 transform rounded-full transition-transform ${
            checked
              ? "translate-x-3.5 bg-[var(--c-pill-fg)]"
              : "translate-x-0.5 bg-[var(--c-fg)]/70"
          }`}
        />
      </span>
      <span>{label}</span>
    </button>
  );
}

export function FeedBlockCard({
  block,
  columns,
  editGrid,
  editing,
  onEditingChange,
  getGridWidth,
  refreshSignal,
  searchQuery,
  readSet,
  savedIds,
  canMovePrev,
  canMoveNext,
  onUpdate,
  onDelete,
  onDuplicate,
  onMoveOrder,
  onOpenArticle,
  onMarkManyRead,
  onToggleSave,
  onDragStartBlock,
  onDragEndBlock,
  onDropOnBlock,
  isDragging,
}: FeedBlockCardProps) {
  const [feed, setFeed] = useState<FeedResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [faviconBroken, setFaviconBroken] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [resizing, setResizing] = useState<{ colSpan: number; rowSpan: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLElement>(null);
  const customizeTriggerRef = useRef<HTMLButtonElement>(null);
  const [placement, setPlacement] = useState<PanelPlacement | null>(null);
  // Set only on the keyboard/trigger close paths, so an outside click never yanks focus back.
  const restoreFocusRef = useRef(false);

  // Dismiss the popover on outside pointerdown or Escape. Listeners live only while it is open.
  // The portaled panel is ref-checked, not DOM-parented, so "inside" clicks still read as inside.
  useEffect(() => {
    if (!editing) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target) || customizeTriggerRef.current?.contains(target))
        return;
      // The centered-mode backdrop closes on its own click event; closing here instead would
      // unmount it mid-interaction and let the same tap land on the trigger and reopen the panel.
      if (backdropRef.current?.contains(target)) return;
      onEditingChange(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      restoreFocusRef.current = true;
      onEditingChange(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [editing, onEditingChange]);

  // Measure the trigger card and the panel, then place the panel (fixed, so page scroll cannot
  // detach it). Runs before paint, so the first frame is already positioned; re-runs throttled
  // through rAF on scroll/resize while open. Width is fixed, so re-measuring never oscillates.
  useLayoutEffect(() => {
    if (!editing) {
      setPlacement(null);
      return;
    }
    let frame = 0;
    const measure = () => {
      frame = 0;
      const card = cardRef.current?.getBoundingClientRect();
      const panel = panelRef.current;
      if (!card || !panel) return;
      const rect = panel.getBoundingClientRect();
      const next = computePanelPlacement(card, rect.width, rect.height);
      setPlacement((prev) =>
        prev &&
        prev.side === next.side &&
        Math.abs(prev.top - next.top) < 0.5 &&
        Math.abs(prev.left - next.left) < 0.5
          ? prev
          : next,
      );
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
    };
  }, [editing]);

  // Focus the first control once the panel is actually laid out (a visibility:hidden element
  // cannot take focus), and hand focus back to the trigger when it closes.
  const panelReady = editing && placement !== null;
  useEffect(() => {
    if (!panelReady) return;
    panelRef.current?.querySelector<HTMLElement>("input, select, button")?.focus({
      preventScroll: true,
    });
  }, [panelReady]);
  useEffect(() => {
    if (editing || !restoreFocusRef.current) return;
    restoreFocusRef.current = false;
    customizeTriggerRef.current?.focus({ preventScroll: true });
  }, [editing]);

  const resizeOriginRef = useRef<{
    x: number;
    y: number;
    startCol: number;
    startRow: number;
    gridWidth: number;
  } | null>(null);

  const { colSpan: effColSpan, rowSpan: effRowSpan } = clampSpan(
    resizing?.colSpan ?? block.colSpan,
    resizing?.rowSpan ?? block.rowSpan,
    columns,
  );

  const loadFeed = useCallback(
    async (forceRefresh = false) => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/feed?url=${encodeURIComponent(block.url)}${forceRefresh ? "&refresh=1" : ""}`,
        );
        const data = (await res.json()) as FeedResponse & { error?: string };
        if (!res.ok) {
          throw new Error(data.error || "Failed to load feed");
        }
        setFeed(data);
        setFaviconBroken(false);
        if (data.feedUrl && data.feedUrl !== block.url) {
          // Canonical URL discovered from a bare site URL. Updating block.url also re-keys the
          // URL input below, so it repopulates without a draft-state mirror.
          onUpdate({ url: data.feedUrl });
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load feed");
      } finally {
        setLoading(false);
      }
    },
    [block.url, onUpdate],
  );

  useEffect(() => {
    // Data fetch on mount and on an explicit refresh signal. fetch is async and the state
    // updates all land after an await; the synchronous setLoading(true) is intentional so the
    // skeleton shows immediately rather than after the first tick.
    loadFeed(refreshSignal > 0);
  }, [loadFeed, refreshSignal]);

  useEffect(() => {
    if (!block.refreshMinutes || block.refreshMinutes <= 0) return;
    const id = window.setInterval(() => {
      loadFeed(true);
    }, block.refreshMinutes * 60_000);
    return () => window.clearInterval(id);
  }, [block.refreshMinutes, loadFeed]);

  const surface = resolveBlockSurface(block.accent);

  const visibleItems = useMemo(() => {
    const items = feed?.items ?? [];
    const q = searchQuery.trim().toLowerCase();
    const filtered = q
      ? items.filter(
          (it) =>
            it.title.toLowerCase().includes(q) ||
            (it.summary?.toLowerCase().includes(q) ?? false) ||
            (it.author?.toLowerCase().includes(q) ?? false),
        )
      : items;
    return filtered.slice(0, block.limit);
  }, [feed, searchQuery, block.limit]);

  const unreadCount = useMemo(
    () => visibleItems.filter((it) => !readSet.has(it.id)).length,
    [visibleItems, readSet],
  );

  const handleSaveUrl = (e: React.FormEvent) => {
    e.preventDefault();
    const input = new FormData(e.currentTarget as HTMLFormElement).get("feed-url");
    const trimmed = typeof input === "string" ? input.trim() : "";
    if (trimmed && trimmed !== block.url) {
      onUpdate({ url: trimmed });
    } else {
      loadFeed(true);
    }
  };

  // Interactive drag-to-resize corner handle (Pointer Events, zero extra deps)
  const handleResizePointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const current = clampSpan(block.colSpan, block.rowSpan, columns);
    resizeOriginRef.current = {
      x: e.clientX,
      y: e.clientY,
      startCol: current.colSpan,
      startRow: current.rowSpan,
      gridWidth: getGridWidth(),
    };
    setResizing(current);
  };

  const handleResizePointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const origin = resizeOriginRef.current;
    if (!origin) return;
    const next = computeResizedSpan({
      startColSpan: origin.startCol,
      startRowSpan: origin.startRow,
      deltaX: e.clientX - origin.x,
      deltaY: e.clientY - origin.y,
      gridWidth: origin.gridWidth,
      columns,
    });
    setResizing((prev) =>
      prev && prev.colSpan === next.colSpan && prev.rowSpan === next.rowSpan ? prev : next,
    );
  };

  const handleResizePointerUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!resizeOriginRef.current) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    const finalSpan = resizing;
    resizeOriginRef.current = null;
    setResizing(null);
    if (finalSpan && (finalSpan.colSpan !== block.colSpan || finalSpan.rowSpan !== block.rowSpan)) {
      onUpdate({ colSpan: finalSpan.colSpan, rowSpan: finalSpan.rowSpan, collapsed: false });
    }
  };

  const spanPresets = useMemo(() => {
    const list: Array<{ c: number; r: number }> = [
      { c: 1, r: 1 },
      { c: 1, r: 2 },
    ];
    if (columns >= 2) {
      list.push({ c: 2, r: 1 }, { c: 2, r: 2 });
    }
    if (columns >= 3) {
      list.push({ c: 3, r: 1 });
    }
    return list;
  }, [columns]);

  const cardStyle: CSSProperties = {
    ...surface.vars,
    ["--col-span" as string]: effColSpan,
    ["--row-span" as string]: effRowSpan,
  };

  const isWide = effColSpan >= 2;
  const subGridClass =
    effColSpan >= 3
      ? "grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-x-2"
      : effColSpan === 2
        ? "grid grid-cols-1 md:grid-cols-2 gap-x-2"
        : "";

  const handleStoryClick = (item: FeedItem) => {
    if (editGrid) return;
    onOpenArticle(item, visibleItems);
  };

  return (
    <div
      data-collapsed={block.collapsed ? "true" : "false"}
      style={cardStyle}
      className={`bento-item group/block relative ${isDragging ? "opacity-35 scale-[0.985]" : ""} ${
        resizing || editing ? "z-20" : ""
      }`}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: drag-reorder surface; the inner feed links and buttons carry the real interactions */}
      <section
        ref={cardRef}
        draggable={!resizing}
        onDragStart={(e) => {
          if (resizing) {
            e.preventDefault();
            return;
          }
          const target = e.target as HTMLElement | null;
          if (target && ["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(target.tagName)) {
            e.preventDefault();
            return;
          }
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", block.id);
          onDragStartBlock(block.id);
        }}
        onDragEnd={() => {
          setDragOver(false);
          onDragEndBlock();
        }}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          if (!dragOver) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setDragOver(false);
          onDropOnBlock(block.id);
        }}
        className={`relative flex h-full flex-col rounded-[22px] bg-[var(--c-bg)] text-[var(--c-fg)] border border-[var(--c-border)] overflow-hidden transition-[transform,opacity,box-shadow] duration-200 ${
          dragOver ? "ring-2 ring-[#2446E3] ring-offset-2 ring-offset-[var(--bg)]" : ""
        } ${resizing ? "ring-2 ring-[#2446E3] select-none" : ""} ${
          editGrid ? "ring-1 ring-[var(--c-divider)] cursor-grab active:cursor-grabbing" : ""
        }`}
      >
        {/* Grid Editor Top HUD Strip */}
        {editGrid && (
          <div className="px-4 py-2.5 bg-[var(--c-panel)] border-b border-[var(--c-divider)] flex flex-wrap items-center justify-between gap-2 shrink-0 select-none">
            <div className="flex items-center gap-1.5">
              <GripVertical className="w-3.5 h-3.5 text-[var(--c-muted)]" />
              <span className="px-2 py-0.5 rounded-md bg-[#2446E3] text-white font-mono text-[10px] font-semibold tracking-[0.08em]">
                {effColSpan}×{effRowSpan}
              </span>
              <div className="flex items-center gap-0.5 ml-1">
                <button
                  type="button"
                  disabled={!canMovePrev}
                  onClick={() => onMoveOrder(-1)}
                  title="Move earlier"
                  className="p-1 rounded-md bg-[var(--c-input)] text-[var(--c-fg)] hover:opacity-80 disabled:opacity-30 cursor-pointer"
                >
                  <ArrowLeft className="w-3 h-3" />
                </button>
                <button
                  type="button"
                  disabled={!canMoveNext}
                  onClick={() => onMoveOrder(1)}
                  title="Move later"
                  className="p-1 rounded-md bg-[var(--c-input)] text-[var(--c-fg)] hover:opacity-80 disabled:opacity-30 cursor-pointer"
                >
                  <ArrowRight className="w-3 h-3" />
                </button>
              </div>
            </div>

            {/* Quick Span Preset Pills + Steppers */}
            <div className="flex items-center gap-1">
              {spanPresets.map((p) => {
                const active = effColSpan === p.c && effRowSpan === p.r;
                return (
                  <button
                    key={`${p.c}x${p.r}`}
                    type="button"
                    onClick={() => onUpdate({ colSpan: p.c, rowSpan: p.r, collapsed: false })}
                    className={`px-1.5 py-0.5 rounded-md font-mono text-[10px] transition cursor-pointer ${
                      active
                        ? "bg-[var(--c-pill-bg)] text-[var(--c-pill-fg)] font-semibold"
                        : "bg-[var(--c-input)] text-[var(--c-muted)] hover:text-[var(--c-fg)]"
                    }`}
                  >
                    {p.c}×{p.r}
                  </button>
                );
              })}

              <div className="hidden sm:flex items-center gap-0.5 ml-1 pl-1.5 border-l border-[var(--c-divider)]">
                <button
                  type="button"
                  disabled={effColSpan <= 1}
                  onClick={() => onUpdate({ colSpan: Math.max(1, effColSpan - 1) })}
                  title="Narrower"
                  className="p-1 rounded bg-[var(--c-input)] text-[var(--c-muted)] hover:text-[var(--c-fg)] disabled:opacity-30 cursor-pointer"
                >
                  <Minus className="w-2.5 h-2.5" />
                </button>
                <span className="font-mono text-[9.5px] text-[var(--c-muted)] px-0.5">W</span>
                <button
                  type="button"
                  disabled={effColSpan >= columns}
                  onClick={() => onUpdate({ colSpan: Math.min(columns, effColSpan + 1) })}
                  title="Wider"
                  className="p-1 rounded bg-[var(--c-input)] text-[var(--c-muted)] hover:text-[var(--c-fg)] disabled:opacity-30 cursor-pointer"
                >
                  <Plus className="w-2.5 h-2.5" />
                </button>
              </div>

              <div className="hidden sm:flex items-center gap-0.5 ml-0.5">
                <button
                  type="button"
                  disabled={effRowSpan <= 1}
                  onClick={() => onUpdate({ rowSpan: Math.max(1, effRowSpan - 1) })}
                  title="Shorter"
                  className="p-1 rounded bg-[var(--c-input)] text-[var(--c-muted)] hover:text-[var(--c-fg)] disabled:opacity-30 cursor-pointer"
                >
                  <Minus className="w-2.5 h-2.5" />
                </button>
                <span className="font-mono text-[9.5px] text-[var(--c-muted)] px-0.5">H</span>
                <button
                  type="button"
                  disabled={effRowSpan >= MAX_ROW_SPAN}
                  onClick={() =>
                    onUpdate({ rowSpan: Math.min(MAX_ROW_SPAN, effRowSpan + 1), collapsed: false })
                  }
                  title="Taller"
                  className="p-1 rounded bg-[var(--c-input)] text-[var(--c-muted)] hover:text-[var(--c-fg)] disabled:opacity-30 cursor-pointer"
                >
                  <Plus className="w-2.5 h-2.5" />
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Single-Row Card Header: Icon -> Title -> Unread */}
        <div className="px-5 py-4 flex items-center justify-between gap-2 select-none shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            {!editGrid && (
              <span
                title="Drag to reorder"
                className="cursor-grab active:cursor-grabbing text-[var(--c-muted)] -ml-1.5 opacity-0 group-hover/block:opacity-80 hover:!opacity-100 transition-opacity shrink-0"
              >
                <GripVertical className="w-3.5 h-3.5" />
              </span>
            )}

            {feed?.favicon && !faviconBroken ? (
              <img
                src={feed.favicon}
                alt=""
                width={18}
                height={18}
                onError={() => setFaviconBroken(true)}
                className="w-[18px] h-[18px] rounded-[5px] shrink-0 bg-white/95 p-[1.5px]"
              />
            ) : (
              <span className="px-1.5 py-0.5 rounded-[5px] bg-[var(--c-pill-bg)] text-[var(--c-pill-fg)] font-display text-[9px] tracking-tight leading-none shrink-0">
                {block.title.slice(0, 3).toUpperCase()}
              </span>
            )}

            <h2 className="font-display text-[15.5px] uppercase tracking-[-0.02em] leading-none text-[var(--c-fg)] truncate">
              {block.title}
            </h2>

            {!block.collapsed && unreadCount > 0 && (
              <span className="font-mono text-[11px] tabular-nums text-[var(--c-muted)] shrink-0">
                {String(unreadCount).padStart(2, "0")}
              </span>
            )}
          </div>

          <div
            className={`flex items-center gap-0.5 shrink-0 transition-opacity duration-150 ${
              editing || loading || block.collapsed || editGrid
                ? "opacity-100"
                : "opacity-0 group-hover/block:opacity-100 focus-within:opacity-100"
            }`}
          >
            {unreadCount > 0 && !block.collapsed && !editGrid && (
              <button
                type="button"
                onClick={() => onMarkManyRead(visibleItems.map((i) => i.id))}
                title="Mark all read"
                className="p-1.5 rounded-lg text-[var(--c-muted)] hover:text-[var(--c-fg)] hover:bg-[var(--c-hover)] transition cursor-pointer"
              >
                <CheckCheck className="w-3.5 h-3.5" />
              </button>
            )}
            <button
              type="button"
              onClick={() => loadFeed(true)}
              title="Refresh feed"
              className="p-1.5 rounded-lg text-[var(--c-muted)] hover:text-[var(--c-fg)] hover:bg-[var(--c-hover)] transition cursor-pointer"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 ${loading ? "animate-spin text-[var(--c-fg)]" : ""}`}
              />
            </button>
            <button
              ref={customizeTriggerRef}
              type="button"
              onClick={() => onEditingChange(!editing)}
              title="Customize block"
              aria-expanded={editing}
              aria-haspopup="dialog"
              className={`p-1.5 rounded-lg transition cursor-pointer ${
                editing
                  ? "bg-[var(--c-pill-bg)] text-[var(--c-pill-fg)]"
                  : "text-[var(--c-muted)] hover:text-[var(--c-fg)] hover:bg-[var(--c-hover)]"
              }`}
            >
              <SlidersHorizontal className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => onUpdate({ collapsed: !block.collapsed })}
              title={block.collapsed ? "Expand" : "Collapse"}
              className="p-1.5 rounded-lg text-[var(--c-muted)] hover:text-[var(--c-fg)] hover:bg-[var(--c-hover)] transition cursor-pointer"
            >
              {block.collapsed ? (
                <ChevronDown className="w-3.5 h-3.5" />
              ) : (
                <ChevronUp className="w-3.5 h-3.5" />
              )}
            </button>
          </div>
        </div>

        {/* Stories Body — fills remaining bento height cleanly */}
        {!block.collapsed && (
          <div
            className={`flex-1 min-h-0 overflow-y-auto border-t border-[var(--c-divider)] ${
              editGrid ? "pointer-events-none opacity-85" : ""
            }`}
          >
            {loading && !feed && (
              <div className="p-6 space-y-4 animate-pulse">
                {Array.from({ length: Math.min(block.limit, 4) }).map((_, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton rows, never reordered
                  <div key={i} className="space-y-2">
                    <div className="h-3.5 bg-[var(--c-hover)] rounded w-11/12" />
                    <div className="h-2.5 bg-[var(--c-hover)] rounded w-2/5" />
                  </div>
                ))}
              </div>
            )}

            {error && !feed && (
              <div className="p-6 text-xs text-[var(--c-secondary)] space-y-2.5">
                <div className="flex items-center gap-2 font-mono uppercase tracking-[0.1em] text-[var(--c-fg)]">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                  <span>Feed Unavailable</span>
                </div>
                <p className="text-[11px] text-[var(--c-muted)] break-all leading-relaxed">
                  {error}
                </p>
                <button
                  type="button"
                  onClick={() => loadFeed(true)}
                  className="font-mono text-[11px] uppercase tracking-[0.1em] text-[var(--c-fg)] underline underline-offset-4 cursor-pointer pointer-events-auto"
                >
                  Retry
                </button>
              </div>
            )}

            {feed && visibleItems.length === 0 && (
              <div className="px-6 py-10 font-mono text-[11px] uppercase tracking-[0.12em] text-[var(--c-muted)] text-center">
                {searchQuery.trim() ? "No matching stories" : "No stories yet"}
              </div>
            )}

            {/* Wide Magazine Layout: Split Editorial Hero + Multi-Column Secondary List */}
            {block.viewMode === "magazine" && visibleItems.length > 0 ? (
              <div className="px-3 py-2.5 space-y-2">
                {(() => {
                  const hero = visibleItems[0];
                  const rest = visibleItems.slice(1);
                  const heroRead = readSet.has(hero.id);
                  const heroSaved = savedIds.has(hero.id);
                  const showHeroImg = Boolean(hero.image);

                  return (
                    <>
                      {/* biome-ignore lint/a11y/noStaticElementInteractions: hero card is the click target; nested save button stays separate */}
                      {/* biome-ignore lint/a11y/useKeyWithClickEvents: same article is reachable from the headline list below */}
                      <div
                        onClick={() => handleStoryClick(hero)}
                        className={`group/item p-3 rounded-2xl hover:bg-[var(--c-hover)] cursor-pointer transition-colors ${
                          isWide && showHeroImg
                            ? "grid grid-cols-1 md:grid-cols-12 gap-5 items-center"
                            : "space-y-3.5"
                        }`}
                      >
                        {showHeroImg && (
                          <div
                            className={`overflow-hidden rounded-xl bg-black/20 ${
                              isWide ? "md:col-span-6 aspect-[16/10]" : "aspect-[16/10]"
                            }`}
                          >
                            <img
                              src={hero.image}
                              alt=""
                              loading="lazy"
                              className="w-full h-full object-cover group-hover/item:scale-[1.03] transition-transform duration-500 ease-out"
                            />
                          </div>
                        )}
                        <div
                          className={`space-y-2.5 ${isWide && showHeroImg ? "md:col-span-6" : ""}`}
                        >
                          <h3
                            className={`font-display uppercase leading-[1.04] tracking-[-0.025em] ${
                              isWide ? "text-[22px] xl:text-[26px]" : "text-[20px]"
                            } ${heroRead ? "text-[var(--c-muted)]" : "text-[var(--c-fg)]"}`}
                          >
                            {hero.title}
                          </h3>
                          {block.showExcerpts && hero.summary && (
                            <p className="text-[13.5px] text-[var(--c-secondary)] line-clamp-3 leading-[1.52]">
                              {hero.summary}
                            </p>
                          )}
                          <div className="flex items-center justify-between font-mono text-[10.5px] uppercase tracking-[0.1em] text-[var(--c-muted)] pt-1">
                            <span className="truncate">
                              {[hero.author, relativeTime(hero.isoDate)]
                                .filter(Boolean)
                                .join(" · ")}
                            </span>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                onToggleSave(hero);
                              }}
                              title={heroSaved ? "Saved" : "Save for later"}
                              className={`p-1 -mr-1 rounded-md transition cursor-pointer ${
                                heroSaved
                                  ? "text-[var(--c-fg)]"
                                  : "opacity-0 group-hover/item:opacity-100 hover:text-[var(--c-fg)]"
                              }`}
                            >
                              <Bookmark
                                className={`w-3.5 h-3.5 ${heroSaved ? "fill-current" : ""}`}
                              />
                            </button>
                          </div>
                        </div>
                      </div>

                      {rest.length > 0 && (
                        <div className={`pt-2 border-t border-[var(--c-divider)] ${subGridClass}`}>
                          {rest.map((item) => {
                            const isRead = readSet.has(item.id);
                            return (
                              // biome-ignore lint/a11y/noStaticElementInteractions: whole row opens the reader; the save button inside stops propagation
                              // biome-ignore lint/a11y/useKeyWithClickEvents: the same story is reachable from the compact list and via the reader's J/K keys
                              <div
                                key={item.id}
                                onClick={() => handleStoryClick(item)}
                                className="group/item flex items-baseline justify-between gap-3 px-3 py-2.5 rounded-xl hover:bg-[var(--c-hover)] cursor-pointer transition-colors"
                              >
                                <h3
                                  className={`text-[14px] leading-[1.36] tracking-[-0.015em] line-clamp-2 ${
                                    isRead
                                      ? "text-[var(--c-muted)] font-normal"
                                      : "text-[var(--c-fg)] font-semibold"
                                  }`}
                                >
                                  {item.title}
                                </h3>
                                <span className="font-mono text-[10.5px] tabular-nums text-[var(--c-muted)] shrink-0">
                                  {relativeTime(item.isoDate)}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </>
                  );
                })()}
              </div>
            ) : (
              <div className={`px-3 py-2 ${subGridClass}`}>
                {visibleItems.map((item, idx) => {
                  const isRead = readSet.has(item.id);
                  const isSaved = savedIds.has(item.id);
                  const isLast = idx === visibleItems.length - 1;
                  const showDivider = !isWide && !isLast;
                  const showThumb =
                    item.image &&
                    block.showImages &&
                    (block.viewMode === "cards" || block.viewMode === "headlines");

                  if (block.viewMode === "compact") {
                    return (
                      // biome-ignore lint/a11y/noStaticElementInteractions: whole row opens the reader; the save button inside stops propagation
                      // biome-ignore lint/a11y/useKeyWithClickEvents: rows are also reachable from the reader's J/K navigation
                      <div
                        key={item.id}
                        onClick={() => handleStoryClick(item)}
                        className={`group/item relative flex items-baseline justify-between gap-4 px-3 py-2.5 rounded-xl hover:bg-[var(--c-hover)] cursor-pointer transition-colors ${
                          showDivider
                            ? "after:content-[''] after:absolute after:bottom-0 after:left-3 after:right-3 after:h-px after:bg-[var(--c-divider)] hover:after:opacity-0"
                            : ""
                        }`}
                      >
                        <span
                          className={`text-[14px] leading-[1.38] tracking-[-0.01em] line-clamp-2 ${
                            isRead
                              ? "text-[var(--c-muted)] font-normal"
                              : "text-[var(--c-fg)] font-medium"
                          }`}
                        >
                          {item.title}
                        </span>
                        <span className="font-mono text-[10.5px] tabular-nums text-[var(--c-muted)] shrink-0">
                          {relativeTime(item.isoDate)}
                        </span>
                      </div>
                    );
                  }

                  if (block.viewMode === "cards") {
                    return (
                      // biome-ignore lint/a11y/noStaticElementInteractions: whole card opens the reader; the save button inside stops propagation
                      // biome-ignore lint/a11y/useKeyWithClickEvents: cards are also reachable from the reader's J/K navigation
                      <div
                        key={item.id}
                        onClick={() => handleStoryClick(item)}
                        className={`group/item relative flex items-start gap-3.5 p-3 rounded-xl hover:bg-[var(--c-hover)] cursor-pointer transition-colors ${
                          showDivider
                            ? "after:content-[''] after:absolute after:bottom-0 after:left-3 after:right-3 after:h-px after:bg-[var(--c-divider)] hover:after:opacity-0"
                            : ""
                        }`}
                      >
                        <div className="min-w-0 flex-1 space-y-1.5">
                          <h3
                            className={`text-[14px] leading-[1.35] tracking-[-0.015em] line-clamp-2 ${
                              isRead
                                ? "text-[var(--c-muted)] font-normal"
                                : "text-[var(--c-fg)] font-semibold"
                            }`}
                          >
                            {item.title}
                          </h3>
                          {block.showExcerpts && item.summary && (
                            <p className="text-[12.5px] text-[var(--c-secondary)] line-clamp-2 leading-[1.48]">
                              {item.summary}
                            </p>
                          )}
                          <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--c-muted)] pt-0.5">
                            <span className="tabular-nums">{relativeTime(item.isoDate)}</span>
                            {item.author && <span className="truncate">· {item.author}</span>}
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                onToggleSave(item);
                              }}
                              title={isSaved ? "Saved" : "Save for later"}
                              className={`ml-auto p-0.5 rounded transition cursor-pointer ${
                                isSaved
                                  ? "text-[var(--c-fg)]"
                                  : "opacity-0 group-hover/item:opacity-100 hover:text-[var(--c-fg)]"
                              }`}
                            >
                              <Bookmark
                                className={`w-3.5 h-3.5 ${isSaved ? "fill-current" : ""}`}
                              />
                            </button>
                          </div>
                        </div>
                        {showThumb && (
                          <div className="w-[74px] h-[60px] rounded-xl overflow-hidden shrink-0 bg-black/20 mt-0.5">
                            <img
                              src={item.image}
                              alt=""
                              loading="lazy"
                              className="w-full h-full object-cover group-hover/item:scale-[1.04] transition-transform duration-300"
                            />
                          </div>
                        )}
                      </div>
                    );
                  }

                  // Headlines
                  return (
                    // biome-ignore lint/a11y/noStaticElementInteractions: whole row opens the reader; the save button inside stops propagation
                    // biome-ignore lint/a11y/useKeyWithClickEvents: rows are also reachable from the reader's J/K navigation
                    <div
                      key={item.id}
                      onClick={() => handleStoryClick(item)}
                      className={`group/item relative flex items-start gap-3.5 px-3 py-3 rounded-xl hover:bg-[var(--c-hover)] cursor-pointer transition-colors ${
                        showDivider
                          ? "after:content-[''] after:absolute after:bottom-0 after:left-3 after:right-3 after:h-px after:bg-[var(--c-divider)] hover:after:opacity-0"
                          : ""
                      }`}
                    >
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex items-baseline justify-between gap-3">
                          <h3
                            className={`text-[14px] leading-[1.36] tracking-[-0.015em] line-clamp-2 ${
                              isRead
                                ? "text-[var(--c-muted)] font-normal"
                                : "text-[var(--c-fg)] font-semibold"
                            }`}
                          >
                            {item.title}
                          </h3>
                          <span className="font-mono text-[10.5px] tabular-nums text-[var(--c-muted)] shrink-0">
                            {relativeTime(item.isoDate)}
                          </span>
                        </div>
                        {block.showExcerpts && item.summary && (
                          <p className="text-[12.5px] text-[var(--c-secondary)] line-clamp-2 leading-[1.48]">
                            {item.summary}
                          </p>
                        )}
                      </div>
                      {showThumb && (
                        <img
                          src={item.image}
                          alt=""
                          loading="lazy"
                          className="w-14 h-14 rounded-xl object-cover shrink-0 bg-black/20"
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Drag-to-Resize Corner Handle (visible in Grid Edit Mode on lg+ screens) */}
        {editGrid && (
          <button
            type="button"
            onPointerDown={handleResizePointerDown}
            onPointerMove={handleResizePointerMove}
            onPointerUp={handleResizePointerUp}
            onPointerCancel={handleResizePointerUp}
            title="Drag corner to resize block span"
            className="hidden lg:flex items-end justify-end absolute bottom-0 right-0 w-10 h-10 p-2.5 cursor-nwse-resize z-30 group/resize touch-none"
          >
            <span
              className={`block w-3.5 h-3.5 border-r-2 border-b-2 rounded-br-[4px] transition-colors ${
                resizing
                  ? "border-[#2446E3]"
                  : "border-[var(--c-fg)]/50 group-hover/resize:border-[var(--c-fg)]"
              }`}
            />
          </button>
        )}

        {/* Live Resize Ghost Pill */}
        {resizing && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/45 backdrop-blur-[2px] z-20">
            <div className="px-4 py-2 rounded-full bg-[#2446E3] text-white font-display text-lg tracking-tight shadow-2xl">
              {effColSpan} × {effRowSpan}
            </div>
          </div>
        )}
      </section>

      {/* Block Customization Panel — portaled to document.body so it escapes the card's
          rounded overflow-hidden, its grid-row span, and (in centered mode) the page scroll
          entirely. Fixed positioning keeps it attached to the viewport, not the card. */}
      {editing &&
        typeof document !== "undefined" &&
        createPortal(
          <>
            {placement && !placement.side && (
              // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-to-dismiss; Escape is handled by the pointer/keydown listener above
              // biome-ignore lint/a11y/useKeyWithClickEvents: same backdrop, keyboard dismissal is Escape
              <div
                ref={backdropRef}
                onClick={() => onEditingChange(false)}
                className="fixed inset-0 z-40 bg-black/75 backdrop-blur-[6px]"
              />
            )}
            <div
              ref={panelRef}
              role="dialog"
              aria-modal={placement?.side === false ? true : undefined}
              aria-label={`Customize ${block.title}`}
              // Surface vars re-applied here: the portal is outside the section that carries them.
              style={{
                ...surface.vars,
                boxShadow: "var(--popover-shadow)",
                top: placement?.top ?? 0,
                left: placement?.left ?? 0,
                visibility: placement ? "visible" : "hidden",
              }}
              // z-40: above the sticky header (z-30) so a clipped-at-top panel is still readable,
              // beneath the modals and reader (z-50).
              // ponytail: fixed 360px (or viewport-minus-margins) width; a custom-fit width would
              // need the panel to re-measure against its own content and can oscillate.
              className="fixed z-40 w-[min(360px,calc(100vw-32px))] max-h-[85vh] overflow-y-auto rounded-[22px] border border-[var(--c-border)] bg-[var(--c-panel)] px-5 py-5 sm:px-6 space-y-4 text-xs text-[var(--c-fg)]"
            >
              <div className="space-y-2.5">
                <label className="block space-y-1.5">
                  <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--c-muted)]">
                    Block Title
                  </span>
                  <input
                    type="text"
                    value={block.title}
                    onChange={(e) => onUpdate({ title: e.target.value })}
                    className="w-full px-3 py-2 rounded-xl bg-[var(--c-input)] border border-[var(--c-divider)] text-[var(--c-fg)] focus:outline-none focus:border-[var(--c-fg)]"
                  />
                </label>

                <form onSubmit={handleSaveUrl} className="space-y-1.5">
                  <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--c-muted)]">
                    Feed or Site URL
                  </span>
                  <div className="flex gap-1.5">
                    <input
                      type="text"
                      name="feed-url"
                      // Uncontrolled + keyed on block.url: the DOM owns the in-progress text (so
                      // typing never fights a reset), and a canonical URL discovered by loadFeed
                      // resets the field via the key. No draft state, no syncing effect.
                      key={block.url}
                      defaultValue={block.url}
                      className="flex-1 min-w-0 px-3 py-2 rounded-xl bg-[var(--c-input)] border border-[var(--c-divider)] text-[var(--c-fg)] font-mono text-[11px] focus:outline-none focus:border-[var(--c-fg)]"
                    />
                    <button
                      type="submit"
                      className="px-3.5 py-2 rounded-xl bg-[var(--c-pill-bg)] text-[var(--c-pill-fg)] font-mono text-[11px] uppercase tracking-[0.08em] font-semibold hover:opacity-90 transition cursor-pointer"
                    >
                      Apply
                    </button>
                  </div>
                </form>
              </div>

              {/* Grid Span Controls */}
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--c-muted)]">
                    Col Span
                  </span>
                  <div className="grid grid-flow-col auto-cols-fr gap-1 p-1 rounded-xl bg-[var(--c-input)] border border-[var(--c-divider)]">
                    {Array.from({ length: columns }, (_, i) => i + 1).map((n) => (
                      <button
                        key={n}
                        type="button"
                        onClick={() => onUpdate({ colSpan: n })}
                        className={`py-1 rounded-lg font-mono text-[10.5px] transition cursor-pointer ${
                          effColSpan === n
                            ? "bg-[var(--c-pill-bg)] text-[var(--c-pill-fg)] font-semibold"
                            : "text-[var(--c-muted)] hover:text-[var(--c-fg)]"
                        }`}
                      >
                        {n}C
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-1.5">
                  <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--c-muted)]">
                    Row Span
                  </span>
                  <div className="grid grid-cols-3 gap-1 p-1 rounded-xl bg-[var(--c-input)] border border-[var(--c-divider)]">
                    {[1, 2, 3].map((n) => (
                      <button
                        key={n}
                        type="button"
                        onClick={() => onUpdate({ rowSpan: n, collapsed: false })}
                        className={`py-1 rounded-lg font-mono text-[10.5px] transition cursor-pointer ${
                          effRowSpan === n
                            ? "bg-[var(--c-pill-bg)] text-[var(--c-pill-fg)] font-semibold"
                            : "text-[var(--c-muted)] hover:text-[var(--c-fg)]"
                        }`}
                      >
                        {n}R
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Block Surface Theme Picker */}
              <div className="space-y-1.5">
                <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--c-muted)]">
                  Surface
                </span>
                <div className="grid grid-cols-6 gap-2">
                  {(Object.keys(BLOCK_SURFACES) as BlockSurface[]).map((key) => {
                    const spec = BLOCK_SURFACES[key];
                    const selected = block.accent === key;
                    return (
                      <button
                        key={key}
                        type="button"
                        onClick={() => onUpdate({ accent: key })}
                        title={spec.label}
                        className={`h-7 rounded-lg border transition cursor-pointer ${spec.swatch} ${
                          selected
                            ? "ring-2 ring-[var(--c-fg)] ring-offset-2 ring-offset-[var(--c-panel)]"
                            : "opacity-75 hover:opacity-100"
                        }`}
                      />
                    );
                  })}
                </div>
              </div>

              {/* Layout Style */}
              <div className="space-y-1.5">
                <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--c-muted)]">
                  Layout
                </span>
                <div className="grid grid-cols-4 gap-1 p-1 rounded-xl bg-[var(--c-input)] border border-[var(--c-divider)]">
                  {VIEW_MODES.map((m) => (
                    <button
                      key={m.value}
                      type="button"
                      onClick={() =>
                        onUpdate({
                          viewMode: m.value,
                          showImages:
                            m.value === "cards" || m.value === "magazine" ? true : block.showImages,
                        })
                      }
                      className={`py-1.5 rounded-lg font-mono text-[10px] uppercase tracking-[0.06em] transition cursor-pointer ${
                        block.viewMode === m.value
                          ? "bg-[var(--c-pill-bg)] text-[var(--c-pill-fg)] font-semibold"
                          : "text-[var(--c-muted)] hover:text-[var(--c-fg)]"
                      }`}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <label className="space-y-1.5">
                  <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--c-muted)] flex justify-between">
                    <span>Limit</span>
                    <span className="text-[var(--c-fg)]">{block.limit}</span>
                  </span>
                  <input
                    type="range"
                    min={3}
                    max={25}
                    value={block.limit}
                    onChange={(e) => onUpdate({ limit: Number(e.target.value) })}
                    className="w-full accent-[var(--c-fg)] cursor-pointer"
                  />
                </label>

                <label className="space-y-1.5">
                  <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--c-muted)]">
                    Sync
                  </span>
                  <select
                    value={block.refreshMinutes}
                    onChange={(e) => onUpdate({ refreshMinutes: Number(e.target.value) })}
                    className="w-full px-2.5 py-1.5 rounded-lg bg-[var(--c-input)] border border-[var(--c-divider)] text-[var(--c-fg)] font-mono text-[11px]"
                  >
                    <option value={0}>Manual</option>
                    <option value={5}>5M</option>
                    <option value={15}>15M</option>
                    <option value={30}>30M</option>
                    <option value={60}>60M</option>
                  </select>
                </label>
              </div>

              <div className="flex items-center gap-5 pt-0.5">
                <Toggle
                  checked={block.showImages}
                  onChange={(v) => onUpdate({ showImages: v })}
                  label="Images"
                />
                <Toggle
                  checked={block.showExcerpts}
                  onChange={(v) => onUpdate({ showExcerpts: v })}
                  label="Excerpts"
                />
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-[var(--c-divider)]">
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    disabled={!canMovePrev}
                    onClick={() => onMoveOrder(-1)}
                    title="Move earlier"
                    className="p-1.5 rounded-lg bg-[var(--c-input)] border border-[var(--c-divider)] text-[var(--c-secondary)] hover:text-[var(--c-fg)] disabled:opacity-30 transition cursor-pointer"
                  >
                    <ArrowLeft className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    disabled={!canMoveNext}
                    onClick={() => onMoveOrder(1)}
                    title="Move later"
                    className="p-1.5 rounded-lg bg-[var(--c-input)] border border-[var(--c-divider)] text-[var(--c-secondary)] hover:text-[var(--c-fg)] disabled:opacity-30 transition cursor-pointer"
                  >
                    <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={onDuplicate}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-[var(--c-input)] border border-[var(--c-divider)] text-[var(--c-secondary)] hover:text-[var(--c-fg)] font-mono text-[10px] uppercase tracking-[0.08em] transition cursor-pointer"
                  >
                    <Copy className="w-3 h-3" />
                    <span>Copy</span>
                  </button>
                </div>

                <button
                  type="button"
                  onClick={onDelete}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[var(--c-fg)]/80 hover:text-[var(--c-fg)] hover:bg-[var(--c-hover)] font-mono text-[10px] uppercase tracking-[0.08em] transition cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Remove</span>
                </button>
              </div>
            </div>
          </>,
          document.body,
        )}
    </div>
  );
}
