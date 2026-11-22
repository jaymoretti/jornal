import type { BlockSurface, DashboardTab, FeedBlock } from "./types";

const SURFACES: BlockSurface[] = [
  "obsidian",
  "cobalt",
  "obsidian",
  "chalk",
  "graphite",
  "obsidian",
];

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function exportTabsToOpml(tabs: DashboardTab[]): string {
  const outlines = tabs
    .map((tab) => {
      const children = tab.blocks
        .map(
          (b) =>
            `      <outline type="rss" text="${escapeXml(b.title)}" title="${escapeXml(b.title)}" xmlUrl="${escapeXml(b.url)}" />`,
        )
        .join("\n");
      return `    <outline text="${escapeXml(tab.name)}" title="${escapeXml(tab.name)}">\n${children}\n    </outline>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>jornal.cc Subscriptions</title>
    <dateCreated>${new Date().toUTCString()}</dateCreated>
  </head>
  <body>
${outlines}
  </body>
</opml>`;
}

export function parseOpmlToTabs(xmlText: string): DashboardTab[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, "text/xml");
  const body = doc.querySelector("body");
  if (!body) {
    throw new Error("Invalid OPML file: missing <body>");
  }

  const tabs: DashboardTab[] = [];
  const rootBlocks: FeedBlock[] = [];
  let idx = 0;

  const makeBlock = (el: Element): FeedBlock | null => {
    const xmlUrl = el.getAttribute("xmlUrl") || el.getAttribute("xmlurl");
    if (!xmlUrl) return null;
    const title = el.getAttribute("title") || el.getAttribute("text") || xmlUrl;
    return {
      id: `blk-opml-${Date.now()}-${idx++}`,
      title,
      url: xmlUrl,
      colSpan: 1,
      rowSpan: 2,
      limit: 8,
      viewMode: "headlines",
      accent: SURFACES[idx % SURFACES.length],
      showImages: false,
      showExcerpts: true,
      refreshMinutes: 30,
    };
  };

  for (const child of Array.from(body.children)) {
    if (child.tagName.toLowerCase() !== "outline") continue;
    const xmlUrl = child.getAttribute("xmlUrl") || child.getAttribute("xmlurl");
    if (xmlUrl) {
      const block = makeBlock(child);
      if (block) rootBlocks.push(block);
    } else {
      const folderName = child.getAttribute("title") || child.getAttribute("text") || "Imported";
      const feedEls = Array.from(child.querySelectorAll("outline[xmlUrl], outline[xmlurl]"));
      const blocks: FeedBlock[] = [];
      feedEls.forEach((el) => {
        const block = makeBlock(el);
        if (block) blocks.push(block);
      });
      if (blocks.length > 0) {
        tabs.push({
          id: `tab-opml-${Date.now()}-${tabs.length}`,
          name: folderName,
          columns: 3,
          blocks,
        });
      }
    }
  }

  if (rootBlocks.length > 0) {
    tabs.unshift({
      id: `tab-opml-root-${Date.now()}`,
      name: "Imported",
      columns: 3,
      blocks: rootBlocks,
    });
  }

  if (tabs.length === 0) {
    throw new Error("No RSS/Atom feeds found in OPML file");
  }

  return tabs;
}
