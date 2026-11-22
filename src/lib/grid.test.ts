import assert from "node:assert/strict";
import test from "node:test";
import { clampSpan, computeResizedSpan, reorderById } from "./grid.ts";

test("clamps colSpan and rowSpan to grid limits", () => {
  assert.deepEqual(clampSpan(4, 5, 3), { colSpan: 3, rowSpan: 3 });
  assert.deepEqual(clampSpan(0, -1, 3), { colSpan: 1, rowSpan: 1 });
  assert.deepEqual(clampSpan(undefined, undefined, 4), { colSpan: 1, rowSpan: 1 });
});

test("computes snapped span from pointer deltas", () => {
  // 3 columns across 940px -> colTrack ~ 320px; rowTrack = 300px
  assert.deepEqual(
    computeResizedSpan({
      startColSpan: 1,
      startRowSpan: 1,
      deltaX: 310,
      deltaY: 290,
      gridWidth: 940,
      columns: 3,
    }),
    { colSpan: 2, rowSpan: 2 },
  );

  // Dragging far right clamps to max columns
  assert.deepEqual(
    computeResizedSpan({
      startColSpan: 2,
      startRowSpan: 2,
      deltaX: 900,
      deltaY: -310,
      gridWidth: 940,
      columns: 3,
    }),
    { colSpan: 3, rowSpan: 1 },
  );
});

test("reorders blocks cleanly by id", () => {
  const list = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
  assert.deepEqual(
    reorderById(list, "c", "a").map((x) => x.id),
    ["c", "a", "b", "d"],
  );
  assert.deepEqual(
    reorderById(list, "a", "d").map((x) => x.id),
    ["b", "c", "d", "a"],
  );
});
