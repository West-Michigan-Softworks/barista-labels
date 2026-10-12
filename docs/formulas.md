# Element formulas

Select a text or barcode element, choose **Formula** under **Data source**, and enter the formula in its text/data box. The Formula result section shows the result using current sample values or the selected CSV row. Formulas are saved with the element and evaluated for each print or CSV batch row.

Create a named field such as `item` in Data Sources, then use:

```text
=CONCATENATE(LEFT(item,1),"-",MID(item,2,2),"-",MID(item,4,2),"-",MID(item,6,2),"-",MID(item,8,2),"-",RIGHT(item,1))
```

For `item = 1234567890`, this produces `1-23-45-67-89-0`.

References use named fields (`item` or `{{item}}`). Spreadsheet addresses are not automatically mapped: `B2` works only if a named field called `B2` exists. Map CSV columns to named fields as usual. Field values are treated as data and never evaluated as formulas themselves.

To reuse a formula, open **Data Sources**, add a named field such as `formatted_item`, change its source type to **Formula**, and enter the expression. Attach `{{formatted_item}}` to any text or barcode element using Named fields, or reference `formatted_item` inside another formula. Changing the definition updates every linked element. Named formulas can reference other named formulas; declaration order does not matter. Circular references and dependency chains beyond 32 levels are rejected. Formula values are computed and cannot be replaced by print-time or CSV inputs.

Each source shows its result using current input values. Formula sources do not need CSV column mappings. Published labels retain formula dependencies and request only the raw input columns. Old projects without formulas retain their existing behavior.

BarTender-style string concatenation is also supported:

```text
Left(Field("item"),1) & "-" & Mid(Format.NamedSubStrings("item"),2,2)
```

Both FIELD and Format.NamedSubStrings read Barista named sources. BarTender distinguishes database fields from named sources; Barista's input model does not make that distinction.

Supported functions are case insensitive and can be nested:

| Function | Behavior |
| --- | --- |
| `CONCATENATE(value, ...)` / `CONCAT(value, ...)` | Join one or more values |
| `LEFT(value, count)` | First count characters; count defaults to 1 |
| `RIGHT(value, count)` | Last count characters; count defaults to 1 |
| `MID(value, start, count)` | Characters from a position starting at 1 |
| `UPPER(value)` / `LOWER(value)` | Change letter case |
| `UCASE(value)` / `LCASE(value)` | Aliases for UPPER / LOWER |
| `TRIM(value)` | Remove outer whitespace and collapse repeated spaces |
| `LTRIM(value)` / `RTRIM(value)` | Remove leading / trailing whitespace |
| `LEN(value)` | Length of a value |
| `SUBSTITUTE(value, search, replacement)` | Replace every occurrence of a nonempty search string |
| `FIELD("name")` / `Format.NamedSubStrings("name")` | Read an input or formula by its quoted name |

Use double quotes for strings and doubled quotes inside strings (`"say ""hello"""`). The leading `=` is optional. Counts must be nonnegative integers; MID start must be at least 1. String positions count UTF-16 units. This is a limited formula language: spreadsheet ranges, arithmetic/logical operators, scripts, and unlisted functions are unsupported. TRIM collapses internal repeated spaces as in Excel; it is not a claim of VBScript TRIM equivalence.

Invalid syntax, unsupported functions, and missing fields show an error and block preview compilation and printing. CSV batches must validate all rows before queueing. Limits are 8192 formula characters, 32 nesting levels, and 65536 output characters.

The shared function registry supplies both interpreter implementations and editor function descriptions. Formatting rules are user-authored project expressions; adding a new primitive function requires extending that registry. See the local [BarTender investigation](../bartender-investigation/formula-findings.md) for observations, design choices, and compatibility limits.
