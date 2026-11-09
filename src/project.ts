import path from "node:path";
import ts from "typescript";

export type Project = {
  program: ts.Program;
  checker: ts.TypeChecker;
  root: string;
  files: readonly ts.SourceFile[];
};

export function loadProject(configFile: string): Project {
  const filename = path.resolve(configFile);
  const config = ts.readConfigFile(filename, ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));

  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(filename), {
    noEmit: true
  }, filename);
  if (parsed.errors.length) {
    throw new Error(ts.formatDiagnosticsWithColorAndContext(parsed.errors, {
      getCanonicalFileName: name => name,
      getCurrentDirectory: ts.sys.getCurrentDirectory,
      getNewLine: () => ts.sys.newLine
    }));
  }

  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
  const files = program.getSourceFiles().filter(file =>
    !file.isDeclarationFile &&
    !file.fileName.split(/[\\/]/).includes("node_modules")
  );

  return { program, checker: program.getTypeChecker(), root: path.dirname(filename), files };
}
