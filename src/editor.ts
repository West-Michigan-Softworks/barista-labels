import type { Project, LabelElement } from "../shared/model";
import { projectSchema } from "../shared/model";
export function recoveredDrafts(value: string | null): { project: Project; revision: number }[] {
  try {
    const drafts: unknown = JSON.parse(value ?? "{}");
    if (!drafts || typeof drafts !== "object" || Array.isArray(drafts)) return [];
    return Object.values(drafts).flatMap(draft => {
      if (!draft || typeof draft !== "object") return [];
      const parsed = projectSchema.safeParse(draft.project);
      return parsed.success ? [{ project: parsed.data, revision: Number.isInteger(draft.revision) && draft.revision >= 0 ? draft.revision : 0 }] : [];
    });
  } catch { return []; }
}
export function nextFieldName(names: string[]): string {
  let n = 1;
  while (names.includes(`field_${n}`)) n++;
  return `field_${n}`;
}
export type History = { past: Project[]; present: Project; future: Project[] };
export function transition(history: History, next: Project): History {
  return JSON.stringify(history.present) === JSON.stringify(next)
    ? history
    : {
        past: [...history.past.slice(-99), history.present],
        present: next,
        future: [],
      };
}
export function undo(history: History): History {
  if (!history.past.length) return history;
  return {
    past: history.past.slice(0, -1),
    present: history.past.at(-1)!,
    future: [history.present, ...history.future],
  };
}
export function redo(history: History): History {
  if (!history.future.length) return history;
  return {
    past: [...history.past, history.present],
    present: history.future[0],
    future: history.future.slice(1),
  };
}
export function moveSelection(
  elements: LabelElement[],
  ids: string[],
  dx: number,
  dy: number,
) {
  return elements.map((e) =>
    ids.includes(e.id) && !e.locked
      ? { ...e, xUm: e.xUm + dx, yUm: e.yUm + dy }
      : e,
  );
}
export function elementBounds(e: LabelElement) {
  const a = (e.rotation * Math.PI) / 180,
    c = Math.cos(a),
    s = Math.sin(a);
  const corners = [
    [0, 0],
    [e.widthUm, 0],
    [0, e.heightUm],
    [e.widthUm, e.heightUm],
  ].map(([x, y]) => ({ x: e.xUm + x * c - y * s, y: e.yUm + x * s + y * c }));
  return {
    left: Math.min(...corners.map((p) => p.x)),
    right: Math.max(...corners.map((p) => p.x)),
    top: Math.min(...corners.map((p) => p.y)),
    bottom: Math.max(...corners.map((p) => p.y)),
  };
}
export function arrange(
  elements: LabelElement[],
  ids: string[],
  action: string,
  widthUm: number,
  heightUm: number,
): LabelElement[] {
  const selected = elements.filter((e) => ids.includes(e.id) && !e.locked);
  if (!selected.length) return elements;
  const bounds = new Map(selected.map((e) => [e.id, elementBounds(e)]));
  const all = [...bounds.values()];
  const minX = Math.min(...all.map((b) => b.left)),
    maxX = Math.max(...all.map((b) => b.right)),
    minY = Math.min(...all.map((b) => b.top)),
    maxY = Math.max(...all.map((b) => b.bottom));
  const updates = new Map<string, Partial<LabelElement>>();
  if (action === "distribute-x" || action === "distribute-y") {
    if (selected.length < 3) return elements;
    const horizontal = action === "distribute-x";
    const sorted = [...selected].sort((a, b) =>
      horizontal
        ? bounds.get(a.id)!.left - bounds.get(b.id)!.left
        : bounds.get(a.id)!.top - bounds.get(b.id)!.top,
    );
    const total = sorted.reduce((n, e) => {
      const b = bounds.get(e.id)!;
      return n + (horizontal ? b.right - b.left : b.bottom - b.top);
    }, 0);
    const gap =
      ((horizontal ? maxX - minX : maxY - minY) - total) / (sorted.length - 1);
    let cursor = horizontal ? minX : minY;
    for (const e of sorted) {
      const b = bounds.get(e.id)!;
      updates.set(
        e.id,
        horizontal
          ? { xUm: Math.round(e.xUm + cursor - b.left) }
          : { yUm: Math.round(e.yUm + cursor - b.top) },
      );
      cursor += (horizontal ? b.right - b.left : b.bottom - b.top) + gap;
    }
  } else
    for (const e of selected) {
      const b = bounds.get(e.id)!,
        u: Partial<LabelElement> = {};
      if (action === "left") u.xUm = Math.round(e.xUm + minX - b.left);
      if (action === "right") u.xUm = Math.round(e.xUm + maxX - b.right);
      if (action === "top") u.yUm = Math.round(e.yUm + minY - b.top);
      if (action === "bottom") u.yUm = Math.round(e.yUm + maxY - b.bottom);
      if (action === "center-x")
        u.xUm = Math.round(e.xUm + (minX + maxX - b.left - b.right) / 2);
      if (action === "center-y")
        u.yUm = Math.round(e.yUm + (minY + maxY - b.top - b.bottom) / 2);
      if (action === "label-x")
        u.xUm = Math.round(e.xUm + (widthUm - b.left - b.right) / 2);
      if (action === "label-y")
        u.yUm = Math.round(e.yUm + (heightUm - b.top - b.bottom) / 2);
      if (action === "rotate") {
        u.rotation = (e.rotation + 90) % 360;
        const a = (u.rotation * Math.PI) / 180;
        u.xUm = Math.round(
          (b.left + b.right) / 2 -
            (e.widthUm / 2) * Math.cos(a) +
            (e.heightUm / 2) * Math.sin(a),
        );
        u.yUm = Math.round(
          (b.top + b.bottom) / 2 -
            (e.widthUm / 2) * Math.sin(a) -
            (e.heightUm / 2) * Math.cos(a),
        );
      }
      updates.set(e.id, u);
    }
  return elements.map((e) =>
    updates.has(e.id) ? ({ ...e, ...updates.get(e.id) } as LabelElement) : e,
  );
}
