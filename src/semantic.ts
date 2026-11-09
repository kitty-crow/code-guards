/** Real zero-shot entailment, executed locally by Transformers.js (CPU/ONNX). */
export type SimilarityVerdict = { sameConcept: number; differentConcept: number };
export type SemanticQuestion = { premise: string; same: string; different: string };
export type SemanticScorer = (question: SemanticQuestion) => Promise<SimilarityVerdict>;

export const MODEL = "Xenova/mobilebert-uncased-mnli";
const MODEL_PACKAGE = "@huggingface/transformers";

type Classification = { labels: string[]; scores: number[] };
type Classifier = (
  premise: string,
  labels: string[],
  options: { multi_label: boolean; hypothesis_template: string }
) => Promise<Classification>;

let classifierPromise: Promise<Classifier> | undefined;

async function loadClassifier(): Promise<Classifier> {
  // Lazy loading: syntax-only guards never download a model. Semantic guards do.
  // Dynamic import deliberately keeps the package independent of Bun-specific APIs.
  const transformers = await import(MODEL_PACKAGE) as {
    pipeline: (task: string, model: string, options: { device: "cpu"; dtype: "q8" }) => Promise<Classifier>;
    env: { allowRemoteModels: boolean; cacheDir: string };
  };
  if (process.env.CODE_GUARDS_OFFLINE === "1") transformers.env.allowRemoteModels = false;
  if (process.env.CODE_GUARDS_MODEL_CACHE) transformers.env.cacheDir = process.env.CODE_GUARDS_MODEL_CACHE;
  return transformers.pipeline("zero-shot-classification", MODEL, { device: "cpu", dtype: "q8" });
}

export async function zeroShot(question: SemanticQuestion): Promise<SimilarityVerdict> {
  classifierPromise ??= loadClassifier();
  const classifier = await classifierPromise;
  const result = await classifier(question.premise, [question.same, question.different], {
    multi_label: true,
    hypothesis_template: "The evidence indicates that {}."
  });
  const scores = new Map(result.labels.map((label, i) => [label, result.scores[i] ?? 0]));
  return {
    sameConcept: scores.get(question.same) ?? 0,
    differentConcept: scores.get(question.different) ?? 0
  };
}

export function supportsReuse(verdict: SimilarityVerdict, minimum = 0.78): boolean {
  return verdict.sameConcept >= minimum && verdict.sameConcept >= verdict.differentConcept + 0.12;
}
