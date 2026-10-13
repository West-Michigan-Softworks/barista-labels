import ts from "typescript";
import { readFileSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";

const files = ["src/App.tsx", "src/Modal.tsx", "src/PrinterConfiguration.tsx"];
const compact = text => text.replace(/\s+/g, " ").trim();
export function inventory(annotate = false) {
  const entries = [];
  for (const file of files) {
    let source = readFileSync(file, "utf8");
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const inserts = [];
    const prefix = file.split("/").at(-1).replace(".tsx", "");
    let nextId = Math.max(0, ...Array.from(source.matchAll(/(?:data-editor-control|auditId)="([^"]+)"/g), match => Number(match[1].split("-").at(-1)) || 0));
    const visit = node => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName.getText(tree);
        const attrs = node.attributes.properties.filter(ts.isJsxAttribute);
        const attr = name => attrs.find(a => a.name.getText(tree) === name);
        let parent = node.parent;
        while (parent && !ts.isFunctionDeclaration(parent)) parent = parent.parent;
        const internalTool = parent?.name?.getText(tree) === "Tool";
        const keyboardFocus = attr("tabIndex") && compact(attr("tabIndex").initializer?.getText(tree) ?? "").replace(/ /g, "") !== "{-1}";
        if (!internalTool && (["button", "input", "select", "textarea", "summary", "Tool"].includes(tag) || attr("onDoubleClick") || attr("onClick") || attr("onKeyDown") || keyboardFocus)) {
          const key = ["Tool", "Canvas"].includes(tag) ? "auditId" : "data-editor-control";
          const id = attr(key)?.initializer?.text ?? `${prefix}-${String(++nextId).padStart(3, "0")}`;
          if (annotate && !attr(key)) inserts.push({ pos: node.tagName.end, text: ` ${key}="${id}"` });
          const label = attr("aria-label") ?? attr("label");
          const element = node.parent;
          const children = ts.isJsxElement(element) && element.openingElement === node ? element.children.map(c => c.getText(tree)).join(" ") : "";
          let field = element;
          while (field && !(ts.isJsxElement(field) && field.openingElement.tagName.getText(tree) === "Field")) field = field.parent;
          const fieldLabel = field?.openingElement.attributes.properties.find(a => ts.isJsxAttribute(a) && a.name.getText(tree) === "label")?.initializer?.getText(tree);
          entries.push({ id, file, tag, label: compact(label?.initializer?.getText(tree) ?? (children || fieldLabel || attr("title")?.initializer?.getText(tree) || attr("accept")?.initializer?.getText(tree) || tag)).slice(0, 180),
            events: attrs.filter(a => /^on[A-Z]/.test(a.name.getText(tree))).map(a => a.name.getText(tree)),
            conditional: !!attr("disabled"), readOnly: !!attr("readOnly"), hidden: !!attr("hidden") });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
    if (inserts.length) {
      for (const insert of inserts.sort((a, b) => b.pos - a.pos)) source = source.slice(0, insert.pos) + insert.text + source.slice(insert.pos);
      writeFileSync(file, source);
    }
  }
  assert.equal(new Set(entries.map(e => e.id)).size, entries.length, "control IDs must be unique");
  return entries;
}
if (process.argv[1]?.endsWith("editor-control-inventory.mjs")) {
  const annotate = process.argv.includes("--annotate");
  if (annotate) inventory(true);
  const actual = inventory();
  const path = "docs/editor-controls.json";
  if (process.argv.includes("--write") || annotate) writeFileSync(path, JSON.stringify(actual, null, 2) + "\n");
  else assert.deepEqual(actual, JSON.parse(readFileSync(path, "utf8")), "Editor control inventory changed. Audit new controls and update docs/editor-controls.json.");
  console.log(`${actual.length} editor control sites inventoried.`);
}
