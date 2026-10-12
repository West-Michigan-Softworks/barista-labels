import { z } from "zod";
export const diagnosticSchema = z.object({
  severity: z.enum(["error", "warning"]),
  code: z.string(),
  message: z.string(),
  elementId: z.string().optional(),
});
export type Diagnostic = z.infer<typeof diagnosticSchema>;
const base = {
  id: z.string().min(1),
  name: z.string().default("Object"),
  xUm: z.number().int(),
  yUm: z.number().int(),
  widthUm: z.number().int().positive(),
  heightUm: z.number().int().positive(),
  rotation: z.number().finite().default(0),
  locked: z.boolean().default(false),
  groupId: z.string().optional(),
};
export const symbologies = [
  "code128",
  "gs1-128",
  "code39",
  "ean13",
  "upca",
  "qrcode",
  "datamatrix",
] as const;
export const elementSchema = z.discriminatedUnion("type", [
  z.object({
    ...base,
    type: z.literal("text"),
    text: z.string(),
    dataMode: z.enum(["literal", "template", "formula"]).optional(),
    fontFamily: z.string().default("Arial"),
    fontSizeUm: z.number().int().positive(),
    lineHeightUm: z.number().int().positive().optional(),
    bold: z.boolean().default(false),
    align: z.enum(["left", "center", "right"]).default("left"),
  }),
  z.object({
    ...base,
    type: z.literal("rectangle"),
    strokeUm: z.number().int().nonnegative(),
    fill: z.enum(["black", "white", "none"]),
  }),
  z.object({
    ...base,
    type: z.literal("ellipse"),
    strokeUm: z.number().int().nonnegative(),
    fill: z.enum(["black", "white", "none"]),
  }),
  z.object({
    ...base,
    type: z.literal("line"),
    strokeUm: z.number().int().nonnegative(),
    fill: z.enum(["black", "white", "none"]),
  }),
  z.object({
    ...base,
    type: z.literal("barcode"),
    symbology: z.enum(symbologies),
    value: z.string(),
    dataMode: z.enum(["literal", "template", "formula"]).optional(),
  }),
  z.object({ ...base, type: z.literal("image"), assetId: z.string() }),
]);
export type LabelElement = z.infer<typeof elementSchema>;
export const assetSchema = z.object({
  id: z.string(),
  name: z.string(),
  mimeType: z.string(),
  fileName: z.string(),
  kind: z.enum(["image", "font", "original"]).optional(),
});
export type Asset = z.infer<typeof assetSchema>;
export const projectSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string(),
    name: z.string().min(1),
    templates: z
      .array(
        z.object({
          id: z.string(),
          name: z.string(),
          widthUm: z.number().int().positive().max(2_000_000),
          heightUm: z.number().int().positive().max(2_000_000),
          elements: z.array(elementSchema).max(10000),
          guides: z
            .array(
              z.object({
                id: z.string(),
                axis: z.enum(["x", "y"]),
                positionUm: z.number().int(),
              }),
            )
            .max(100)
            .optional(),
        }),
      )
      .min(1),
    variables: z.array(
      z.object({
        name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
        defaultValue: z.string(),
        formula: z.string().max(8192).optional(),
      }),
    ),
    assets: z.array(assetSchema),
    importDiagnostics: z.array(diagnosticSchema),
  })
  .superRefine((p, context) => {
    const unique = (values: string[], path: (string | number)[]) => {
      if (new Set(values).size !== values.length)
        context.addIssue({
          code: "custom",
          message: "Identifiers must be unique",
          path,
        });
    };
    unique(
      p.templates.map((t) => t.id),
      ["templates"],
    );
    unique(
      p.templates.flatMap((t) => t.elements.map((e) => e.id)),
      ["templates"],
    );
    unique(
      p.variables.map((v) => v.name),
      ["variables"],
    );
    unique(
      p.assets.map((a) => a.id),
      ["assets"],
    );
  });
export type Project = z.infer<typeof projectSchema>;
export type LabelTemplate = Project["templates"][number];
export const printerSchema = z.object({
  id: z.string(),
  name: z.string(),
  host: z.string(),
  port: z.number().int().min(1).max(65535).default(9100),
  dotsPerMm: z.number().positive().max(48),
  widthDots: z.number().int().positive().max(10000),
  offsetX: z.number().int().default(0),
  offsetY: z.number().int().default(0),
  model: z.string().optional(),
  media: z.enum(["gap", "continuous", "mark"]).optional(),
  source: z.literal("sql").optional(),
  description: z.string().optional(),
  location: z.number().int().nullable().optional(),
  brand: z.string().optional(),
  dateAdded: z.string().optional(),
});
export type PrinterProfile = z.infer<typeof printerSchema>;
export const id = () => crypto.randomUUID();
export function newProject(): Project {
  return {
    schemaVersion: 1,
    id: id(),
    name: "Untitled",
    templates: [
      {
        id: id(),
        name: "Template 1",
        widthUm: 101600,
        heightUm: 50800,
        elements: [],
      },
    ],
    variables: [],
    assets: [],
    importDiagnostics: [],
  };
}
export function demoProject(): Project {
  const p = newProject();
  p.name = "Receiving label";
  p.templates[0].elements = [
    {
      id: id(),
      name: "Company",
      type: "text",
      xUm: 5000,
      yUm: 4500,
      widthUm: 90000,
      heightUm: 8500,
      rotation: 0,
      locked: false,
      text: "BEHLER-YOUNG",
      fontFamily: "Arial",
      fontSizeUm: 6000,
      bold: true,
      align: "left",
    },
    {
      id: id(),
      name: "Divider",
      type: "line",
      xUm: 5000,
      yUm: 14000,
      widthUm: 90000,
      heightUm: 100,
      rotation: 0,
      locked: false,
      strokeUm: 400,
      fill: "none",
    },
    {
      id: id(),
      name: "Description",
      type: "text",
      xUm: 5000,
      yUm: 17000,
      widthUm: 90000,
      heightUm: 6500,
      rotation: 0,
      locked: false,
      text: "{{description}}",
      fontFamily: "Arial",
      fontSizeUm: 4000,
      bold: false,
      align: "left",
    },
    {
      id: id(),
      name: "Item barcode",
      type: "barcode",
      xUm: 5000,
      yUm: 27000,
      widthUm: 65000,
      heightUm: 16000,
      rotation: 0,
      locked: false,
      symbology: "code128",
      value: "{{item}}",
    },
    {
      id: id(),
      name: "Item number",
      type: "text",
      xUm: 74000,
      yUm: 30000,
      widthUm: 23000,
      heightUm: 15000,
      rotation: 0,
      locked: false,
      text: "{{item}}",
      fontFamily: "Arial",
      fontSizeUm: 3600,
      bold: true,
      align: "left",
    },
  ];
  p.variables = [
    { name: "description", defaultValue: "Copper fitting • 1/2 inch" },
    { name: "item", defaultValue: "BY-10482" },
  ];
  return p;
}
export const zt411: PrinterProfile = {
  id: "zt411-profile",
  name: "ZT411 · 203 dpi",
  model: "ZDesigner ZT411-203dpi ZPL",
  host: "",
  port: 9100,
  dotsPerMm: 8,
  widthDots: 832,
  offsetX: 0,
  offsetY: 0,
  media: "gap",
};
export const resolveFields = (value: string, data: Record<string, string>) =>
  value.replace(
    /\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g,
    (_, key: string) => data[key] ?? `{{${key}}}`,
  );
