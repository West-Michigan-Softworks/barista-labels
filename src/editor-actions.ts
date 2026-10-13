import type { LabelElement } from "../shared/model";

export type ActionState = {
  picked: LabelElement[]; clipboardCount: number; past: number; future: number;
  zoom: number; revision: number; dirty: boolean; busy: boolean;
};
/** Shared prerequisites for menus, toolbars, inspector and keyboard commands. */
export function actionUnavailable(label: string, state: ActionState): string | undefined {
  const editable = state.picked.filter(e => !e.locked);
  if (["Undo", "Redo"].includes(label)) return (label === "Undo" ? state.past : state.future) ? undefined : `Nothing to ${label.toLowerCase()}`;
  if (label === "Copy") return state.picked.length ? undefined : "Select an object to copy";
  if (label === "Paste") return state.clipboardCount ? undefined : "Copy or cut an object first";
  if (["Cut", "Delete", "Delete selection", "Bring to front", "Send to back", "Rotate", "Rotate 90°", "Rotate 90 degrees", "Centre on label ↔", "Centre on label ↕"].includes(label))
    return editable.length ? undefined : "Select an unlocked object";
  if (/^(Align |Horizontal centres|Vertical centres|Centre horizontal|Centre vertical)/.test(label) || label === "Group")
    return editable.length >= 2 ? undefined : "Select at least two unlocked objects";
  if (label === "Ungroup") return editable.some(e => e.groupId) ? undefined : "Select an unlocked grouped object";
  if (label.startsWith("Distribute ")) return editable.length >= 3 ? undefined : "Select at least three unlocked objects";
  if (label === "Zoom in") return state.zoom < 3 ? undefined : "Maximum zoom is 300%";
  if (label === "Zoom out") return state.zoom > 0.2 ? undefined : "Minimum zoom is 20%";
  if (label === "Revision history") return state.revision ? undefined : "Save the project first";
  if (label === "Export portable project") return state.revision && !state.dirty ? undefined : "Save the current revision first";
  if (state.busy && /^(New project|Open project|Import |Insert |Save|Recover draft|Revision history|Page setup|Named fields|Print|Upload font)/.test(label)) return "Wait for the current operation to finish";
}
