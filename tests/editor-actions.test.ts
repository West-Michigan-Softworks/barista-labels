import { test } from "node:test";
import assert from "node:assert/strict";
import { demoProject } from "../shared/model.ts";
import { actionUnavailable, type ActionState } from "../src/editor-actions.ts";

const empty: ActionState = { picked: [], clipboardCount: 0, past: 0, future: 0, zoom: 1, revision: 0, dirty: true, busy: false };
test("all arrangement entry points require meaningful editable selection", () => {
  for (const name of ["Align left", "Align right", "Align top", "Align bottom", "Horizontal centres", "Vertical centres", "Centre horizontal", "Centre vertical", "Group"])
    assert.match(actionUnavailable(name, empty)!, /two unlocked/);
  const e = demoProject().templates[0].elements[0];
  const pair = { ...empty, picked: [e, { ...e, id: "second" }] };
  assert.equal(actionUnavailable("Group", pair), undefined);
  assert.match(actionUnavailable("Distribute horizontally", pair)!, /three unlocked/);
  assert.equal(actionUnavailable("Distribute vertically", { ...pair, picked: [...pair.picked, { ...e, id: "third" }] }), undefined);
  assert.match(actionUnavailable("Align left", { ...pair, picked: [e, { ...e, id: "locked", locked: true }] })!, /two unlocked/);
  assert.match(actionUnavailable("Ungroup", pair)!, /grouped/);
  assert.equal(actionUnavailable("Ungroup", { ...empty, picked: [{ ...e, groupId: "g" }] }), undefined);
});
test("clipboard, history, zoom and saved-revision prerequisites match toolbar and menu", () => {
  for (const name of ["Paste", "Copy", "Cut", "Delete", "Rotate", "Rotate 90°", "Rotate 90 degrees", "Undo", "Redo", "Revision history", "Export portable project"])
    assert.ok(actionUnavailable(name, empty), name);
  assert.equal(actionUnavailable("Paste", { ...empty, clipboardCount: 1 }), undefined);
  assert.equal(actionUnavailable("Undo", { ...empty, past: 1 }), undefined);
  assert.equal(actionUnavailable("Redo", { ...empty, future: 1 }), undefined);
  assert.ok(actionUnavailable("Zoom in", { ...empty, zoom: 3 }));
  assert.ok(actionUnavailable("Zoom out", { ...empty, zoom: .2 }));
  assert.equal(actionUnavailable("Export portable project", { ...empty, revision: 1, dirty: false }), undefined);
  assert.ok(actionUnavailable("Save", { ...empty, busy: true }));
});
