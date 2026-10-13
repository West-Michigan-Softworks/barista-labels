import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
// @ts-ignore JavaScript tooling shared by the browser suite.
import { inventory } from "../tools/editor-control-inventory.mjs";
test("every editor interactive source site remains in the reviewed inventory", () => {
  const actual = inventory();
  assert.deepEqual(actual, JSON.parse(readFileSync("docs/editor-controls.json", "utf8")));
  for (const control of actual) {
    if (["button", "Tool"].includes(control.tag) && !control.events.length)
      assert.ok(control.tag === "Tool", `${control.id} is an inert button`);
    if (["input", "select", "textarea"].includes(control.tag))
      assert.ok(control.events.includes("onChange") || control.readOnly, `${control.id} lacks change behavior or a read-only explanation`);
  }
});
