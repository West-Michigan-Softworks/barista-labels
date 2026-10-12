export function workspaceMode(path: string, admin: boolean): "editor" | "printer" {
  return admin && path !== "/printer" ? "editor" : "printer";
}
