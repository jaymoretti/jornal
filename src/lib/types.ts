import type { CSSProperties } from "react";

export type ViewMode = "compact" | "headlines" | "cards" | "magazine";

export type BlockSurface = "obsidian" | "cobalt" | "chalk" | "graphite" | "vermilion" | "forest";

export type ThemeMode = "dark" | "light" | "sepia";
export type ReaderFont = "sans" | "serif" | "mono";
export type ReaderSize = "sm" | "md" | "lg";
export type ReaderPanel = "left" | "right" | "center";

export interface FeedItem {
  id: string;
  title: string;
  link: string;
  isoDate?: string;
  author?: string;
  summary?: string;
  contentHtml?: string;
  image?: string;
  feedTitle?: string;
  feedUrl?: string;
}

export interface FeedResponse {
  title: string;
  description?: string;
  link?: string;
  favicon?: string;
  feedUrl: string;
  fetchedAt: string;
  items: FeedItem[];
}

export interface ArticleResponse {
  title: string;
  byline?: string;
  siteName?: string;
  excerpt?: string;
  contentHtml: string;
  leadImage?: string;
  readingTimeMinutes: number;
  url: string;
}

export interface FeedBlock {
  id: string;
  title: string;
  url: string;
  colSpan: number;
  rowSpan: number;
  limit: number;
  viewMode: ViewMode;
  accent: BlockSurface;
  showImages: boolean;
  showExcerpts: boolean;
  refreshMinutes: number;
  collapsed?: boolean;
}

export interface DashboardTab {
  id: string;
  name: string;
  columns: 1 | 2 | 3 | 4;
  blocks: FeedBlock[];
}

export interface DashboardState {
  version: 6;
  tabs: DashboardTab[];
  activeTabId: string;
  readIds: string[];
  savedItems: FeedItem[];
  theme: ThemeMode;
  readerFont: ReaderFont;
  readerSize: ReaderSize;
  readerPanel: ReaderPanel;
}

export interface BlockSurfaceSpec {
  label: string;
  swatch: string;
  vars: CSSProperties;
}

export const BLOCK_SURFACES: Record<BlockSurface, BlockSurfaceSpec> = {
  obsidian: {
    label: "Obsidian",
    swatch: "bg-[#121214] border-white/25",
    vars: {
      "--c-bg": "#111113",
      "--c-fg": "#ffffff",
      "--c-secondary": "#b2b2bc",
      "--c-muted": "#6e6e78",
      "--c-border": "rgba(255, 255, 255, 0.08)",
      "--c-divider": "rgba(255, 255, 255, 0.08)",
      "--c-hover": "rgba(255, 255, 255, 0.05)",
      "--c-panel": "#0b0b0d",
      "--c-input": "#17171b",
      "--c-pill-bg": "#ffffff",
      "--c-pill-fg": "#0b0b0d",
    } as CSSProperties,
  },
  cobalt: {
    label: "Cobalt",
    swatch: "bg-[#2446E3] border-white/30",
    vars: {
      "--c-bg": "#2446E3",
      "--c-fg": "#ffffff",
      "--c-secondary": "rgba(255, 255, 255, 0.86)",
      "--c-muted": "rgba(255, 255, 255, 0.62)",
      "--c-border": "rgba(255, 255, 255, 0.16)",
      "--c-divider": "rgba(255, 255, 255, 0.18)",
      "--c-hover": "rgba(255, 255, 255, 0.09)",
      "--c-panel": "#1c38bd",
      "--c-input": "#172fa1",
      "--c-pill-bg": "#ffffff",
      "--c-pill-fg": "#1833b3",
    } as CSSProperties,
  },
  chalk: {
    label: "Chalk",
    swatch: "bg-[#F3F3EE] border-black/25",
    vars: {
      "--c-bg": "#F3F3EE",
      "--c-fg": "#0d0d0f",
      "--c-secondary": "#3e3e45",
      "--c-muted": "#777780",
      "--c-border": "rgba(13, 13, 15, 0.1)",
      "--c-divider": "rgba(13, 13, 15, 0.1)",
      "--c-hover": "rgba(13, 13, 15, 0.045)",
      "--c-panel": "#e7e7e0",
      "--c-input": "#ffffff",
      "--c-pill-bg": "#0d0d0f",
      "--c-pill-fg": "#ffffff",
    } as CSSProperties,
  },
  graphite: {
    label: "Graphite",
    swatch: "bg-[#1D1D22] border-white/25",
    vars: {
      "--c-bg": "#1b1b20",
      "--c-fg": "#f7f7fa",
      "--c-secondary": "#b6b6c2",
      "--c-muted": "#7b7b88",
      "--c-border": "rgba(255, 255, 255, 0.1)",
      "--c-divider": "rgba(255, 255, 255, 0.09)",
      "--c-hover": "rgba(255, 255, 255, 0.055)",
      "--c-panel": "#131317",
      "--c-input": "#222229",
      "--c-pill-bg": "#ffffff",
      "--c-pill-fg": "#131317",
    } as CSSProperties,
  },
  vermilion: {
    label: "Vermilion",
    swatch: "bg-[#D93829] border-white/30",
    vars: {
      "--c-bg": "#D93829",
      "--c-fg": "#ffffff",
      "--c-secondary": "rgba(255, 255, 255, 0.86)",
      "--c-muted": "rgba(255, 255, 255, 0.64)",
      "--c-border": "rgba(255, 255, 255, 0.16)",
      "--c-divider": "rgba(255, 255, 255, 0.18)",
      "--c-hover": "rgba(255, 255, 255, 0.09)",
      "--c-panel": "#b82c1f",
      "--c-input": "#9e2418",
      "--c-pill-bg": "#ffffff",
      "--c-pill-fg": "#a62519",
    } as CSSProperties,
  },
  forest: {
    label: "Forest",
    swatch: "bg-[#113D2E] border-white/30",
    vars: {
      "--c-bg": "#113D2E",
      "--c-fg": "#f5faf7",
      "--c-secondary": "rgba(245, 250, 247, 0.82)",
      "--c-muted": "rgba(245, 250, 247, 0.56)",
      "--c-border": "rgba(255, 255, 255, 0.13)",
      "--c-divider": "rgba(255, 255, 255, 0.14)",
      "--c-hover": "rgba(255, 255, 255, 0.07)",
      "--c-panel": "#0b2c21",
      "--c-input": "#09241b",
      "--c-pill-bg": "#f5faf7",
      "--c-pill-fg": "#0b2c21",
    } as CSSProperties,
  },
};

export function resolveBlockSurface(key?: string): BlockSurfaceSpec {
  if (key && key in BLOCK_SURFACES) {
    return BLOCK_SURFACES[key as BlockSurface];
  }
  return BLOCK_SURFACES.obsidian;
}

export function createDefaultState(): DashboardState {
  return {
    version: 6,
    // A first-time visitor starts with a single empty page; nothing is pre-subscribed.
    activeTabId: "tab-today",
    readIds: [],
    savedItems: [],
    theme: "dark",
    readerFont: "sans",
    readerSize: "md",
    readerPanel: "right",
    tabs: [{ id: "tab-today", name: "Today", columns: 3, blocks: [] }],
  };
}
