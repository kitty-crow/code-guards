import { existsSync, readFileSync, statSync } from "node:fs";
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
  "**/coverage/**", "**/.next/**", "**/.cache/**", "**/out/**",
  "**/vendor/**", "**/third_party/**", "**/third-party/**"
];

const vendoredDirectoryNames = new Set(["vendor", "third_party", "third-party"]);

/** Read pinned Git submodule paths so nonstandard vendor locations are excluded. */
export function vendoredPaths(root: string): ReadonlySet<string> {
  const filename = path.join(root, ".gitmodules");
  const paths = new Set<string>();
  if (!existsSync(filename)) return paths;
  for (const match of readFileSync(filename, "utf8").matchAll(/^\s*path\s*=\s*(.+?)\s*$/gm)) {
    const relative = (match[1] ?? "").trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
    if (!relative || path.posix.isAbsolute(relative) || relative.split("/").includes("..")) continue;
    paths.add(relative);
  }
  return paths;
}

/** Never inspect vendored sources, even when they match an explicit tsconfig glob. */
export function isVendoredPath(root: string, filename: string, submodules: ReadonlySet<string>): boolean {
  const relative = path.relative(root, filename).replace(/\\/g, "/");
  if (relative === ".." || relative.startsWith("../") || path.posix.isAbsolute(relative)) return false;
  return relative.split("/").some(name => vendoredDirectoryNames.has(name)) ||
    [...submodules].some(prefix => relative === prefix || relative.startsWith(prefix + "/"));
}

function createProject(root: string, names: string[], options: ts.CompilerOptions): Project {
  const submodules = vendoredPaths(root);
  const projectNames = names.filter(filename => !isVendoredPath(root, filename, submodules));
  if (!projectNames.length) throw new Error(`No TypeScript source files found in ${root}. Provide --project with a tsconfig.json if sources are elsewhere.`);
  const program = ts.createProgram({ rootNames: projectNames, options });
  const files = program.getSourceFiles().filter(file => {
    const relative = path.relative(root, file.fileName);
    return !file.isDeclarationFile &&
      !file.fileName.split(/[\\/]/).includes("node_modules") &&
      !isVendoredPath(root, file.fileName, submodules) &&
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

/** Recognise test directories and conventional dot, underscore or hyphen test suffixes. */
export function isTestFile(filename: string): boolean {
  return /(?:^|[\\/])(?:test|tests|__tests__)[\\/]|[._-](?:test|spec)\.[cm]?tsx?$/i.test(filename);
}
