import ts from "typescript";

function property(node: ts.ObjectLiteralExpression, key: string): ts.Expression | null {
  for (const item of node.properties) {
    if (!ts.isPropertyAssignment(item)) continue;
    if (!ts.isStringLiteral(item.name) && !ts.isIdentifier(item.name)) continue;
    if (item.name.text === key) return item.initializer;
  }
  return null;
}

/** Read string-valued package commands from the JSON syntax tree. */
export function readScripts(text: string, file: string): Record<string, string> {
  const source = ts.parseJsonText(file, text);
  const statement = source.statements[0] ?? null;
  if (!statement || !ts.isExpressionStatement(statement) || !ts.isObjectLiteralExpression(statement.expression)) {
    throw new Error(file + " does not contain a package object");
  }
  const scripts = property(statement.expression, "scripts");
  if (scripts === null) return {};
  if (!ts.isObjectLiteralExpression(scripts)) throw new Error(file + " has an invalid scripts object");
  const entries: [string, string][] = [];
  for (const item of scripts.properties) {
    if (!ts.isPropertyAssignment(item) || !ts.isStringLiteral(item.name) || !ts.isStringLiteral(item.initializer)) {
      throw new Error(file + " contains a non-string script");
    }
    entries.push([item.name.text, item.initializer.text]);
  }
  return Object.fromEntries(entries);
}
