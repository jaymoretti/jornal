import {
  Bookmark,
  BookOpen,
  Check,
  Download,
  LayoutGrid,
  Moon,
  MoreHorizontal,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Sun,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import type { CSSProperties } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GRID_ROW_PX, reorderById } from "@/lib/grid";
import { exportTabsToOpml, parseOpmlToTabs } from "@/lib/opml";
import {
  createDefaultState,
  type DashboardState,
  type DashboardTab,
  type FeedBlock,
  type FeedItem,
  type ThemeMode,
} from "@/lib/types";
import { AddBlockModal } from "./AddBlockModal";
import { FeedBlockCard } from "./FeedBlockCard";
import { ReaderDrawer } from "./ReaderDrawer";

const STORAGE_KEY = "jornal-dashboard-v1";
const MAX_READ_IDS = 1500;
const SAVED_TAB_ID = "__saved__";

// Stand-in for `activeTab` when every page has been deleted. It carries no blocks, so the main
// area falls through to the welcome panel, and every `activeTab.*` dereference stays safe.
const EMPTY_TAB: DashboardTab = { id: "", name: "", columns: 3, blocks: [] };

function normalizeTabs(tabs: DashboardTab[]): DashboardTab[] {
  return tabs.map((tab) => ({
    ...tab,
    columns: (tab.columns >= 1 && tab.columns <= 4 ? tab.columns : 3) as 1 | 2 | 3 | 4,
    blocks: tab.blocks.map((b) => ({
      ...b,
      colSpan: Math.max(1, Math.min(4, b.colSpan || 1)),
      rowSpan: Math.max(1, Math.min(3, b.rowSpan || 1)),
    })),
  }));
}

function loadStoredState(): DashboardState {
  if (typeof window === "undefined") return createDefaultState();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return createDefaultState();
    const parsed = JSON.parse(raw) as Partial<DashboardState>;
    // An empty array is a legitimate zero-page dashboard; only a missing/invalid one resets.
    if (!parsed.tabs || !Array.isArray(parsed.tabs)) {
      return createDefaultState();
    }
    const defaults = createDefaultState();
    const tabs = normalizeTabs(parsed.tabs);

    return {
      ...defaults,
      ...parsed,
      tabs,
      activeTabId: parsed.activeTabId || tabs[0]?.id || "",
      readIds: Array.isArray(parsed.readIds) ? parsed.readIds : [],
      savedItems: Array.isArray(parsed.savedItems) ? parsed.savedItems : [],
    };
  } catch {
    return createDefaultState();
  }
}

function downloadFile(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function BrandMark() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className="shrink-0 text-[var(--fg)]"
    >
      <path d="M5 7.5L19 2.5V6.5L5 11.5V7.5Z" fill="currentColor" />
      <path d="M5 13L19 8V12L5 17V13Z" fill="currentColor" />
      <path d="M5 18.5L14 15.3V19.3L5 22.5V18.5Z" fill="#2446E3" />
    </svg>
  );
}

export function Dashboard() {
  const [state, setState] = useState<DashboardState>(createDefaultState);
  const [hydrated, setHydrated] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [refreshSignal, setRefreshSignal] = useState(0);
  const [editGrid, setEditGrid] = useState(false);
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // Lifted so exactly one block's customize panel can be open, and tab switches dismiss it.
  const [editingBlockId, setEditingBlockId] = useState<string | null>(null);
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [draggingBlockId, setDraggingBlockId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const [readerState, setReaderState] = useState<{
    item: FeedItem;
    siblings: FeedItem[];
  } | null>(null);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    // Reads localStorage, which only exists in the browser. This is the standard SSR-safe
    // hydration path: server renders defaults, then we swap in the stored dashboard once.
    // The rule's cascading-render concern doesn't apply to a one-shot mount read.
    setState(loadStoredState());
    setHydrated(true);
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", state.theme);
    if (!hydrated) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // Ignore quota errors
    }
  }, [state, hydrated]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (readerState || addModalOpen) return;
      const target = e.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;

      if (e.key === "/") {
        e.preventDefault();
        searchInputRef.current?.focus();
      } else if (e.key === "e" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setEditGrid((v) => !v);
      } else if (e.key === "Escape" && menuOpen) {
        setMenuOpen(false);
      } else if (e.key === "Escape" && editGrid) {
        e.preventDefault();
        setEditGrid(false);
      } else if (e.key === "n" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setAddModalOpen(true);
      } else if (e.key === "r" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setRefreshSignal((s) => s + 1);
        showToast("Syncing feeds…");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [readerState, addModalOpen, editGrid, menuOpen, showToast]);

  const isSavedView = state.activeTabId === SAVED_TAB_ID;
  const activeTab: DashboardTab = useMemo(
    () => state.tabs.find((t) => t.id === state.activeTabId) ?? state.tabs[0] ?? EMPTY_TAB,
    [state.tabs, state.activeTabId],
  );

  const readSet = useMemo(() => new Set(state.readIds), [state.readIds]);
  const savedIds = useMemo(() => new Set(state.savedItems.map((i) => i.id)), [state.savedItems]);

  const getGridWidth = useCallback(
    () => gridRef.current?.getBoundingClientRect().width ?? 1200,
    [],
  );

  const updateActiveTab = useCallback((updater: (tab: DashboardTab) => DashboardTab) => {
    setState((prev) => ({
      ...prev,
      tabs: prev.tabs.map((t) => (t.id === prev.activeTabId ? updater(t) : t)),
    }));
  }, []);

  const handleAddBlock = useCallback(
    (block: FeedBlock) => {
      setState((prev) => {
        // With every page deleted, the first block also creates the page to hold it.
        const target = prev.tabs.find((t) => t.id === prev.activeTabId) ?? prev.tabs[0];
        if (!target) {
          const tab: DashboardTab = {
            id: `tab-${Date.now()}`,
            name: "Page 1",
            columns: 3,
            blocks: [block],
          };
          return { ...prev, tabs: [tab], activeTabId: tab.id };
        }
        return {
          ...prev,
          activeTabId: target.id,
          tabs: prev.tabs.map((t) =>
            t.id === target.id ? { ...t, blocks: [block, ...t.blocks] } : t,
          ),
        };
      });
      showToast(`Added ${block.title}`);
    },
    [showToast],
  );

  const handleUpdateBlock = useCallback(
    (blockId: string, patch: Partial<FeedBlock>) => {
      updateActiveTab((tab) => ({
        ...tab,
        blocks: tab.blocks.map((b) => (b.id === blockId ? { ...b, ...patch } : b)),
      }));
    },
    [updateActiveTab],
  );

  const handleDeleteBlock = useCallback(
    (blockId: string) => {
      setEditingBlockId(null);
      updateActiveTab((tab) => ({
        ...tab,
        blocks: tab.blocks.filter((b) => b.id !== blockId),
      }));
      showToast("Block removed");
    },
    [updateActiveTab, showToast],
  );

  const handleDuplicateBlock = useCallback(
    (block: FeedBlock) => {
      const copy: FeedBlock = {
        ...block,
        id: `blk-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        title: `${block.title} Copy`,
      };
      updateActiveTab((tab) => {
        const idx = tab.blocks.findIndex((b) => b.id === block.id);
        const next = [...tab.blocks];
        next.splice(idx + 1, 0, copy);
        return { ...tab, blocks: next };
      });
    },
    [updateActiveTab],
  );

  const handleMoveOrder = useCallback(
    (blockId: string, dir: -1 | 1) => {
      updateActiveTab((tab) => {
        const idx = tab.blocks.findIndex((b) => b.id === blockId);
        const targetIdx = idx + dir;
        if (idx === -1 || targetIdx < 0 || targetIdx >= tab.blocks.length) return tab;
        const next = [...tab.blocks];
        [next[idx], next[targetIdx]] = [next[targetIdx], next[idx]];
        return { ...tab, blocks: next };
      });
    },
    [updateActiveTab],
  );

  const handleDropOnBlock = useCallback(
    (targetBlockId: string) => {
      if (!draggingBlockId || draggingBlockId === targetBlockId) return;
      updateActiveTab((tab) => ({
        ...tab,
        blocks: reorderById(tab.blocks, draggingBlockId, targetBlockId),
      }));
      setDraggingBlockId(null);
    },
    [draggingBlockId, updateActiveTab],
  );

  const markRead = useCallback((ids: string[]) => {
    if (!ids.length) return;
    setState((prev) => {
      const merged = Array.from(new Set([...prev.readIds, ...ids]));
      return {
        ...prev,
        readIds: merged.slice(-MAX_READ_IDS),
      };
    });
  }, []);

  const handleOpenArticle = useCallback(
    (item: FeedItem, siblings: FeedItem[]) => {
      markRead([item.id]);
      setReaderState({ item, siblings });
    },
    [markRead],
  );

  const handleToggleSave = useCallback((item: FeedItem) => {
    setState((prev) => {
      const exists = prev.savedItems.some((i) => i.id === item.id);
      return {
        ...prev,
        savedItems: exists
          ? prev.savedItems.filter((i) => i.id !== item.id)
          : [item, ...prev.savedItems],
      };
    });
  }, []);

  const handleAddTab = () => {
    const newTab: DashboardTab = {
      id: `tab-${Date.now()}`,
      name: `Page ${state.tabs.length + 1}`,
      columns: 3,
      blocks: [],
    };
    setEditingBlockId(null);
    setState((prev) => ({
      ...prev,
      tabs: [...prev.tabs, newTab],
      activeTabId: newTab.id,
    }));
    setRenamingTabId(newTab.id);
    setRenameDraft(newTab.name);
  };

  // Switching pages also dismisses any open customize panel, so it never survives a tab switch.
  const selectTab = (tabId: string) => {
    setEditingBlockId(null);
    setState((prev) => ({ ...prev, activeTabId: tabId }));
  };

  const handleCommitRename = () => {
    if (!renamingTabId) return;
    const trimmed = renameDraft.trim();
    if (trimmed) {
      setState((prev) => ({
        ...prev,
        tabs: prev.tabs.map((t) => (t.id === renamingTabId ? { ...t, name: trimmed } : t)),
      }));
    }
    setRenamingTabId(null);
  };

  const handleDeleteTab = (tabId: string) => {
    setState((prev) => {
      const remaining = prev.tabs.filter((t) => t.id !== tabId);
      return {
        ...prev,
        tabs: remaining,
        // Deleting the last page leaves "" rather than a dangling id.
        activeTabId: prev.activeTabId === tabId ? (remaining[0]?.id ?? "") : prev.activeTabId,
      };
    });
  };

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      if (file.name.endsWith(".json") || text.trimStart().startsWith("{")) {
        const parsed = JSON.parse(text) as DashboardState;
        if (!parsed.tabs || !Array.isArray(parsed.tabs)) {
          throw new Error("Invalid jornal.cc JSON backup");
        }
        setState({ ...createDefaultState(), ...parsed, tabs: normalizeTabs(parsed.tabs) });
        showToast("Restored backup");
      } else {
        const importedTabs = parseOpmlToTabs(text);
        setState((prev) => ({
          ...prev,
          tabs: [...prev.tabs, ...importedTabs],
          activeTabId: importedTabs[0].id,
        }));
        showToast(`Imported ${importedTabs.length} page(s)`);
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to import file");
    }
  };

  const cycleTheme = () => {
    const next: ThemeMode =
      state.theme === "dark" ? "light" : state.theme === "light" ? "sepia" : "dark";
    setState((prev) => ({ ...prev, theme: next }));
  };

  const readerIdx = readerState
    ? readerState.siblings.findIndex((s) => s.id === readerState.item.id)
    : -1;
  const hasPrev = readerIdx > 0;
  const hasNext = Boolean(
    readerState && readerIdx >= 0 && readerIdx < readerState.siblings.length - 1,
  );

  const navigateReader = (delta: -1 | 1) => {
    if (!readerState) return;
    const nextItem = readerState.siblings[readerIdx + delta];
    if (!nextItem) return;
    markRead([nextItem.id]);
    setReaderState({ item: nextItem, siblings: readerState.siblings });
  };

  const filteredSaved = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return state.savedItems;
    return state.savedItems.filter(
      (i) =>
        i.title.toLowerCase().includes(q) ||
        (i.summary?.toLowerCase().includes(q) ?? false) ||
        (i.feedTitle?.toLowerCase().includes(q) ?? false),
    );
  }, [state.savedItems, searchQuery]);

  const gridStyle: CSSProperties = {
    ["--grid-cols" as string]: activeTab.columns,
    ["--grid-row-px" as string]: `${GRID_ROW_PX}px`,
  };

  return (
    <div className="min-h-screen flex flex-col bg-[var(--bg)] text-[var(--fg)]">
      {/* Bold Swiss Navigation Header */}
      <header className="sticky top-0 z-30 bg-[var(--bg)]/88 backdrop-blur-xl border-b border-[var(--border-subtle)]">
        {/* Wraps into two rows below sm (wordmark + actions, then the full-width tab strip);
            md+ stays the single row it always was. */}
        <div className="w-full px-4 sm:px-6 md:h-16 py-2 md:py-0 flex flex-wrap md:flex-nowrap items-center justify-between gap-x-4 gap-y-1.5 md:gap-y-0">
          {/* Brand */}
          <div className="order-1 flex items-center gap-2.5 shrink-0 select-none">
            <BrandMark />
            <span className="font-display text-[17px] lowercase tracking-[-0.02em] text-[var(--fg)]">
              jornal<span className="text-[var(--fg-muted)]">.cc</span>
            </span>
          </div>

          {/* Monospace Tabs — own row below md, inline at md+ */}
          <nav className="order-3 md:order-2 md:ml-6 w-full md:w-auto md:flex-1 min-w-0 flex items-center gap-1.5 overflow-x-auto overscroll-x-contain no-scrollbar py-1 pr-5 md:pr-0">
            {state.tabs.map((tab, i) => {
              const isActive = state.activeTabId === tab.id;
              const isRenaming = renamingTabId === tab.id;
              return (
                <div
                  key={tab.id}
                  className={`group/tab flex items-center rounded-full transition-colors shrink-0 ${
                    isActive
                      ? "bg-[var(--surface)] text-[var(--fg)] border border-[var(--border-strong)]"
                      : "text-[var(--fg-muted)] hover:text-[var(--fg)] border border-transparent"
                  }`}
                >
                  {isRenaming ? (
                    <input
                      value={renameDraft}
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onBlur={handleCommitRename}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleCommitRename();
                        if (e.key === "Escape") setRenamingTabId(null);
                      }}
                      // biome-ignore lint/a11y/noAutofocus: user just clicked to rename this tab
                      autoFocus
                      className="w-28 min-h-9 px-3.5 py-1.5 font-mono text-[11px] uppercase tracking-[0.1em] bg-transparent focus:outline-none text-[var(--fg)]"
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => selectTab(tab.id)}
                      onDoubleClick={() => {
                        setRenamingTabId(tab.id);
                        setRenameDraft(tab.name);
                      }}
                      title="Double-click to rename"
                      className="min-h-9 px-3.5 py-1.5 font-mono text-[11px] uppercase tracking-[0.12em] cursor-pointer flex items-center gap-1.5"
                    >
                      <span className="opacity-45">{String(i + 1).padStart(2, "0")}</span>
                      <span>{tab.name}</span>
                    </button>
                  )}

                  {isActive && !isRenaming && (
                    <button
                      type="button"
                      onClick={() => handleDeleteTab(tab.id)}
                      title="Delete page"
                      className="pr-2.5 -ml-1 text-[var(--fg-muted)] hover:text-[var(--fg)] opacity-0 group-hover/tab:opacity-100 transition cursor-pointer"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  )}
                </div>
              );
            })}

            <button
              type="button"
              onClick={handleAddTab}
              title="New page"
              className="min-h-9 min-w-9 inline-flex items-center justify-center rounded-full text-[var(--fg-muted)] hover:text-[var(--fg)] hover:bg-[var(--surface)] transition shrink-0 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>

            <button
              type="button"
              onClick={() => {
                setEditGrid(false);
                selectTab(SAVED_TAB_ID);
              }}
              className={`ml-1 min-h-9 inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full font-mono text-[11px] uppercase tracking-[0.12em] transition shrink-0 cursor-pointer ${
                isSavedView
                  ? "bg-[#2446E3] text-white"
                  : "text-[var(--fg-muted)] hover:text-[var(--fg)] border border-transparent"
              }`}
            >
              <Bookmark className="w-3 h-3" />
              <span>Saved</span>
              {state.savedItems.length > 0 && (
                <span className="opacity-75">
                  {String(state.savedItems.length).padStart(2, "0")}
                </span>
              )}
            </button>
          </nav>

          {/* Right Controls — order-2 on mobile so Add Block + More sit on row 1 */}
          <div className="order-2 md:order-3 flex items-center gap-1.5 shrink-0">
            <div className="relative hidden md:block">
              <Search className="w-3.5 h-3.5 text-[var(--fg-muted)] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="SEARCH"
                className="w-36 lg:w-48 pl-9 pr-8 py-1.5 font-mono text-[11px] tracking-[0.08em] rounded-full bg-[var(--surface)] border border-[var(--border)] text-[var(--fg)] placeholder:text-[var(--fg-muted)] focus:outline-none focus:border-[#2446E3] transition"
              />
              {searchQuery ? (
                <button
                  type="button"
                  onClick={() => setSearchQuery("")}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--fg-muted)] hover:text-[var(--fg)] cursor-pointer"
                >
                  <X className="w-3 h-3" />
                </button>
              ) : (
                <kbd className="absolute right-3.5 top-1/2 -translate-y-1/2 text-[10px] font-mono text-[var(--fg-muted)] pointer-events-none">
                  /
                </kbd>
              )}
            </div>

            {/* Grid Editor Toggle */}
            {!isSavedView && (
              <button
                type="button"
                onClick={() => setEditGrid((v) => !v)}
                title="Toggle Grid Editor (E)"
                className={`hidden sm:inline-flex items-center gap-1.5 px-3.5 py-2 rounded-full font-mono text-[11px] uppercase tracking-[0.1em] transition cursor-pointer ${
                  editGrid
                    ? "bg-[var(--fg)] text-[var(--bg)] font-semibold"
                    : "bg-[var(--surface)] border border-[var(--border)] text-[var(--fg-secondary)] hover:text-[var(--fg)] hover:border-[var(--border-strong)]"
                }`}
              >
                {editGrid ? (
                  <>
                    <Check className="w-3.5 h-3.5" />
                    <span>Done</span>
                  </>
                ) : (
                  <>
                    <LayoutGrid className="w-3.5 h-3.5" />
                    <span className="hidden sm:inline">Grid</span>
                  </>
                )}
              </button>
            )}

            {!isSavedView && (
              <button
                type="button"
                onClick={() => {
                  setRefreshSignal((s) => s + 1);
                  showToast("Syncing feeds…");
                }}
                title="Refresh all (R)"
                className="hidden sm:block p-2 rounded-full text-[var(--fg-muted)] hover:text-[var(--fg)] hover:bg-[var(--surface)] transition cursor-pointer"
              >
                <RefreshCw className="w-4 h-4" />
              </button>
            )}

            <button
              type="button"
              onClick={cycleTheme}
              title={`Canvas: ${state.theme}`}
              className="hidden sm:block p-2 rounded-full text-[var(--fg-muted)] hover:text-[var(--fg)] hover:bg-[var(--surface)] transition cursor-pointer"
            >
              {state.theme === "dark" ? (
                <Moon className="w-4 h-4" />
              ) : state.theme === "light" ? (
                <Sun className="w-4 h-4" />
              ) : (
                <BookOpen className="w-4 h-4" />
              )}
            </button>

            <div className="relative">
              <button
                type="button"
                onClick={() => setMenuOpen((v) => !v)}
                title="More"
                aria-expanded={menuOpen}
                className="p-2 rounded-full text-[var(--fg-muted)] hover:text-[var(--fg)] hover:bg-[var(--surface)] transition cursor-pointer"
              >
                <MoreHorizontal className="w-4 h-4" />
              </button>

              {menuOpen && (
                <>
                  {/* `inset-0` is wrong here: the header's backdrop-blur makes it a containing block for
                      fixed descendants, so this only covered the header (100px) and taps on the page
                      never reached it. Explicit viewport height covers the screen. ponytail: depends on
                      the header being sticky top-0 (its origin is the viewport origin); switch back to
                      `inset-0` if the menu is ever moved out of the blurred header. */}
                  {/* biome-ignore lint/a11y/noStaticElementInteractions: transparent click-catcher that closes the menu */}
                  {/* biome-ignore lint/a11y/useKeyWithClickEvents: Escape closes the menu via the global keydown handler */}
                  <div
                    className="fixed inset-x-0 top-0 h-dvh z-40"
                    onClick={() => setMenuOpen(false)}
                  />
                  <div
                    style={{ boxShadow: "var(--popover-shadow)" }}
                    className="absolute right-0 mt-2 w-56 rounded-2xl bg-[var(--surface-elevated)] border border-[var(--border)] p-1.5 z-50 font-mono text-[11px] uppercase tracking-[0.06em]"
                  >
                    {/* Below md the grid/refresh/theme controls live here instead of the header row */}
                    {!isSavedView && (
                      <button
                        type="button"
                        onClick={() => {
                          setMenuOpen(false);
                          setEditGrid((v) => !v);
                        }}
                        className="md:hidden w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-left text-[var(--fg-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--fg)] transition cursor-pointer"
                      >
                        <LayoutGrid className="w-3.5 h-3.5" />
                        {editGrid ? "Exit Grid Editor" : "Grid Editor"}
                      </button>
                    )}
                    {!isSavedView && (
                      <button
                        type="button"
                        onClick={() => {
                          setMenuOpen(false);
                          setRefreshSignal((s) => s + 1);
                          showToast("Syncing feeds…");
                        }}
                        className="md:hidden w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-left text-[var(--fg-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--fg)] transition cursor-pointer"
                      >
                        <RefreshCw className="w-3.5 h-3.5" />
                        Refresh Feeds
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        setMenuOpen(false);
                        cycleTheme();
                      }}
                      className="md:hidden w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-left text-[var(--fg-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--fg)] transition cursor-pointer"
                    >
                      {state.theme === "dark" ? (
                        <Moon className="w-3.5 h-3.5" />
                      ) : state.theme === "light" ? (
                        <Sun className="w-3.5 h-3.5" />
                      ) : (
                        <BookOpen className="w-3.5 h-3.5" />
                      )}
                      Theme · {state.theme}
                    </button>
                    <div className="md:hidden my-1 border-t border-[var(--border)]" />
                    <button
                      type="button"
                      onClick={() => {
                        setMenuOpen(false);
                        fileInputRef.current?.click();
                      }}
                      className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-left text-[var(--fg-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--fg)] transition cursor-pointer"
                    >
                      <Upload className="w-3.5 h-3.5" />
                      Import OPML / JSON
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setMenuOpen(false);
                        downloadFile(
                          "jornal-feeds.opml",
                          exportTabsToOpml(state.tabs),
                          "text/xml;charset=utf-8",
                        );
                        showToast("Exported OPML");
                      }}
                      className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-left text-[var(--fg-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--fg)] transition cursor-pointer"
                    >
                      <Download className="w-3.5 h-3.5" />
                      Export OPML
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setMenuOpen(false);
                        downloadFile(
                          "jornal-backup.json",
                          JSON.stringify(state, null, 2),
                          "application/json",
                        );
                        showToast("Exported backup");
                      }}
                      className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-left text-[var(--fg-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--fg)] transition cursor-pointer"
                    >
                      <Download className="w-3.5 h-3.5" />
                      Export Backup
                    </button>
                    <div className="my-1 border-t border-[var(--border)]" />
                    <button
                      type="button"
                      onClick={() => {
                        setMenuOpen(false);
                        setState((prev) => ({ ...prev, readIds: [] }));
                        showToast("Marked all unread");
                      }}
                      className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-left text-[var(--fg-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--fg)] transition cursor-pointer"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      Reset Read State
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setMenuOpen(false);
                        if (window.confirm("Reset all pages and blocks to defaults?")) {
                          setState(createDefaultState());
                          setEditGrid(false);
                          showToast("Reset to default layout");
                        }
                      }}
                      className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-left text-[#D93829] hover:bg-[#D93829]/10 transition cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      Reset Layout
                    </button>
                  </div>
                </>
              )}
            </div>

            <button
              type="button"
              onClick={() => setAddModalOpen(true)}
              className="ml-1 inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-[#2446E3] text-white hover:bg-[#2f54f5] font-mono text-[11px] uppercase tracking-[0.1em] font-semibold transition cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5 stroke-[2.5]" />
              <span className="hidden sm:inline">Add Block</span>
            </button>
          </div>
        </div>

        {/* Dedicated Grid Editor Control Bar */}
        {editGrid && !isSavedView && (
          <div className="border-t border-[var(--border)] bg-[var(--surface)]/95">
            <div className="w-full px-4 sm:px-6 py-2.5 flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-3">
                <span className="px-2.5 py-1 rounded-md bg-[#2446E3] text-white font-mono text-[10px] uppercase tracking-[0.14em] font-semibold">
                  Grid Editor
                </span>
                <span className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-[var(--fg-muted)] hidden md:inline">
                  Drag cards to reorder · Drag bottom-right corner or click span pills to resize
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-1.5">
                  <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--fg-muted)]">
                    Tracks
                  </span>
                  <div className="flex items-center rounded-full bg-[var(--bg)] border border-[var(--border)] p-0.5">
                    {([1, 2, 3, 4] as const).map((cols) => (
                      <button
                        key={cols}
                        type="button"
                        onClick={() => updateActiveTab((t) => ({ ...t, columns: cols }))}
                        className={`min-h-8 px-2.5 py-1 rounded-full font-mono text-[10.5px] transition cursor-pointer ${
                          activeTab.columns === cols
                            ? "bg-[#2446E3] text-white font-semibold"
                            : "text-[var(--fg-muted)] hover:text-[var(--fg)]"
                        }`}
                      >
                        {cols}C
                      </button>
                    ))}
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => {
                    updateActiveTab((t) => ({
                      ...t,
                      blocks: t.blocks.map((b) => ({
                        ...b,
                        colSpan: 1,
                        rowSpan: 1,
                        collapsed: false,
                      })),
                    }));
                    showToast("Reset all blocks to 1×1");
                  }}
                  className="px-3 py-1.5 rounded-full bg-[var(--bg)] border border-[var(--border)] hover:border-[var(--border-strong)] font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--fg-secondary)] hover:text-[var(--fg)] transition cursor-pointer"
                >
                  Uniform 1×1
                </button>
              </div>
            </div>
          </div>
        )}
      </header>

      <input
        ref={fileInputRef}
        type="file"
        accept=".opml,.xml,.json"
        onChange={handleImportFile}
        className="hidden"
      />

      {/* Main Bento Grid Canvas */}
      <main
        className={`flex-1 w-full transition-colors ${
          editGrid && !isSavedView ? "bento-edit-canvas" : ""
        }`}
      >
        <div className="w-full px-4 sm:px-6 py-6">
          {isSavedView ? (
            <div className="max-w-2xl mx-auto space-y-6">
              <div className="flex items-end justify-between">
                <div>
                  <p className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-[var(--fg-muted)]">
                    Reading List
                  </p>
                  <h1 className="font-display text-3xl uppercase tracking-[-0.02em] mt-1">Saved</h1>
                </div>
                {state.savedItems.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setState((prev) => ({ ...prev, savedItems: [] }))}
                    className="font-mono text-[11px] uppercase tracking-[0.1em] text-[var(--fg-muted)] hover:text-[var(--fg)] transition cursor-pointer"
                  >
                    Clear All
                  </button>
                )}
              </div>

              {filteredSaved.length === 0 ? (
                <div className="rounded-[22px] bg-[var(--surface)] border border-[var(--border)] p-14 text-center space-y-2">
                  <Bookmark className="w-5 h-5 text-[var(--fg-muted)] mx-auto" />
                  <p className="font-display text-sm uppercase">No Saved Stories</p>
                  <p className="text-xs text-[var(--fg-muted)]">
                    Bookmark any story to read it later without distractions.
                  </p>
                </div>
              ) : (
                <div className="rounded-[22px] bg-[var(--surface)] border border-[var(--border)] p-2 divide-y divide-[var(--border-subtle)]">
                  {filteredSaved.map((item) => (
                    // biome-ignore lint/a11y/noStaticElementInteractions: whole card is the click target by design; inner buttons stay clickable
                    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard users reach the same article through the feed block lists
                    <div
                      key={item.id}
                      onClick={() => handleOpenArticle(item, filteredSaved)}
                      className="group flex items-start justify-between gap-4 p-4 rounded-2xl hover:bg-[var(--surface-hover)] cursor-pointer transition"
                    >
                      <div className="space-y-1 min-w-0 flex-1">
                        <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--fg-muted)]">
                          {item.feedTitle || "Saved"}
                          {item.author ? ` · ${item.author}` : ""}
                        </div>
                        <h3 className="text-[15px] font-semibold text-[var(--fg)]">{item.title}</h3>
                        {item.summary && (
                          <p className="text-xs text-[var(--fg-secondary)] line-clamp-2 leading-relaxed">
                            {item.summary}
                          </p>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleToggleSave(item);
                        }}
                        title="Remove"
                        className="p-2 rounded-full text-[var(--fg-muted)] hover:text-[var(--fg)] hover:bg-[var(--bg)] transition cursor-pointer shrink-0"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : activeTab.blocks.length === 0 ? (
            <div className="max-w-md mx-auto mt-20 rounded-[24px] bg-[#2446E3] text-white p-10 space-y-5">
              <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-white/70">
                Welcome
              </p>
              <h2 className="font-display text-3xl uppercase leading-[1.02] tracking-[-0.02em]">
                Build Your Signal.
              </h2>
              <p className="text-sm text-white/80 leading-relaxed">
                This page is a blank grid. Add any RSS, Atom, or website URL and jornal.cc finds the
                feed for you — then size and style each block to taste.
              </p>
              <button
                type="button"
                onClick={() => setAddModalOpen(true)}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-white text-[#1833b3] font-mono text-xs uppercase tracking-[0.1em] font-semibold hover:opacity-90 transition cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                Add First Block
              </button>
            </div>
          ) : (
            <div ref={gridRef} style={gridStyle} className="bento-grid">
              {activeTab.blocks.map((block, idx) => (
                <FeedBlockCard
                  key={block.id}
                  block={block}
                  columns={activeTab.columns}
                  editGrid={editGrid}
                  editing={editingBlockId === block.id}
                  onEditingChange={(next) => setEditingBlockId(next ? block.id : null)}
                  getGridWidth={getGridWidth}
                  refreshSignal={refreshSignal}
                  searchQuery={searchQuery}
                  readSet={readSet}
                  savedIds={savedIds}
                  canMovePrev={idx > 0}
                  canMoveNext={idx < activeTab.blocks.length - 1}
                  onUpdate={(patch) => handleUpdateBlock(block.id, patch)}
                  onDelete={() => handleDeleteBlock(block.id)}
                  onDuplicate={() => handleDuplicateBlock(block)}
                  onMoveOrder={(dir) => handleMoveOrder(block.id, dir)}
                  onOpenArticle={handleOpenArticle}
                  onMarkManyRead={markRead}
                  onToggleSave={handleToggleSave}
                  onDragStartBlock={setDraggingBlockId}
                  onDragEndBlock={() => setDraggingBlockId(null)}
                  onDropOnBlock={handleDropOnBlock}
                  isDragging={draggingBlockId === block.id}
                />
              ))}
            </div>
          )}
        </div>
      </main>

      {/* Ad-Free Reader Drawer — keyed per story so each open starts from a clean state */}
      <ReaderDrawer
        key={readerState?.item.id ?? "closed"}
        item={readerState?.item ?? null}
        onClose={() => setReaderState(null)}
        onPrev={() => navigateReader(-1)}
        onNext={() => navigateReader(1)}
        hasPrev={hasPrev}
        hasNext={hasNext}
        isSaved={readerState ? savedIds.has(readerState.item.id) : false}
        onToggleSave={handleToggleSave}
        theme={state.theme}
        onThemeChange={(theme) => setState((prev) => ({ ...prev, theme }))}
        readerFont={state.readerFont}
        onReaderFontChange={(readerFont) => setState((prev) => ({ ...prev, readerFont }))}
        readerSize={state.readerSize}
        onReaderSizeChange={(readerSize) => setState((prev) => ({ ...prev, readerSize }))}
        panel={state.readerPanel}
        onPanelChange={(readerPanel) => setState((prev) => ({ ...prev, readerPanel }))}
      />

      {/* Add Block Modal */}
      <AddBlockModal
        open={addModalOpen}
        columns={activeTab.columns}
        onClose={() => setAddModalOpen(false)}
        onAdd={handleAddBlock}
      />

      {toast && (
        <div
          style={{ boxShadow: "var(--popover-shadow)" }}
          className="fixed bottom-6 right-6 z-50 px-4 py-2.5 rounded-full bg-[#2446E3] text-white font-mono text-[11px] uppercase tracking-[0.1em]"
        >
          {toast}
        </div>
      )}
    </div>
  );
}
