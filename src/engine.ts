import { loadProject } from "./project.ts";
import {
  noNestedIf, typeReuse, functionQuality, moduleCohesion, codeHealth, crossModule,
  documentation, repoHygiene, enterpriseLookingNaming, reviewPractices
} from "./guards/index.ts";
import { guards, resolveExpectations, type Finding, type GuardName } from "./model.ts";
import { observeSemanticProgress, observeSemanticTimings, semanticExecutionProvider } from "./semantic.ts";

export type AnalysisOptions = {
  enabled: Set<GuardName>;
  project: string;
  includeTests: boolean;
};
export type Analysis = { findings: Finding[]; root: string };

/** Structured, opt-in events consumed by the hard-stop throughput supervisor. */
export type ScanTelemetry =
  | { type: "project"; files: number; rules: number }
  | { type: "stage-start"; stage: string; index: number; total: number }
  | { type: "stage-complete"; stage: string; index: number; findings: number }
  | { type: "model-ready"; device: string }
  | { type: "inference"; windows: number; gpuId?: number; questions?: number }
  | { type: "verdict"; windows: number }
  | { type: "cache-hit" }
  | { type: "provider-proof"; gpuId: number; gpuNodes: number; cpuNodes: number;
      gpuOps: string[]; gpuTimeMs: number; cpuTimeMs: number };

type Stage = {
  name: string;
  includes: readonly GuardName[];
  run: () => Finding[] | Promise<Finding[]>;
};

const codeHealthGuards: readonly GuardName[] = [
  "dead-code", "simplify-code", "async-safety", "type-assertions", "state-exhaustiveness",
  "responsibility", "overengineering", "naming", "coupling", "function-contracts",
  "derived-state", "test-quality", "incomplete-implementation"
];
const crossModuleGuards: readonly GuardName[] = ["single-source", "project-conventions"];

/** Run every selected rule and report stage-level progress independently of the findings format. */
export async function analyse(
  config: AnalysisOptions,
  report: (message: string) => void = () => {},
  telemetry: (event: ScanTelemetry) => void = () => {}
): Promise<Analysis> {
  const started = Date.now();
  report("[Code Guards] Loading TypeScript project");
  const project = loadProject(config.project);
  const selected = guards.filter(name => config.enabled.has(name));
  report(`[Code Guards] Loaded ${project.files.length} source files; ${selected.length} rules enabled`);
  telemetry({ type: "project", files: project.files.length, rules: selected.length });

  const stages: Stage[] = [
    {name: "no-nested-if", includes: ["no-nested-if"], run: () => noNestedIf(project)},
    {name: "type-reuse", includes: ["type-reuse"], run: () => typeReuse(project, config.includeTests)},
    {name: "function-quality", includes: ["function-quality"], run: () => functionQuality(project, config.includeTests)},
    {name: "module-cohesion", includes: ["module-cohesion"], run: () => moduleCohesion(project, config.includeTests)},
    {name: "code-health (13 rules)", includes: codeHealthGuards, run: () =>
      codeHealth(project, config.includeTests).filter(item => config.enabled.has(item.guard))},
    {name: "cross-module (2 rules)", includes: crossModuleGuards, run: () =>
      crossModule(project).filter(item => config.enabled.has(item.guard))},
    {name: "documentation", includes: ["documentation"], run: () => documentation(project)},
    {name: "repo-hygiene", includes: ["repo-hygiene"], run: () => repoHygiene(project.root)},
    {name: "enterprise-looking-naming", includes: ["enterprise-looking-naming"], run: () =>
      enterpriseLookingNaming(project, config.includeTests)},
    {name: "review-practices", includes: ["review-practices"], run: () =>
      reviewPractices(project, config.includeTests)}
  ];
  const enabledStages = stages.filter(stage => stage.includes.some(name => config.enabled.has(name)));
  const findings: Finding[] = [];
  let activeStage = "initialisation";
  let semanticWindows = 0;
  let stageWindows = 0;
  let lastWindowReport = 0;
  let lastReportAt = Date.now();
  const restore = observeSemanticProgress(event => {
    if (event === "loading") { report(`[Code Guards] ${activeStage}: loading MobileBERT model`); return; }
    if (event === "ready") {
      const device = semanticExecutionProvider().device;
      report(`[Code Guards] ${activeStage}: MobileBERT ready (${device})`);
      telemetry({ type: "model-ready", device });
      return;
    }
    semanticWindows += 1;
    const now = Date.now();
    if (semanticWindows - lastWindowReport >= 25 || now - lastReportAt >= 10000) {
      report(`[Code Guards] ${activeStage}: ${semanticWindows - stageWindows} inference windows; ${((now - lastReportAt) / 1000).toFixed(1)}s since last update`);
      lastWindowReport = semanticWindows;
      lastReportAt = now;
    }
  });

  const restoreTimings = observeSemanticTimings(event => {
    if (event.phase === "inference") {
      telemetry({ type: "inference", windows: event.batchSize,
        ...(event.gpuId === undefined ? {} : { gpuId: event.gpuId }),
        ...(event.distinctQuestions === undefined ? {} : { questions: event.distinctQuestions }) });
    }
    if (event.phase === "provider-proof" && event.gpuId !== undefined) {
      telemetry({ type: "provider-proof", gpuId: event.gpuId, gpuNodes: event.gpuNodes,
        cpuNodes: event.cpuNodes, gpuOps: event.gpuOps,
        gpuTimeMs: event.gpuTimeMs, cpuTimeMs: event.cpuTimeMs });
    }
    if (event.phase === "verdict") telemetry({ type: "verdict", windows: event.windows });
    if (event.phase === "cache-hit") telemetry({ type: "cache-hit" });
  });

  try {
    for (const [index, stage] of enabledStages.entries()) {
      activeStage = stage.name;
      const before = Date.now();
      stageWindows = semanticWindows;
      lastWindowReport = semanticWindows;
      lastReportAt = before;
      report(`[Code Guards] [${index + 1}/${enabledStages.length}] ${stage.name}: started`);
      telemetry({ type: "stage-start", stage: stage.name, index: index + 1, total: enabledStages.length });
      const results = await stage.run();
      findings.push(...results);
      telemetry({ type: "stage-complete", stage: stage.name, index: index + 1, findings: results.length });
      report(`[Code Guards] [${index + 1}/${enabledStages.length}] ${stage.name}: ${results.length} findings, ${semanticWindows - stageWindows} inference windows, ${((Date.now() - before) / 1000).toFixed(1)}s`);
    }
  } finally {
    restoreTimings();
    restore();
  }
  const resolved = resolveExpectations(project.root, project.files, findings);
  report(`[Code Guards] Completed: ${resolved.length} findings in ${((Date.now() - started) / 1000).toFixed(1)}s, ${semanticWindows} inference windows`);
  return { findings: resolved, root: project.root };
}
