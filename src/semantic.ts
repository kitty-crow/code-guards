/** Local zero-shot entailment over token-bounded, overlapping evidence windows. */
export type SimilarityVerdict = {
  sameConcept: number;
  differentConcept: number;
};
type WindowVerdict = SimilarityVerdict & {
  evidence: { windows: number; supportWindow: number; oppositionWindow: number };
};
export type SemanticQuestion = { premise: string; same: string; different: string };
export type SemanticScorer = (question: SemanticQuestion) => Promise<SimilarityVerdict>;

export const MODEL = "Xenova/mobilebert-uncased-mnli";
export const MAX_MODEL_TOKENS = 512;
const TEMPLATE = "The evidence indicates that {}.";
const OVERLAP = 48;
const SAFETY_TOKENS = 8;

type Classification = { labels: string[]; scores: number[] };
type ClassifierOptions = { multi_label: boolean; hypothesis_template: string };
type Tokenizer = {
  encode: (text: string, options: { add_special_tokens: false }) => number[];
  decode: (ids: number[], options: { skip_special_tokens: true }) => string;
};
type Classifier = ((premise: string, labels: string[], options: ClassifierOptions) => Promise<Classification>) & {
  tokenizer: Tokenizer;
};

export type SemanticProgressEvent = "loading" | "ready" | "inference";
let progressObserver: ((event: SemanticProgressEvent) => void) | null = null;
let classifierPromise: Promise<Classifier> | null = null;

/** Observe model activity without changing model scoring or its inference order. */
export function observeSemanticProgress(observer: (event: SemanticProgressEvent) => void): () => void {
  const previous = progressObserver;
  progressObserver = observer;
  return () => { progressObserver = previous; };
}

async function loadClassifier(): Promise<Classifier> {
  progressObserver?.("loading");
  const { env, pipeline } = await import("@huggingface/transformers");
  if ((process.env.CODE_GUARDS_OFFLINE ?? "") === "1") env.allowRemoteModels = false;
  const cache = process.env.CODE_GUARDS_MODEL_CACHE ?? "";
  if (cache) env.cacheDir = cache;
  const classifier = await pipeline("zero-shot-classification", MODEL, { device: "cpu", dtype: "q8" });
  progressObserver?.("ready");
  return classifier;
}

/** Budget the premise after allowing for BOTH hypothesis labels and pair separators. */
export function premiseWindows(question: SemanticQuestion, tokenizer: Tokenizer): string[] {
  const labels = [question.same, question.different];
  const hypothesisLength = Math.max(...labels.map(label =>
    tokenizer.encode(TEMPLATE.replace("{}", label), { add_special_tokens: false }).length
  ));
  // BERT pairs contain [CLS], two [SEP] tokens and possibly tokeniser-added tokens.
  const capacity = MAX_MODEL_TOKENS - hypothesisLength - 3 - SAFETY_TOKENS;
  if (capacity < 48) throw new Error("Zero-shot hypothesis is too long for MobileBERT's 512-token context; shorten the rule labels.");
  const tokens = tokenizer.encode(question.premise, { add_special_tokens: false });
  if (tokens.length <= capacity) return [question.premise];
  const windows: string[] = [];
  const step = Math.max(1, capacity - OVERLAP);
  for (let start = 0; start < tokens.length; start += step) {
    const part = tokens.slice(start, start + capacity);
    windows.push(tokenizer.decode(part, { skip_special_tokens: true }));
    if (start + capacity >= tokens.length) break;
  }
  return windows;
}

function scores(result: Classification, question: SemanticQuestion): SimilarityVerdict {
  const byLabel = new Map(result.labels.map((label, i) => [label, result.scores[i] ?? 0]));
  return {
    sameConcept: byLabel.get(question.same) ?? 0,
    differentConcept: byLabel.get(question.different) ?? 0
  };
}

/** Combine evidence without ignoring contradicting windows or averaging away strong evidence. */
export async function assessWindows(question: SemanticQuestion, classifier: Classifier): Promise<WindowVerdict> {
  const windows = premiseWindows(question, classifier.tokenizer);
  let sameConcept = 0;
  let differentConcept = 0;
  let supportWindow = 0;
  let oppositionWindow = 0;
  for (const [index, premise] of windows.entries()) {
    const result = scores(await classifier(premise, [question.same, question.different], {
      multi_label: true,
      hypothesis_template: TEMPLATE
    }), question);
    progressObserver?.("inference");
    if (result.sameConcept > sameConcept) {
      sameConcept = result.sameConcept;
      supportWindow = index + 1;
    }
    if (result.differentConcept > differentConcept) {
      differentConcept = result.differentConcept;
      oppositionWindow = index + 1;
    }
  }
  return {
    sameConcept,
    differentConcept,
    evidence: { windows: windows.length, supportWindow, oppositionWindow }
  };
}

export async function zeroShot(question: SemanticQuestion): Promise<WindowVerdict> {
  classifierPromise ??= loadClassifier();
  return assessWindows(question, await classifierPromise);
}

export function supportsReuse(verdict: SimilarityVerdict, minimum = 0.78): boolean {
  return verdict.sameConcept >= minimum && verdict.sameConcept >= verdict.differentConcept + 0.12;
}
