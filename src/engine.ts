import { loadProject } from "./project.ts";
import {
  noNestedIf, typeReuse, functionQuality, codeHealth, crossModule,
  documentation, repoHygiene, enterpriseLookingNaming, reviewPractices
} from "./guards/index.ts";
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
    ...(config.enabled.has("repo-hygiene") ? repoHygiene(project.root) : []),
    ...(config.enabled.has("enterprise-looking-naming") ? enterpriseLookingNaming(project, config.includeTests) : []),
    ...(config.enabled.has("review-practices") ? reviewPractices(project, config.includeTests) : [])
  ];
  return { findings, root: project.root };
}
