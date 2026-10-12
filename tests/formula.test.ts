import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateFormula,
  previewFormula,
  formulaReferences,
  resolveFormulaSources,
} from "../shared/formula";
import { labelFields, labelSources } from "../shared/publishing";
import { demoProject, projectSchema } from "../shared/model";
import { compileProject, closeRenderer } from "../server/render";

const formula =
  '=CONCATENATE(LEFT(item,1),"-",MID(item,2,2),"-",MID(item,4,2),"-",MID(item,6,2),"-",MID(item,8,2),"-",RIGHT(item,1))';
test("formats named fields with nested Excel-style string functions", () => {
  assert.equal(
    evaluateFormula(formula, { item: "1234567890" }),
    "1-23-45-67-89-0",
  );
  assert.equal(
    evaluateFormula(formula.replaceAll("item", "B2"), { B2: "1234567890" }),
    "1-23-45-67-89-0",
  );
  assert.equal(
    evaluateFormula('concat(upper(trim({{item}}))," ""quoted""",LEN(item))', {
      item: " ab  cd ",
    }),
    'AB CD "quoted"8',
  );
  assert.equal(evaluateFormula("RIGHT(item,0)", { item: "abc" }), "");
  assert.equal(evaluateFormula("LEFT(item)", { item: "abc" }), "a");
  assert.equal(evaluateFormula("MID(item,9,2)", { item: "abc" }), "");
  assert.equal(evaluateFormula("LOWER(item)", { item: "ABC" }), "abc");
});
test("rejects invalid formulas and never evaluates field contents as code", () => {
  for (const source of [
    "LEFT(missing,1)",
    "LEFT(item,-1)",
    "MID(item,0,1)",
    "LEFT(item,1.5)",
    "LEFT(item,1)junk",
    "LEFT(item,1,2)",
    "UNKNOWN(item)",
    '"unclosed',
    "CONCAT()",
    "item.constructor()",
    "",
  ]) {
    assert.throws(
      () => evaluateFormula(source, { item: "abc" }),
      Error,
      source,
    );
    assert.equal(previewFormula(source, { item: "abc" }), "[Formula error]");
  }
  assert.equal(
    evaluateFormula("item", { item: '=UNKNOWN("x"){{other}}' }),
    '=UNKNOWN("x"){{other}}',
  );
  assert.throws(
    () =>
      evaluateFormula("UPPER(".repeat(34) + "item" + ")".repeat(34), {
        item: "x",
      }),
    /nesting/,
  );
  assert.throws(() => evaluateFormula("x".repeat(8193), {}), /too long/);
});
test("BarTender-style references, function aliases, and concatenation are supported", () => {
  const expression =
    'Left(Field("item"),1) & "-" & (Mid(Format.NamedSubStrings("item"),2,2)) & UCase(suffix)';
  assert.equal(
    evaluateFormula(expression, { item: "1234567890", suffix: "ab" }),
    "1-23AB",
  );
  assert.deepEqual(formulaReferences(expression), ["item", "suffix"]);
  assert.deepEqual(formulaReferences('CONCAT("{{ignored}}",LOWER(item))'), [
    "item",
  ]);
  assert.equal(
    evaluateFormula('SUBSTITUTE(RTrim(item),"ab","X")', { item: "abab  " }),
    "XX",
  );
  assert.throws(
    () => evaluateFormula("FIELD(item)", { item: "abc" }),
    /quoted/,
  );
});
test("named formulas resolve dependencies per row and cannot be overridden by inputs", () => {
  const definitions = [
    { name: "caption", formula: 'UPPER(formatted) & "!"' },
    { name: "formatted", formula },
    { name: "item", defaultValue: "1234567890" },
  ];
  const first = resolveFormulaSources(definitions, { formatted: "override" });
  assert.deepEqual(first.errors, []);
  assert.equal(first.values.caption, "1-23-45-67-89-0!");
  const next = resolveFormulaSources(definitions, { item: "ABCDEFGHIJ" });
  assert.equal(next.values.caption, "A-BC-DE-FG-HI-J!");
  assert.ok(
    resolveFormulaSources(
      [
        { name: "a", formula: "b" },
        { name: "b", formula: "a" },
      ],
      {},
    ).errors.every((e) => /Circular/.test(e.message)),
  );
  assert.match(
    resolveFormulaSources([{ name: "a", formula: "missing" }], {}).errors[0]
      .message,
    /Missing/,
  );
});
test("published label inputs follow formula dependencies and retain reusable definitions", () => {
  const p = demoProject();
  p.variables.push(
    { name: "formatted", defaultValue: "", formula },
    { name: "caption", defaultValue: "", formula: 'formatted & "!"' },
  );
  const text = p.templates[0].elements.find((e) => e.type === "text")!;
  if (text.type === "text") {
    text.dataMode = "template";
    text.text = "{{caption}}";
  }
  p.templates[0].elements = [text];
  assert.deepEqual(labelFields(p, p.templates[0].id), ["item"]);
  assert.deepEqual(
    labelSources(p, p.templates[0].id).map((v) => v.name),
    ["item", "formatted", "caption"],
  );
  const loaded = projectSchema.parse(JSON.parse(JSON.stringify(p)));
  assert.equal(
    loaded.variables.find((v) => v.name === "formatted")?.formula,
    formula,
  );
});
test("formula mode survives project save/load alongside legacy data modes", () => {
  const p = demoProject();
  const text = p.templates[0].elements.find((e) => e.type === "text")!;
  if (text.type === "text") {
    text.dataMode = "formula";
    text.text = formula;
  }
  const loaded = projectSchema.parse(JSON.parse(JSON.stringify(p)));
  assert.deepEqual(loaded, p);
});
test("printing uses formulas for text and barcodes and blocks invalid input", async () => {
  const base = {
    xUm: 0,
    yUm: 0,
    widthUm: 60000,
    heightUm: 15000,
    dataMode: "formula" as const,
  };
  const elements = [
    {
      ...base,
      id: "text",
      type: "text",
      text: formula,
      fontFamily: "Arial",
      fontSizeUm: 4000,
    },
    {
      ...base,
      id: "barcode",
      type: "barcode",
      yUm: 20000,
      value: formula,
      symbology: "code128",
    },
  ];
  const project = {
    templates: [{ id: "t", widthUm: 100000, heightUm: 50000, elements }],
  };
  try {
    const valid = await compileProject(
      project,
      "t",
      { item: "1234567890" },
      { dotsPerMm: 8, widthDots: 832 },
      ".",
    );
    assert.deepEqual(valid.diagnostics, []);
    assert.ok(valid.zpl);
    const literalProject = {
      templates: [
        {
          ...project.templates[0],
          elements: elements.map((e) => ({
            ...e,
            dataMode: "literal" as const,
            text: "1-23-45-67-89-0",
            value: "1-23-45-67-89-0",
          })),
        },
      ],
    };
    const literal = await compileProject(
      literalProject,
      "t",
      {},
      { dotsPerMm: 8, widthDots: 832 },
      ".",
    );
    assert.equal(valid.zpl, literal.zpl);
    assert.equal(valid.previewBase64, literal.previewBase64);
    const computedProject = {
      ...project,
      variables: [{ name: "formatted", formula }, { name: "item" }],
      templates: [
        {
          ...project.templates[0],
          elements: elements.map((e) => ({
            ...e,
            dataMode: "template" as const,
            text: "{{formatted}}",
            value: "{{formatted}}",
          })),
        },
      ],
    };
    const computed = await compileProject(
      computedProject,
      "t",
      { item: "1234567890" },
      { dotsPerMm: 8, widthDots: 832 },
      ".",
    );
    assert.equal(computed.zpl, literal.zpl);
    const blockedSource = await compileProject(
      computedProject,
      "t",
      {},
      { dotsPerMm: 8, widthDots: 832 },
      ".",
    );
    assert.equal(blockedSource.zpl, "");
    assert.ok(
      blockedSource.diagnostics.some(
        (d) => d.code === "INVALID_FORMULA_SOURCE",
      ),
    );
    const invalid = await compileProject(
      project,
      "t",
      {},
      { dotsPerMm: 8, widthDots: 832 },
      ".",
    );
    assert.equal(invalid.zpl, "");
    assert.ok(
      invalid.diagnostics.some(
        (d) => d.code === "INVALID_FORMULA" && d.elementId === "text",
      ),
    );
    assert.ok(
      invalid.diagnostics.some(
        (d) => d.code === "INVALID_FORMULA" && d.elementId === "barcode",
      ),
    );
  } finally {
    await closeRenderer();
  }
});
