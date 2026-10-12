type Value = string | number;
type Node =
  | { kind: "literal"; value: Value }
  | { kind: "field"; name: string }
  | { kind: "call"; name: string; args: Node[] }
  | { kind: "join"; left: Node; right: Node };
interface FunctionDefinition {
  name: string;
  aliases?: string[];
  signature: string;
  description: string;
  min: number;
  max: number;
  evaluate: (args: Value[], field: (name: string) => string) => Value;
}
const integer = (value: Value, minimum = 0) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < minimum || String(value).trim() === "")
    throw new Error("Expected an integer >= " + minimum + ".");
  return n;
};
/** One catalog drives function lookup, validation, and the editor assistant. */
export const formulaFunctions: FunctionDefinition[] = [
  {
    name: "CONCATENATE",
    aliases: ["CONCAT"],
    signature: "CONCATENATE(value, ...)",
    description: "Join values",
    min: 1,
    max: 256,
    evaluate: (a) => a.join(""),
  },
  {
    name: "LEFT",
    signature: "LEFT(value, count)",
    description: "First characters; count defaults to 1",
    min: 1,
    max: 2,
    evaluate: (a) => String(a[0]).slice(0, a.length === 1 ? 1 : integer(a[1])),
  },
  {
    name: "RIGHT",
    signature: "RIGHT(value, count)",
    description: "Last characters; count defaults to 1",
    min: 1,
    max: 2,
    evaluate: (a) => {
      const n = a.length === 1 ? 1 : integer(a[1]);
      return n === 0 ? "" : String(a[0]).slice(-n);
    },
  },
  {
    name: "MID",
    signature: "MID(value, start, count)",
    description: "Characters from a position starting at 1",
    min: 3,
    max: 3,
    evaluate: (a) => {
      const start = integer(a[1], 1) - 1;
      return String(a[0]).slice(start, start + integer(a[2]));
    },
  },
  {
    name: "UPPER",
    aliases: ["UCASE"],
    signature: "UPPER(value)",
    description: "Uppercase letters",
    min: 1,
    max: 1,
    evaluate: (a) => String(a[0]).toUpperCase(),
  },
  {
    name: "LOWER",
    aliases: ["LCASE"],
    signature: "LOWER(value)",
    description: "Lowercase letters",
    min: 1,
    max: 1,
    evaluate: (a) => String(a[0]).toLowerCase(),
  },
  {
    name: "TRIM",
    signature: "TRIM(value)",
    description: "Remove outer whitespace and collapse repeated spaces",
    min: 1,
    max: 1,
    evaluate: (a) => String(a[0]).trim().replace(/ +/g, " "),
  },
  {
    name: "LTRIM",
    signature: "LTRIM(value)",
    description: "Remove leading whitespace",
    min: 1,
    max: 1,
    evaluate: (a) => String(a[0]).trimStart(),
  },
  {
    name: "RTRIM",
    signature: "RTRIM(value)",
    description: "Remove trailing whitespace",
    min: 1,
    max: 1,
    evaluate: (a) => String(a[0]).trimEnd(),
  },
  {
    name: "LEN",
    signature: "LEN(value)",
    description: "Number of characters",
    min: 1,
    max: 1,
    evaluate: (a) => String(a[0]).length,
  },
  {
    name: "SUBSTITUTE",
    signature: "SUBSTITUTE(value, search, replacement)",
    description: "Replace every matching string",
    min: 3,
    max: 3,
    evaluate: (a) => {
      if (String(a[1]) === "")
        throw new Error("Search string cannot be empty.");
      return String(a[0]).split(String(a[1])).join(String(a[2]));
    },
  },
  {
    name: "FIELD",
    aliases: ["FORMAT.NAMEDSUBSTRINGS"],
    signature: 'FIELD("name")',
    description: "Read a named input or formula",
    min: 1,
    max: 1,
    evaluate: (a, field) => field(String(a[0])),
  },
];
const functions = new Map(
  formulaFunctions.flatMap((f) =>
    [f.name, ...(f.aliases ?? [])].map((name) => [name, f] as const),
  ),
);
const bounded = (value: Value): Value => {
  if (String(value).length > 65536)
    throw new Error("Formula result exceeds 65536 characters.");
  return value;
};
function parseFormula(source: string): Node {
  if (source.length > 8192)
    throw new Error("Formula is too long (maximum 8192 characters).");
  const input = source.trim().replace(/^=/, "");
  let pos = 0,
    nodes = 0;
  const space = () => {
    while (pos < input.length && /\s/.test(input[pos])) pos++;
  };
  const fail = (message: string): never => {
    throw new Error(message + " at character " + (pos + 1) + ".");
  };
  const atom = (depth: number): Node => {
    if (depth > 32 || ++nodes > 1024)
      return fail("Formula exceeds nesting or complexity limit");
    space();
    if (input[pos] === "(") {
      pos++;
      const node = expression(depth + 1);
      space();
      if (input[pos++] !== ")") fail("Expected closing parenthesis");
      return node;
    }
    if (input[pos] === '"') {
      pos++;
      let value = "";
      while (pos < input.length) {
        const c = input[pos++];
        if (c === '"') {
          if (input[pos] === '"') {
            value += '"';
            pos++;
          } else return { kind: "literal", value };
        } else value += c;
      }
      return fail("Unclosed string");
    }
    const ref = /^\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/.exec(input.slice(pos));
    if (ref) {
      pos += ref[0].length;
      return { kind: "field", name: ref[1] };
    }
    const number = /^-?\d+/.exec(input.slice(pos));
    if (number) {
      pos += number[0].length;
      return { kind: "literal", value: Number(number[0]) };
    }
    const name = /^(?:Format\.NamedSubStrings|[A-Za-z_][A-Za-z0-9_]*)/i.exec(
      input.slice(pos),
    );
    if (!name) return fail("Expected a string, number, field, or function");
    pos += name[0].length;
    space();
    if (input[pos] !== "(") return { kind: "field", name: name[0] };
    pos++;
    const args: Node[] = [];
    space();
    if (input[pos] !== ")") {
      while (true) {
        args.push(expression(depth + 1));
        space();
        if (input[pos] !== ",") break;
        pos++;
      }
    }
    if (input[pos++] !== ")") return fail("Expected closing parenthesis");
    const fn = functions.get(name[0].toUpperCase());
    if (!fn) return fail("Unsupported function " + name[0]);
    if (args.length < fn.min || args.length > fn.max)
      return fail(
        fn.name +
          " expects " +
          fn.min +
          (fn.max === fn.min ? "" : "-" + fn.max) +
          " arguments",
      );
    if (
      fn.name === "FIELD" &&
      (args[0].kind !== "literal" || typeof args[0].value !== "string")
    )
      return fail("FIELD requires a quoted field name");
    return { kind: "call", name: fn.name, args };
  };
  const expression = (depth: number): Node => {
    let node = atom(depth);
    space();
    while (input[pos] === "&") {
      pos++;
      node = { kind: "join", left: node, right: atom(depth + 1) };
      space();
    }
    return node;
  };
  const result = expression(0);
  space();
  if (pos !== input.length) fail("Unexpected input");
  return result;
}
export function formulaReferences(source: string): string[] {
  const result = new Set<string>();
  const visit = (node: Node) => {
    if (node.kind === "field") result.add(node.name);
    else if (node.kind === "join") {
      visit(node.left);
      visit(node.right);
    } else if (node.kind === "call") {
      if (node.name === "FIELD")
        result.add(String((node.args[0] as { value: Value }).value));
      else node.args.forEach(visit);
    }
  };
  visit(parseFormula(source));
  return [...result];
}
/** Input values are data, never code. */
export function evaluateFormula(
  source: string,
  data: Record<string, string>,
  resolve?: (name: string) => string,
): string {
  const field =
    resolve ??
    ((name: string) => {
      if (!Object.hasOwn(data, name))
        throw new Error("Missing value for " + name + ".");
      return data[name];
    });
  const evaluate = (node: Node): Value => {
    switch (node.kind) {
      case "literal":
        return node.value;
      case "field":
        return bounded(field(node.name));
      case "join":
        return bounded(
          String(evaluate(node.left)) + String(evaluate(node.right)),
        );
      case "call":
        return bounded(
          functions.get(node.name)!.evaluate(node.args.map(evaluate), field),
        );
    }
  };
  return String(bounded(evaluate(parseFormula(source))));
}
export function previewFormula(
  source: string,
  data: Record<string, string>,
): string {
  try {
    return evaluateFormula(source, data);
  } catch {
    return "[Formula error]";
  }
}
export interface FormulaSource {
  name: string;
  defaultValue?: string;
  formula?: string;
}
/** Resolve computed sources once per row, independent of declaration order. */
export function resolveFormulaSources(
  sources: FormulaSource[],
  inputs: Record<string, string>,
) {
  const definitions = new Map(sources.map((source) => [source.name, source]));
  const values: Record<string, string> = Object.assign(
    Object.create(null),
    inputs,
  );
  const errors: { name: string; message: string }[] = [];
  const resolved = new Set<string>(),
    active = new Set<string>();
  const resolve = (name: string): string => {
    const definition = definitions.get(name);
    if (resolved.has(name)) return values[name];
    if (active.has(name))
      throw new Error(
        "Circular formula reference: " + [...active, name].join(" -> ") + ".",
      );
    if (active.size >= 32)
      throw new Error("Formula dependency depth exceeds 32 levels.");
    if (definition?.formula !== undefined) {
      active.add(name);
      try {
        values[name] = evaluateFormula(definition.formula, {}, resolve);
        resolved.add(name);
      } finally {
        active.delete(name);
      }
    } else if (!Object.hasOwn(values, name)) {
      if (definition?.defaultValue === undefined)
        throw new Error("Missing value for " + name + ".");
      values[name] = definition.defaultValue;
    }
    return values[name];
  };
  for (const source of sources) {
    try {
      resolve(source.name);
    } catch (error) {
      delete values[source.name];
      errors.push({ name: source.name, message: (error as Error).message });
    }
  }
  return { values, errors };
}
