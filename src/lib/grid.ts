export const GRID_ROW_PX = 280;
export const GRID_GAP_PX = 20;
export const MAX_ROW_SPAN = 3;

export function clampSpan(
  colSpan: number | undefined,
  rowSpan: number | undefined,
  maxCols: number,
): { colSpan: number; rowSpan: number } {
  const safeCols = Math.max(1, Math.floor(maxCols));
  const c = Math.min(safeCols, Math.max(1, Math.round(colSpan ?? 1)));
  const r = Math.min(MAX_ROW_SPAN, Math.max(1, Math.round(rowSpan ?? 1)));
  return { colSpan: c, rowSpan: r };
}

export function computeResizedSpan(params: {
  startColSpan: number;
  startRowSpan: number;
  deltaX: number;
  deltaY: number;
  gridWidth: number;
  columns: number;
}): { colSpan: number; rowSpan: number } {
  const { startColSpan, startRowSpan, deltaX, deltaY, gridWidth, columns } = params;
  const colTrack = Math.max(120, (gridWidth - GRID_GAP_PX * (columns - 1)) / columns + GRID_GAP_PX);
  const rowTrack = GRID_ROW_PX + GRID_GAP_PX;

  const colDelta = Math.round(deltaX / colTrack);
  const rowDelta = Math.round(deltaY / rowTrack);

  return clampSpan(startColSpan + colDelta, startRowSpan + rowDelta, columns);
}

export function reorderById<T extends { id: string }>(
  items: T[],
  draggedId: string,
  targetId: string,
): T[] {
  if (draggedId === targetId) return items;
  const fromIdx = items.findIndex((i) => i.id === draggedId);
  const toIdx = items.findIndex((i) => i.id === targetId);
  if (fromIdx === -1 || toIdx === -1) return items;
  const next = [...items];
  const [moved] = next.splice(fromIdx, 1);
  next.splice(toIdx, 0, moved);
  return next;
}
