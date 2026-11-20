/** Local zero-shot entailment over token-bounded, overlapping evidence windows. */
import { NO_ACCELERATION, type AccelerationConfig } from "./acceleration.ts";
export type SimilarityVerdict = {
  sameConcept: number;
  differentConcept: number;
};
type WindowVerdict = SimilarityVerdict & {
  evidence: { windows: number; supportWindow: number; oppositionWindow: number };
};
export type SemanticQuestion = { premise: string; same: string; different: string };
export type SemanticScorer = (question: SemanticQuestion) => Promise<SimilarityVerdict>;

/** Completed inference phases, measured using a monotonic clock. */
export type SemanticTimingEvent =
  | { phase: "model-load"; milliseconds: number }
  | { phase: "windowing"; milliseconds: number; windows: number }
  | { phase: "inference"; milliseconds: number; window: number; windows: number; batchSize: number }
  | { phase: "cache-hit"; milliseconds: number };

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
  classifyBatch?: (premises: string[], labels: string[], options: ClassifierOptions) => Promise<Classification[]>;
};

export type SemanticProgressEvent = "loading" | "ready" | "inference";
let progressObserver: (event: SemanticProgressEvent) => void = () => {};
let timingObserver: ((event: SemanticTimingEvent) => void) | null = null;
let classifierPromise: Promise<Classifier> | null = null;
let acceleration: AccelerationConfig = NO_ACCELERATION;
let activeDevice: "cpu" | "webgpu" | "cuda" = "cpu";
const cache = new Map<string, Promise<WindowVerdict>>();

/** Settings are scoped to the current scan; no inference engine changes on import. */
export function configureSemanticAcceleration(config: AccelerationConfig): () => void {
  const previous = acceleration;
  acceleration = config;
  classifierPromise = null;
  activeDevice = "cpu";
  cache.clear();
  return () => {
    acceleration = previous;
    classifierPromise = null;
    activeDevice = "cpu";
    cache.clear();
  };
}

export function semanticExecutionProvider(): { device: "cpu" | "cuda" | "webgpu"; precision: "q8" | "fp32" } {
  return { device: activeDevice, precision: activeDevice === "cpu" ? "q8" : "fp32" };
}

function isClassification(value: unknown): value is Classification {
  if (typeof value !== "object" || value === null) return false;
  if (!("labels" in value) || !("scores" in value)) return false;
  return Array.isArray(value.labels) && value.labels.every(item => typeof item === "string") &&
    Array.isArray(value.scores) && value.scores.every(item => typeof item === "number");
}

/** Temporarily observe timing data without modifying semantic scores or inference order. */
export function observeSemanticTimings(observer: (event: SemanticTimingEvent) => void): () => void {
  const previous = timingObserver;
  timingObserver = observer;
  return () => { timingObserver = previous; };
}

/** Observe model activity without changing model scoring or its inference order. */
export function observeSemanticProgress(observer: (event: SemanticProgressEvent) => void): () => void {
  const previous = progressObserver;
  progressObserver = observer;
  return () => { progressObserver = previous; };
}

async function loadClassifier(): Promise<Classifier> {
  const started = performance.now();
  progressObserver("loading");
  const { env, pipeline } = await import("@huggingface/transformers");
  if ((process.env.CODE_GUARDS_OFFLINE ?? "") === "1") env.allowRemoteModels = false;
  const modelCache = process.env.CODE_GUARDS_MODEL_CACHE ?? "";
  if (modelCache) env.cacheDir = modelCache;

  const chosen = [...acceleration.features].filter(
    (feature): feature is "cuda" | "webgpu" => feature === "cuda" || feature === "webgpu"
  );
  const devices: ("cpu" | "cuda" | "webgpu")[] = chosen.length ? chosen : ["cpu"];
  const failures: string[] = [];
  for (const device of devices) {
    try {
      const classifier = await pipeline("zero-shot-classification", MODEL, {
        device, dtype: device === "cpu" ? "q8" : "fp32"
      });
      const single = async (premise: string, labels: string[], options: ClassifierOptions): Promise<Classification> => {
        const result: unknown = await classifier(premise, labels, options);
        if (!isClassification(result)) throw new Error("Invalid MobileBERT classification.");
        return result;
      };
      const classifyBatch = async (premises: string[], labels: string[], options: ClassifierOptions): Promise<Classification[]> => {
        const results: unknown = await classifier(premises, labels, options);
        if (!Array.isArray(results) || results.length !== premises.length || !results.every(isClassification)) {
          throw new Error("Invalid MobileBERT batch result.");
        }
        return results;
      };
      activeDevice = device;
      timingObserver?.({ phase: "model-load", milliseconds: performance.now() - started });
      progressObserver("ready");
      return Object.assign(single, { tokenizer: classifier.tokenizer, classifyBatch });
    } catch (error) {
      failures.push(device + ": " + (error instanceof Error ? error.message : String(error)));
    }
  }
  throw new Error("No requested MobileBERT provider could initialise. " + failures.join("; "));
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
export async function assessWindows(question: SemanticQuestion, classifier: Classifier, batchSize = 1): Promise<WindowVerdict> {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 16) {
    throw new Error("Inference batch size must be between 1 and 16.");
  }
  const windowingStarted = performance.now();
  const windows = premiseWindows(question, classifier.tokenizer);
  timingObserver?.({ phase: "windowing", milliseconds: performance.now() - windowingStarted, windows: windows.length });
  let sameConcept = 0;
  let differentConcept = 0;
  let supportWindow = 0;
  let oppositionWindow = 0;
  for (let offset = 0; offset < windows.length; offset += batchSize) {
    const group = windows.slice(offset, offset + batchSize);
    const labels = [question.same, question.different];
    const options: ClassifierOptions = { multi_label: true, hypothesis_template: TEMPLATE };
    const started = performance.now();
    const results = group.length === 1
      ? [await classifier(group[0] ?? "", labels, options)]
      : await classifyGroup(classifier, group, labels, options);
    timingObserver?.({
      phase: "inference", milliseconds: performance.now() - started,
      window: offset + 1, windows: windows.length, batchSize: group.length
    });
    for (const [index, classification] of results.entries()) {
      const result = scores(classification, question);
      progressObserver("inference");
      if (result.sameConcept > sameConcept) {
        sameConcept = result.sameConcept;
        supportWindow = offset + index + 1;
      }
      if (result.differentConcept > differentConcept) {
        differentConcept = result.differentConcept;
        oppositionWindow = offset + index + 1;
      }
    }
  }
  return {
    sameConcept,
    differentConcept,
    evidence: { windows: windows.length, supportWindow, oppositionWindow }
  };
}

async function classifyGroup(
  classifier: Classifier, premises: string[], labels: string[], options: ClassifierOptions
): Promise<Classification[]> {
  if (!classifier.classifyBatch) throw new Error("MobileBERT runtime does not support batched input.");
  return classifier.classifyBatch(premises, labels, options);
}

export async function zeroShot(question: SemanticQuestion): Promise<WindowVerdict> {
  const enabled = acceleration.features.has("cache");
  const key = enabled ? JSON.stringify([MODEL, question.premise, question.same, question.different]) : "";
  const previous = enabled ? cache.get(key) : undefined;
  if (previous) {
    timingObserver?.({ phase: "cache-hit", milliseconds: 0 });
    return previous;
  }
  const compute = async (): Promise<WindowVerdict> => {
    classifierPromise ??= loadClassifier();
    return assessWindows(question, await classifierPromise, acceleration.features.has("batch") ? acceleration.batchSize : 1);
  };
  const promise = compute();
  if (!enabled) return promise;
  if (cache.size >= 512) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, promise);
  try { return await promise; }
  catch (error) {
    if (cache.get(key) === promise) cache.delete(key);
    throw error;
  }
}

export function supportsReuse(verdict: SimilarityVerdict, minimum = 0.78): boolean {
  return verdict.sameConcept >= minimum && verdict.sameConcept >= verdict.differentConcept + 0.12;
}
