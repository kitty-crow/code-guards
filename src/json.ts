/** Decode JSON lines into concrete values at the process boundary. */
export type JsonValue = string | number | boolean | null | JsonValue[] | JsonRecord;

export class JsonRecord {
  constructor(private readonly fields: ReadonlyMap<string, JsonValue>) {}

  get(key: string): JsonValue {
    return this.fields.get(key) ?? null;
  }

  text(key: string): string {
    const value = this.get(key);
    if (typeof value !== "string") throw new Error("Expected string field: " + key);
    return value;
  }

  number(key: string): number {
    const value = this.get(key);
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Expected finite number field: " + key);
    return value;
  }

  record(key: string): JsonRecord {
    const value = this.get(key);
    if (!(value instanceof JsonRecord)) throw new Error("Expected object field: " + key);
    return value;
  }

  strings(key: string): string[] {
    const value = this.get(key);
    if (!Array.isArray(value)) throw new Error("Expected array field: " + key);
    return value.map(item => {
      if (typeof item !== "string") throw new Error("Expected string array field: " + key);
      return item;
    });
  }
}

function decodeString(token: string): string {
  const escapes: Readonly<Record<string, string>> = {
    '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t"
  };
  return token.slice(1, -1).replace(/\\(u[0-9a-fA-F]{4}|["\\/bfnrt])/g, (_match: string, code: string) =>
    code.startsWith("u") ? String.fromCharCode(Number.parseInt(code.slice(1), 16)) : (escapes[code] ?? "")
  );
}

class Reader {
  private offset = 0;
  private readonly tokens = /[ \t\r\n]*("(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|true|false|null|[{}\[\],:])/y;

  constructor(private readonly input: string) {}

  private token(): string {
    this.tokens.lastIndex = this.offset;
    const match = this.tokens.exec(this.input);
    if (!match) throw new Error("Invalid JSON at character " + this.offset);
    this.offset = this.tokens.lastIndex;
    return match[1] ?? "";
  }

  private value(token: string, depth: number): JsonValue {
    if (depth > 128) throw new Error("JSON nesting exceeds the IPC limit.");
    if (token === "{") return this.object(depth + 1);
    if (token === "[") return this.array(depth + 1);
    if (token === "null") return null;
    if (token === "true") return true;
    if (token === "false") return false;
    if (token.startsWith('"')) return decodeString(token);
    const number = Number(token);
    if (!/^-?[0-9]/.test(token) || !Number.isFinite(number)) throw new Error("Invalid JSON value.");
    return number;
  }

  private object(depth: number): JsonRecord {
    const fields = new Map<string, JsonValue>();
    let key = this.token();
    if (key === "}") return new JsonRecord(fields);
    for (;;) {
      if (!key.startsWith('"') || this.token() !== ":") throw new Error("Invalid JSON object.");
      fields.set(decodeString(key), this.value(this.token(), depth));
      const delimiter = this.token();
      if (delimiter === "}") return new JsonRecord(fields);
      if (delimiter !== ",") throw new Error("Invalid JSON object separator.");
      key = this.token();
    }
  }

  private array(depth: number): JsonValue[] {
    const values: JsonValue[] = [];
    let token = this.token();
    if (token === "]") return values;
    for (;;) {
      values.push(this.value(token, depth));
      const delimiter = this.token();
      if (delimiter === "]") return values;
      if (delimiter !== ",") throw new Error("Invalid JSON array separator.");
      token = this.token();
    }
  }

  read(): JsonValue {
    const value = this.value(this.token(), 0);
    if (!/^[ \t\r\n]*$/.test(this.input.slice(this.offset))) throw new Error("Trailing JSON content.");
    return value;
  }
}

/** IPC accepts JSON records, rejects invalid syntax and caps recursive nesting. */
export function parseRecord(input: string): JsonRecord {
  const value = new Reader(input).read();
  if (!(value instanceof JsonRecord)) throw new Error("Expected JSON object.");
  return value;
}
