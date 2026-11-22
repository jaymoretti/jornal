import { Loader2, Plus, X } from "lucide-react";
import { useState } from "react";
import {
  BLOCK_SURFACES,
  type BlockSurface,
  type FeedBlock,
  type FeedResponse,
  type ViewMode,
} from "@/lib/types";

interface AddBlockModalProps {
  open: boolean;
  columns: number;
  onClose: () => void;
  onAdd: (block: FeedBlock) => void;
}

const VIEW_MODES: { value: ViewMode; label: string }[] = [
  { value: "compact", label: "Compact" },
  { value: "headlines", label: "Headlines" },
  { value: "cards", label: "Cards" },
  { value: "magazine", label: "Magazine" },
];

export function AddBlockModal({ open, columns, onClose, onAdd }: AddBlockModalProps) {
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [colSpan, setColSpan] = useState(1);
  const [rowSpan, setRowSpan] = useState(1);
  const [viewMode, setViewMode] = useState<ViewMode>("headlines");
  const [surface, setSurface] = useState<BlockSurface>("obsidian");
  const [validating, setValidating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = url.trim();
    if (!trimmed) return;

    setValidating(true);
    setError(null);

    try {
      const res = await fetch(`/api/feed?url=${encodeURIComponent(trimmed)}`);
      const data = (await res.json()) as FeedResponse & { error?: string };
      if (!res.ok) {
        throw new Error(data.error || "Could not load feed");
      }

      const newBlock: FeedBlock = {
        id: `blk-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        title: title.trim() || data.title || trimmed,
        url: data.feedUrl || trimmed,
        colSpan: Math.min(colSpan, Math.max(1, columns)),
        rowSpan,
        limit: viewMode === "compact" ? 10 : viewMode === "cards" ? 5 : 7,
        viewMode,
        accent: surface,
        showImages: viewMode === "cards" || viewMode === "magazine",
        showExcerpts: viewMode !== "compact",
        refreshMinutes: 30,
      };

      onAdd(newBlock);
      setUrl("");
      setTitle("");
      setError(null);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add feed");
    } finally {
      setValidating(false);
    }
  };

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click-to-dismiss; Escape is handled by the global keydown listener
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-[6px]"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Add feed block"
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: stops backdrop dismissal from firing inside the panel */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: click containment only, not an interaction */}
      <div
        style={{ boxShadow: "var(--popover-shadow)" }}
        className="w-full max-w-xl rounded-[24px] bg-[var(--surface)] border border-[var(--border)] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-5 border-b border-[var(--border)]">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--fg-muted)]">
              New Source
            </p>
            <h2 className="font-display text-lg uppercase tracking-[-0.02em] text-[var(--fg)] mt-0.5">
              Add Feed Block
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-full text-[var(--fg-muted)] hover:text-[var(--fg)] hover:bg-[var(--surface-hover)] transition cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div className="space-y-1.5">
            {/* biome-ignore lint/a11y/noLabelWithoutControl: the input below is a sibling, wired for layout not htmlFor */}
            <label className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--fg-muted)]">
              RSS, Atom, or Website URL
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com or example.com/feed.xml"
                // biome-ignore lint/a11y/noAutofocus: the modal exists only to take this URL
                autoFocus
                className="flex-1 px-4 py-2.5 text-sm rounded-xl bg-[var(--bg)] border border-[var(--border)] focus:border-[#2446E3] text-[var(--fg)] placeholder:text-[var(--fg-muted)] focus:outline-none transition"
              />
              <button
                type="submit"
                disabled={validating || !url.trim()}
                className="inline-flex items-center gap-1.5 px-5 py-2.5 font-mono text-xs uppercase tracking-[0.1em] font-semibold rounded-xl bg-[#2446E3] text-white hover:bg-[#2f54f5] disabled:opacity-40 transition cursor-pointer"
              >
                {validating ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Plus className="w-4 h-4" />
                )}
                Add
              </button>
            </div>
            <p className="text-[11.5px] text-[var(--fg-muted)]">
              Paste any site URL — jornal.cc automatically discovers RSS and Atom feeds.
            </p>
            {error && <p className="text-xs text-[#D93829] pt-0.5">{error}</p>}
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-1">
            <label className="space-y-1.5">
              <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--fg-muted)]">
                Title
              </span>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Auto"
                className="w-full px-3 py-2 text-xs rounded-xl bg-[var(--bg)] border border-[var(--border)] focus:border-[#2446E3] text-[var(--fg)] placeholder:text-[var(--fg-muted)] focus:outline-none"
              />
            </label>

            <label className="space-y-1.5">
              <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--fg-muted)]">
                Layout
              </span>
              <select
                value={viewMode}
                onChange={(e) => setViewMode(e.target.value as ViewMode)}
                className="w-full px-3 py-2 text-xs rounded-xl bg-[var(--bg)] border border-[var(--border)] text-[var(--fg)] font-mono uppercase focus:outline-none"
              >
                {VIEW_MODES.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="space-y-1.5">
              <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--fg-muted)]">
                Width
              </span>
              <select
                value={Math.min(colSpan, columns)}
                onChange={(e) => setColSpan(Number(e.target.value))}
                className="w-full px-3 py-2 text-xs rounded-xl bg-[var(--bg)] border border-[var(--border)] text-[var(--fg)] font-mono uppercase focus:outline-none"
              >
                {Array.from({ length: columns }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {n} Col{n > 1 ? "s" : ""}
                  </option>
                ))}
              </select>
            </label>

            <label className="space-y-1.5">
              <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--fg-muted)]">
                Height
              </span>
              <select
                value={rowSpan}
                onChange={(e) => setRowSpan(Number(e.target.value))}
                className="w-full px-3 py-2 text-xs rounded-xl bg-[var(--bg)] border border-[var(--border)] text-[var(--fg)] font-mono uppercase focus:outline-none"
              >
                {[1, 2, 3].map((n) => (
                  <option key={n} value={n}>
                    {n} Row{n > 1 ? "s" : ""}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="space-y-1.5">
            <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--fg-muted)]">
              Card Surface
            </span>
            <div className="grid grid-cols-6 gap-2">
              {(Object.keys(BLOCK_SURFACES) as BlockSurface[]).map((key) => {
                const spec = BLOCK_SURFACES[key];
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setSurface(key)}
                    title={spec.label}
                    className={`h-8 rounded-lg border transition cursor-pointer ${spec.swatch} ${
                      surface === key
                        ? "ring-2 ring-[var(--fg)] ring-offset-2 ring-offset-[var(--surface)]"
                        : "opacity-70 hover:opacity-100"
                    }`}
                  />
                );
              })}
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
