import { existsSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

export type Project = {
  program: ts.Program;
  checker: ts.TypeChecker;
  root: string;
  files: readonly ts.SourceFile[];
};

const excludedDirectories = [
  "**/node_modules/**", "**/.git/**", "**/dist/**", "**/build/**",
  "**/coverage/**", "**/.next/**", "**/.cache/**", "**/out/**"
];

function createProject(root: string, names: string[], options: ts.CompilerOptions): Project {
  if (!names.length) throw new Error(`No TypeScript source files found in ${root}. Provide --project with a tsconfig.json if sources are elsewhere.`);
  const program = ts.createProgram({ rootNames: names, options });
  const files = program.getSourceFiles().filter(file => {
    const relative = path.relative(root, file.fileName);
    return !file.isDeclarationFile &&
      !file.fileName.split(/[\\/]/).includes("node_modules") &&
      relative !== ".." && !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative);
  });
  return { program, checker: program.getTypeChecker(), root, files };
}

function configuredProject(filename: string): Project {
  const config = ts.readJsonConfigFile(filename, ts.sys.readFile);
  const parsed = ts.parseJsonSourceFileConfigFileContent(config, ts.sys, path.dirname(filename), {
    noEmit: true
  }, filename);
  if (parsed.errors.length) {
    throw new Error(ts.formatDiagnosticsWithColorAndContext(parsed.errors, {
      getCanonicalFileName: name => name,
      getCurrentDirectory: ts.sys.getCurrentDirectory,
      getNewLine: () => ts.sys.newLine
    }));
  }
  return createProject(path.dirname(filename), parsed.fileNames, parsed.options);
}

function inferredProject(root: string, explicit: string | null = null): Project {
  const names = explicit ? [explicit] : ts.sys.readDirectory(
    root, [".ts", ".tsx", ".mts", ".cts"], excludedDirectories, ["**/*"]
  ).filter(name => !/\.d\.[cm]?ts$/.test(name));
  return createProject(root, names, {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.Preserve,
    strict: true,
    noEmit: true
  });
}

/** Accept a tsconfig, an external directory, or an individual TypeScript source file. */
export function loadProject(target: string): Project {
  const resolved = path.resolve(target);
  if (!existsSync(resolved)) throw new Error(`Target does not exist: ${resolved}. Supply --path <directory> or --project <tsconfig.json>.`);
  const file = statSync(resolved);
  if (file.isDirectory()) {
    const config = path.join(resolved, "tsconfig.json");
    return existsSync(config) ? configuredProject(config) : inferredProject(resolved);
  }
  if (/tsconfig[^/\\]*\.json$/i.test(resolved)) return configuredProject(resolved);
  if (/\.[cm]?tsx?$/.test(resolved) && !/\.d\.[cm]?ts$/.test(resolved)) return inferredProject(path.dirname(resolved), resolved);
  throw new Error(`Unsupported target: ${resolved}. Expected a directory, tsconfig*.json, or a .ts/.tsx/.mts/.cts source file.`);
}
