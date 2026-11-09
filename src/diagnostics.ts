import { readFileSync } from "node:fs";
import path from "node:path";
import type { Finding, Location } from "./model.ts";

export type Format = "text" | "json" | "github";
export type ColourMode = "auto" | "always" | "never";
export type ReportOptions = { root: string; format: Format; colour: ColourMode; isTTY?: boolean };

const ansi = {
  yellow: "\u001b[33m",
  bold: "\u001b[1m",
  cyan: "\u001b[36m",
  dim: "\u001b[2m",
  reset: "\u001b[0m"
} as const;

function coloursEnabled(config: ReportOptions): boolean {
  if (config.colour === "never" || "NO_COLOR" in process.env) return false;
  if (config.colour === "always") return true;
  if (process.env.FORCE_COLOR === "0" || process.env.TERM === "dumb") return false;
  return config.isTTY ?? Boolean(process.stdout.isTTY || process.env.FORCE_COLOR);
}

function paint(text: string, colour: keyof typeof ansi, enabled: boolean): string {
  return enabled ? `${ansi[colour]}${text}${ansi.reset}` : text;
}

function escapeAnnotation(value: string): string {
  return value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A").replace(/:/g, "%3A").replace(/,/g, "%2C");
}

function previewLine(text: string, column: number): { text: string; indent: number } {
  const visual = text.replace(/\t/g, "    ");
  const position = text.slice(0, Math.max(0, column - 1)).replace(/\t/g, "    ").length;
  const left = Math.max(0, position - 66);
  const prefix = left > 0 ? "…" : "";
  const slice = visual.slice(left, left + 124);
  const suffix = visual.length > left + 124 ? "…" : "";
  return { text: prefix + slice + suffix, indent: prefix.length + position - left };
}

function excerpt(root: string, location: Location, span: number | undefined, colour: boolean): string[] {
  let lines: string[];
  try {
    lines = readFileSync(path.resolve(root, location.file), "utf8").split(/\r?\n/);
  } catch {
    return [];
  }
  if (!lines[location.line - 1]) return [];
  const first = Math.max(1, location.line - 1);
  const last = Math.min(lines.length, location.line + 1);
  const width = String(last).length;
  const results: string[] = [];
  for (let line = first; line <= last; line += 1) {
    const selected = line === location.line;
    const original = lines[line - 1] ?? "";
    const preview = previewLine(original, selected ? location.column : 1);
    const code = `${selected ? ">" : " "} ${String(line).padStart(width)} │ ${preview.text}`;
    results.push(`    ${selected ? paint(code, "yellow", colour) : paint(code, "dim", colour)}`);
    if (selected) {
      const length = Math.max(1, Math.min(span ?? 1, 120 - preview.indent));
      const pointer = `${" ".repeat(width + 3)}│ ${" ".repeat(Math.max(0, preview.indent))}${"^".repeat(length)}`;
      results.push(`    ${paint(pointer, "yellow", colour)}`);
    }
  }
  return results;
}

function wrapText(value: string, width = 105): string[] {
  const lines: string[] = [];
  for (const paragraph of value.split("\n")) {
    if (paragraph.startsWith("  ")) { lines.push(paragraph); continue; }
    let current = "";
    for (const word of paragraph.split(/\s+/)) {
      if (current.length > 0 && current.length + word.length + 1 > width) {
        lines.push(current);
        current = word;
        continue;
      }
      current = current ? `${current} ${word}` : word;
    }
    lines.push(current);
  }
  return lines;
}

function detail(label: string, value: string | undefined, colour: boolean): string[] {
  if (!value) return [];
  const lines = wrapText(value);
  const header = paint(label.padEnd(7), label === "Fix" ? "cyan" : "dim", colour);
  return lines.map((line, index) => `    ${index === 0 ? header : "      "}${line}`);
}

function plainReport(findings: Finding[], config: ReportOptions): string {
  const colour = coloursEnabled(config);
  const result: string[] = [];
  for (const [index, finding] of findings.entries()) {
    const { file, line, column } = finding.location;
    const confidence = finding.similarity === undefined ? "" : `  ·  ${Math.round(finding.similarity * 100)}% match`;
    result.push("");
    result.push(`  ${paint("⚠ WARNING", "yellow", colour)}  ${paint(finding.code, "bold", colour)}  ${finding.message}${confidence}`);
    result.push(`    ${paint(`${file}:${line}:${column}`, "cyan", colour)}  ${paint(`[${finding.guard}]`, "dim", colour)}`);
    result.push("");
    if (finding.code !== "CG318") result.push(...excerpt(config.root, finding.location, finding.span, colour));
    result.push(...detail(finding.code === "CG318" ? "Path" : "Clause", finding.subject, colour));
    result.push("");
    result.push(...detail("Why", finding.reason, colour));
    result.push(...detail("Fix", finding.suggestion, colour));
    if (finding.related) {
      result.push(`    ${paint("See", "dim", colour)}   ${finding.related.file}:${finding.related.line}:${finding.related.column}`);
      result.push(...excerpt(config.root, finding.related, finding.relatedSpan, colour));
    }
    if (index < findings.length - 1) result.push(paint("  " + "─".repeat(68), "dim", colour));
  }
  const count = findings.filter(finding => finding.severity === "warning").length;
  const summary = `${findings.length} finding(s): ${count} warning(s).`;
  result.push("");
  result.push(`  ${count ? paint(summary, "yellow", colour) : summary}`);
  result.push("");
  return result.join("\n");
}

export function renderFindings(findings: Finding[], config: ReportOptions): string {
  if (config.format === "json") return JSON.stringify(findings, null, 2);
  if (config.format === "text") return plainReport(findings, config);
  return findings.map(finding => {
    const { file, line, column } = finding.location;
    const value = [finding.message, finding.reason, finding.suggestion].filter(Boolean).join(" | ");
    const level = finding.severity === "warning" ? "warning" : "notice";
    return `::${level} file=${escapeAnnotation(file)},line=${line},col=${column},title=${escapeAnnotation(finding.code)}::${escapeAnnotation(value)}`;
  }).join("\n");
}
