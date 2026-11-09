import { loadProject } from "./project.ts";
import { noNestedIf } from "./guards/no-nested-if.ts";
import { typeReuse } from "./guards/type-reuse.ts";
import { functionQuality } from "./guards/function-quality.ts";
import { codeHealth } from "./guards/code-health.ts";
import { crossModule } from "./guards/cross-module.ts";
import { documentation } from "./guards/documentation.ts";
import { repoHygiene } from "./guards/repo-hygiene.ts";
import type { Finding, GuardName } from "./model.ts";

export type AnalysisOptions = { enabled: Set<GuardName>; project: string; includeTests: boolean };
export type Analysis = { findings: Finding[]; root: string };

export async function analyse(config: AnalysisOptions): Promise<Analysis> {
  const project = loadProject(config.project);
  const findings: Finding[] = [
    ...(config.enabled.has("no-nested-if") ? noNestedIf(project) : []),
    ...(config.enabled.has("type-reuse") ? await typeReuse(project, config.includeTests) : []),
    ...(config.enabled.has("function-quality") ? await functionQuality(project, config.includeTests) : []),
    ...codeHealth(project, config.includeTests).filter(item => config.enabled.has(item.guard)),
    ...crossModule(project).filter(item => config.enabled.has(item.guard)),
    ...(config.enabled.has("documentation") ? await documentation(project) : []),
    ...(config.enabled.has("repo-hygiene") ? repoHygiene(project.root) : [])
  ];
  return { findings, root: project.root };
}
