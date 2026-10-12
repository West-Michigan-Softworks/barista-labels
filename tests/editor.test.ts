import { test } from "node:test";
import assert from "node:assert/strict";
import { demoProject, projectSchema } from "../shared/model.ts";
import {
  arrange,
  transition,
  undo,
  redo,
  moveSelection,
  elementBounds,
} from "../src/editor.ts";
test("history preserves undo and redo snapshots without mutation", () => {
  const p = demoProject();
  const h = { past: [], present: p, future: [] };
  const edited = transition(h, { ...p, name: "Edited" });
  assert.equal(undo(edited).present.name, p.name);
  assert.equal(redo(undo(edited)).present.name, "Edited");
  assert.equal(p.name, "Receiving label");
});
test("alignment and distribution respect locked objects", () => {
  const p = demoProject();
  const base = p.templates[0].elements[0];
  const a = { ...base, id: "a", xUm: 0, widthUm: 1000 },
    b = { ...base, id: "b", xUm: 4000, widthUm: 1000 },
    c = { ...base, id: "c", xUm: 10000, widthUm: 1000 },
    locked = { ...base, id: "locked", xUm: 50000, locked: true };
  const result = arrange(
    [a, b, c, locked],
    ["a", "b", "c", "locked"],
    "distribute-x",
    100000,
    50000,
  );
  assert.deepEqual(
    result.map((e) => e.xUm),
    [0, 5000, 10000, 50000],
  );
  const aligned = arrange(
    result,
    ["a", "b", "c", "locked"],
    "right",
    100000,
    50000,
  );
  assert.deepEqual(
    aligned.map((e) => e.xUm),
    [10000, 10000, 10000, 50000],
  );
});
test("integer geometry schema rejects NaN and malformed object content", () => {
  const p = demoProject();
  p.templates[0].elements[0].widthUm = NaN;
  assert.equal(projectSchema.safeParse(p).success, false);
});
test("nudge leaves locked selected objects stationary", () => {
  const p = demoProject();
  const e = p.templates[0].elements[0];
  const result = moveSelection([{ ...e, locked: true }], [e.id], 1000, 1000);
  assert.equal(result[0].xUm, e.xUm);
});

test("rotated alignment uses visible bounds and toolbar rotation keeps centre", () => {
  const e = {
    ...demoProject().templates[0].elements[0],
    xUm: 30000,
    yUm: 10000,
    widthUm: 20000,
    heightUm: 10000,
    rotation: 90,
  };
  const placed = arrange([e], [e.id], "label-x", 100000, 50000)[0];
  const bounds = elementBounds(placed);
  assert(Math.abs((bounds.left + bounds.right) / 2 - 50000) < 1);
  const rotated = arrange([e], [e.id], "rotate", 100000, 50000)[0];
  const original = elementBounds(e),
    next = elementBounds(rotated);
  assert(
    Math.abs(original.left + original.right - (next.left + next.right)) < 2,
  );
  assert(
    Math.abs(original.top + original.bottom - (next.top + next.bottom)) < 2,
  );
});
