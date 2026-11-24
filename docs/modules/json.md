# JSON IPC

Source: [`src/json.ts`](../../src/json.ts)

`parseRecord(input)` reads a JSON object. `JsonValue` represents strings, finite numbers, booleans, null, arrays and nested `JsonRecord` objects. `JsonRecord` provides checked text, number, record and string-array accessors. Missing fields return null through `get`; typed accessors throw for missing or mismatched fields. The parser rejects trailing content and limits nesting to 128 levels.
