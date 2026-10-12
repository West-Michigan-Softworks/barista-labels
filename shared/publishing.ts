import Papa from "papaparse";
import type { Diagnostic, Project } from "./model";
import { formulaReferences } from "./formula";

export interface PublishedLabel {
  id: string;
  name: string;
  projectName: string;
  projectId: string;
  templateId: string;
  sourceRevision: number;
  version: number;
  published: boolean;
  publishedAt: string;
  publishedBy: string;
  fields: string[];
}
export interface Publication extends PublishedLabel { project: Project }
export interface PreparedPrint {
  id: string;
  count: number;
  rows: number;
  diagnostics: Diagnostic[];
}
export interface PreparedPreview {
  row: number;
  previewBase64: string;
  widthDots: number;
  heightDots: number;
  diagnostics: Diagnostic[];
}

export function labelSources(project: Project, templateId: string): Project["variables"] {
  const template = project.templates.find(t => t.id === templateId);
  if (!template) throw new Error("Label template not found");
  const used = new Set<string>();
  for (const element of template.elements) {
    if ((element.type !== "text" && element.type !== "barcode") || element.dataMode === "literal") continue;
    const value = element.type === "text" ? element.text : element.value;
    if (element.dataMode === "formula") {
      for (const field of formulaReferences(value)) used.add(field);
    } else {
      for (const match of value.matchAll(/\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g)) used.add(match[1]);
    }
  }
  const visited = new Set<string>(), active = new Set<string>();
  const visit = (name: string) => {
    if (active.has(name)) throw new Error(`Circular formula reference: ${name}`);
    if (visited.has(name)) return;
    const source = project.variables.find(v => v.name === name);
    if (!source) throw new Error(`Undeclared field: ${name}`);
    if (active.size >= 32) throw new Error("Formula dependency depth exceeds 32 levels.");
    active.add(name);
    if (source.formula !== undefined) for (const field of formulaReferences(source.formula)) { used.add(field); visit(field); }
    active.delete(name);
    visited.add(name);
  };
  for (const field of used) visit(field);
  return project.variables.filter(v => used.has(v.name));
}

export function labelFields(project: Project, templateId: string): string[] {
  return labelSources(project, templateId).filter(v => v.formula === undefined).map(v => v.name);
}

export function parseLabelCsv(csv: string, fields: string[]): Record<string, string>[] {
  if (csv.length > 16 * 1024 * 1024) throw new Error("CSV must be at most 16 MB");
  const parsed = Papa.parse<string[]>(csv.replace(/^\uFEFF/, ""), { delimiter: ",", skipEmptyLines: false });
  if (parsed.errors.length) throw new Error(`Invalid CSV: ${parsed.errors[0].message}`);
  const [headers, ...records] = parsed.data;
  if (!headers || headers.length !== fields.length || new Set(headers).size !== headers.length || headers.some(h => !fields.includes(h)))
    throw new Error(`CSV headers must contain exactly: ${fields.join(", ")}`);
  const rows: Record<string, string>[] = [];
  for (const [index, cells] of records.entries()) {
    if (cells.every(cell => !cell.trim())) continue;
    if (cells.length !== headers.length) throw new Error(`CSV row ${index + 2}: incorrect number of columns`);
    for (const [i, cell] of cells.entries()) {
      if (!cell.trim()) throw new Error(`CSV row ${index + 2}: ${headers[i]} is required`);
      if (cell.length > 10000) throw new Error(`CSV row ${index + 2}: ${headers[i]} exceeds 10000 characters`);
    }
    rows.push(Object.fromEntries(headers.map((header, i) => [header, cells[i]])));
  }
  if (!rows.length || rows.length > 5000) throw new Error("CSV must contain between 1 and 5000 nonempty rows");
  return rows;
}

export const csvHeaders = (fields: string[]) => Papa.unparse([fields]) + "\r\n";
