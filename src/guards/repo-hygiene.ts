import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { Finding } from "../model.ts";
import { readScripts } from "../scripts.ts";

export function repoHygiene(root: string): Finding[] {
  const findings: Finding[] = [];
  type HygieneIssue = {code: string; file: string; line: number; message: string; subject: string; reason: string; suggestion: string};
  const add = ({code, file, line, message, subject, reason, suggestion}: HygieneIssue): void => {
    findings.push({guard: "repo-hygiene", severity: "warning", code, message, location: {file, line, column: 1}, subject, span: Math.min(subject.length, 100), reason, suggestion});
  };
  const file = path.join(root, "package.json");
  if (!existsSync(file)) return findings;
  const text = readFileSync(file, "utf8");
  let scripts: Record<string, string>;
  try { scripts = readScripts(text, file); }
  catch { return findings; }
  const entries = Object.entries(scripts);
  for (const [i, [name, value]] of entries.entries()) {
    if (!/(?:test|ci|check)/i.test(name)) continue;
    const commands = value.split(/\s*&&\s*|\s*;\s*/).map(x => x.trim()).filter(Boolean);
    const repeats = commands.filter((x, j) => commands.indexOf(x) !== j);
    if (repeats.length) {
      const line = text.slice(0, text.indexOf(`"${name}"`)).split("\n").length;
      add({code: "CG501", file: "package.json", line: line, message: "Build or test step executes redundantly", subject: name, reason: `The ${name} script runs ${[...new Set(repeats)].join(", ")} more than once in a single execution.`, suggestion: "Remove repeated commands so local CI performs each distinct check once."});
    }
    for (const [otherName, otherCommand] of entries.slice(i + 1)) {
      if (value !== otherCommand || !/(?:test|ci|check)/i.test(otherName)) continue;
      const line = text.slice(0, text.indexOf(`"${otherName}"`)).split("\n").length;
      add({code: "CG502", file: "package.json", line: line, message: "Two CI/test scripts execute identical commands", subject: otherName, reason: `Scripts ${name} and ${otherName} contain identical commands.`, suggestion: `Use a documented alias or consolidate the two scripts if they do not serve different audiences.`});
    }
  }
  // Catch the specific source/dist double-run pattern without claiming every dual test is redundant.
  const bunfig = path.join(root, "bunfig.toml");
  const tests = Object.entries(scripts).filter(([name, cmd]) => /(?:^|:)test|(?:^|:)ci/.test(name) && /\bbun test\b/.test(cmd));
  const buildConfig = path.join(root, "tsconfig.build.json");
  const config = existsSync(buildConfig) ? readFileSync(buildConfig, "utf8") : "";
  if (tests.length && !existsSync(bunfig) && /"outDir"\s*:\s*"dist"/.test(config) && /"test\//.test(config)) {
    add({code: "CG503", file: "package.json", line: 1, message: "Bun may execute compiled tests twice", subject: "bun test", reason: "The project emits compiled tests under dist/ and does not restrict Bun test discovery. Both source and compiled tests may execute.", suggestion: 'Set [test] root = "test" in bunfig.toml or exclude dist/ from test discovery.'});
  }
  const workflowDir = path.join(root, ".github", "workflows");
  if (!existsSync(workflowDir)) return findings;
  const workflows = readdirSync(workflowDir).filter(x => /\.ya?ml$/i.test(x));
  const signatures = new Map<string, string>();
  for (const workflow of workflows) {
    const content = readFileSync(path.join(workflowDir, workflow), "utf8");
    const commands = [...content.matchAll(/^\s*-\s*run:\s*(.+)$/gm)].map(match => (match[1] ?? "").trim());
    for (const command of commands) {
      if (!/(?:test|ci|check|lint)/i.test(command) || command.length < 10) continue;
      const prior = signatures.get(command) ?? null;
      if (!prior) { signatures.set(command, workflow); continue; }
      const pos = content.indexOf(command);
      add({code: "CG504", file: `.github/workflows/${workflow}`, line: content.slice(0, pos).split("\n").length, message: "Same CI command runs in multiple workflows", subject: command, reason: `${workflow} and ${prior} both execute ${command}, potentially duplicating hosted work.`, suggestion: "Decide whether both triggers are necessary; reuse one job or run the check locally where appropriate."});
    }
  }
  return findings;
}
