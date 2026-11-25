/** Local zero-shot entailment over token-bounded, overlapping evidence windows. */
import { NO_ACCELERATION, type AccelerationConfig } from "./acceleration.ts";
export type SimilarityVerdict = {
  sameConcept: number;
  differentConcept: number;
};
export type WindowVerdict = SimilarityVerdict & {
  evidence: { windows: number; supportWindow: number; oppositionWindow: number };
};
export type NliLogits = { entailment: number; neutral: number; contradiction: number };
export type RawNliWindow = {
  window: number;
  logits: { support: NliLogits; opposition: NliLogits } | null;
};
export type NativeWindowVerdict = WindowVerdict & { rawEvidence: RawNliWindow[] };
type PlainQuestion = { premise: string; same: string; different: string };
export type ComparisonSide = { name: string; evidence: string };
export type ComparisonQuestion = PlainQuestion & { comparison: { left: ComparisonSide; right: ComparisonSide } };
export type SemanticQuestion = PlainQuestion | ComparisonQuestion;

/** Retain both sides of a relational question for token-bounded comparisons. */
export function comparisonQuestion(question: PlainQuestion, left: ComparisonSide, right: ComparisonSide): ComparisonQuestion {
  return {...question, comparison: {left, right}};
}

export function semanticQuestionKey(question: SemanticQuestion): string {
  const base = [MODEL, question.premise, question.same, question.different];
  return JSON.stringify("comparison" in question ? [...base, "paired-v1", question.comparison] : base);
}
export type SemanticScorer = (question: SemanticQuestion) => Promise<SimilarityVerdict>;

/** Completed inference phases, measured using a monotonic clock. */
export type SemanticTimingEvent =
  | { phase: "model-load"; milliseconds: number }
  | { phase: "windowing"; milliseconds: number; windows: number }
  | { phase: "inference"; milliseconds: number; window: number; windows: number; batchSize: number; gpuId: number | null; distinctQuestions: number }
  | { phase: "cache-hit"; milliseconds: number }
  | { phase: "verdict"; milliseconds: number; windows: number }
  | { phase: "provider-proof"; milliseconds: number; gpuNodes: number; cpuNodes: number;
      gpuOps: string[]; gpuTimeMs: number; cpuTimeMs: number; gpuId: number | null };

export const MODEL = "Xenova/mobilebert-uncased-mnli";
export const MAX_MODEL_TOKENS = 512;
const TEMPLATE = "The evidence indicates that {}.";
const OVERLAP = 48;
const SAFETY_TOKENS = 8;

type Classification = { labels: string[]; scores: number[] };
type ClassifierOptions = { multi_label: boolean; hypothesis_template: string };
export type Tokenizer = {
  encode: (text: string, options: { add_special_tokens: false }) => number[];
  decode: (ids: number[], options: { skip_special_tokens: true }) => string;
};
export type Classifier = ((premise: string, labels: string[], options: ClassifierOptions) => Promise<Classification>) & {
  tokenizer: Tokenizer;
  classifyBatch: ((premises: string[], labels: string[], options: ClassifierOptions) => Promise<Classification[]>) | null;
};

export type SemanticProgressEvent = "loading" | "ready" | "inference";
let progressObserver: (event: SemanticProgressEvent) => void = () => {};
let timingObserver: (event: SemanticTimingEvent) => void = () => {};
let classifierPromise: Promise<Classifier> | null = null;
let disposeClassifier: (() => Promise<void>) | null = null;
const pendingLocal = new Set<Promise<WindowVerdict>>();
let closingClassifier = false;
let questionBatcher: ReturnType<typeof createQuestionBatcher> | null = null;
let acceleration: AccelerationConfig = NO_ACCELERATION;
let activeDevice: "cpu" | "webgpu" | "cuda" | "dml" = "cpu";
let nativeCpu = false;
const cache = new Map<string, Promise<WindowVerdict>>();
let remoteScorer: ((question: SemanticQuestion) => Promise<WindowVerdict>) | null = null;

/** Replace local scoring only while an explicitly selected external GPU pool is active. */
export function useRemoteSemanticScorer(
  scorer: (question: SemanticQuestion) => Promise<WindowVerdict>
): () => void {
  const previous = remoteScorer;
  remoteScorer = scorer;
  return () => { remoteScorer = previous; };
}

/** Forward real worker telemetry to the existing scan progress observers. */
export function relaySemanticWorkerEvent(event: { type: "loading" | "ready"; gpuId: number; backend: "cuda" | "dml" | "webgpu" | "cpu" } |
  { type: "timing"; gpuId: number; timing: SemanticTimingEvent }): void {
  if (event.type === "loading") progressObserver("loading");
  if (event.type === "ready") {
    activeDevice = event.backend ?? (process.platform === "win32" ? "dml" : "cuda");
    nativeCpu = event.backend === "cpu";
    progressObserver("ready");
  }
  if (event.type === "timing") {
    timingObserver(event.timing);
  }
  if (event.type === "timing" && event.timing.phase === "inference") {
    for (let index = 0; index < event.timing.batchSize; index += 1) progressObserver("inference");
  }
}

/** Settings are scoped to the current scan; no inference engine changes on import. */
export function configureSemanticAcceleration(config: AccelerationConfig): () => void {
  const previous = acceleration;
  acceleration = config;
  classifierPromise = null;
  questionBatcher = null;
  activeDevice = "cpu";
  nativeCpu = false;
  cache.clear();
  return () => {
    acceleration = previous;
    classifierPromise = null;
    questionBatcher = null;
    activeDevice = "cpu";
    nativeCpu = false;
    cache.clear();
  };
}

/** Read the selected provider and physical adapter configuration for expert scheduling. */
export function semanticAccelerationConfig(): AccelerationConfig { return acceleration; }

/** Maximum number of independent semantic questions allowed in flight. */
export function semanticConcurrency(): number {
  return acceleration.features.has("parallel") ? acceleration.concurrency : 1;
}

export function semanticExecutionProvider(): { device: "cpu" | "cuda" | "webgpu" | "dml"; precision: "q8" | "fp32" } {
  return { device: activeDevice, precision: activeDevice === "cpu" && !nativeCpu ? "q8" : "fp32" };
}

function isClassification(value: Classification): boolean {
  return value.labels.length === value.scores.length && value.labels.every(item => typeof item === "string") &&
    value.scores.every(item => Number.isFinite(item) && item >= 0 && item <= 1);
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

/** Apply the same local model settings for tokenisers and every neural expert. */
export async function loadTransformers() {
  const runtime = await import("@huggingface/transformers");
  if ((process.env.CODE_GUARDS_OFFLINE ?? "") === "1") runtime.env.allowRemoteModels = false;
  const modelCache = process.env.CODE_GUARDS_MODEL_CACHE ?? "";
  if (modelCache) runtime.env.cacheDir = modelCache;
  return runtime;
}

async function loadClassifier(): Promise<Classifier> {
  const started = performance.now();
  progressObserver("loading");
  const { pipeline } = await loadTransformers();

  const chosen = [...acceleration.features].filter(
    (feature): feature is "cuda" | "dml" | "webgpu" =>
      feature === "cuda" || feature === "dml" || feature === "webgpu"
  );
  const devices: ("cpu" | "cuda" | "dml" | "webgpu")[] = chosen.length ? chosen : ["cpu"];
  const failures: string[] = [];
  for (const device of devices) {
    try {
      // DirectML exposes physical adapter affinity through ONNX Runtime's
      // deviceId session option. Never silently fall back to another adapter.
      const adapterId = process.env.CODE_GUARDS_GPU_WORKER_ID ?? null;
      const sessionOptions = device === "dml"
        ? {
            executionProviders: [{
              name: "dml" as const,
              ...(adapterId === null ? {} : { deviceId: Number(adapterId) })
            }],
            // DirectML forbids memory-pattern optimisation and parallel
            // execution within one session. Separate model workers may run
            // concurrently on different physical adapters.
            enableMemPattern: false,
            executionMode: "sequential" as const
          }
        : null;
      const classifier = await pipeline("zero-shot-classification", MODEL, {
        device, dtype: device === "cpu" ? "q8" : "fp32",
        ...(sessionOptions ? { session_options: sessionOptions } : {})
      });
      const single = async (premise: string, labels: string[], options: ClassifierOptions): Promise<Classification> => {
        const result = await classifier(premise, labels, options);
        if (Array.isArray(result) || !isClassification(result)) throw new Error("Invalid MobileBERT classification.");
        return result;
      };
      const classifyBatch = async (premises: string[], labels: string[], options: ClassifierOptions): Promise<Classification[]> => {
        const results = await classifier(premises, labels, options);
        if (!Array.isArray(results) || results.length !== premises.length || !results.every(isClassification)) {
          throw new Error("Invalid MobileBERT batch result.");
        }
        return results;
      };
      disposeClassifier = async () => { await classifier.dispose(); };
      activeDevice = device;
      timingObserver({ phase: "model-load", milliseconds: performance.now() - started });
      progressObserver("ready");
      return Object.assign(single, { tokenizer: classifier.tokenizer, classifyBatch });
    } catch (error) {
      failures.push(device + ": " + (error instanceof Error ? error.message : typeof error === "string" ? error : "Provider initialisation failed"));
    }
  }
  throw new Error("No requested MobileBERT provider could initialise. " + failures.join("; "));
}

/** Shared model-token budget for production inference and preflight. */
function windowPlan(question: SemanticQuestion, tokenizer: Tokenizer): {
  tokens: number[]; capacity: number; step: number
} {
  const labels = [question.same, question.different];
  const hypothesisLength = Math.max(...labels.map(label =>
    tokenizer.encode(TEMPLATE.replace("{}", label), { add_special_tokens: false }).length
  ));
  // BERT pairs contain [CLS], two [SEP] tokens and a safety reserve.
  const capacity = MAX_MODEL_TOKENS - hypothesisLength - 3 - SAFETY_TOKENS;
  if (capacity < 48) throw new Error("Zero-shot hypothesis is too long for MobileBERT's 512-token context; shorten the rule labels.");
  return {
    tokens: tokenizer.encode(question.premise, { add_special_tokens: false }),
    capacity,
    step: Math.max(1, capacity - OVERLAP)
  };
}

function decodeWindows(tokens: number[], capacity: number, tokenizer: Tokenizer): string[] {
  if (!tokens.length) return [""];
  const windows: string[] = [];
  const step = Math.max(1, capacity - OVERLAP);
  for (let start = 0; start < tokens.length; start += step) {
    windows.push(tokenizer.decode(tokens.slice(start, start + capacity), {skip_special_tokens: true}));
    if (start + capacity >= tokens.length) break;
  }
  return windows;
}

function pairedPremises(question: ComparisonQuestion, tokenizer: Tokenizer, capacity: number): string[] {
  const {left, right} = question.comparison;
  const first = `First entity ${left.name}: `;
  const second = `Second entity ${right.name}: `;
  const overhead = tokenizer.encode(first + "\n" + second, {add_special_tokens: false}).length;
  const budget = Math.floor((capacity - overhead - SAFETY_TOKENS) / 2);
  if (budget < 49) throw new Error("Comparison labels exceed the paired evidence budget.");
  const leftChunks = decodeWindows(tokenizer.encode(left.evidence, {add_special_tokens: false}), budget, tokenizer);
  const rightChunks = decodeWindows(tokenizer.encode(right.evidence, {add_special_tokens: false}), budget, tokenizer);
  // Cross-product pairing prevents a decisive relationship from disappearing
  // merely because the two facts occupy distant positions in the source.
  const windows = leftChunks.flatMap(a => rightChunks.map(b => first + a + "\n" + second + b));
  if (windows.some(window => tokenizer.encode(window, {add_special_tokens: false}).length > capacity)) {
    throw new Error("Re-encoded comparison exceeds the model token budget.");
  }
  return windows;
}

/** Count exactly the windows production inference would submit. */
export function premiseWindowCount(question: SemanticQuestion, tokenizer: Tokenizer): number {
  const { tokens, capacity, step } = windowPlan(question, tokenizer);
  if (tokens.length <= capacity) return 1;
  if ("comparison" in question) return pairedPremises(question, tokenizer, capacity).length;
  return Math.ceil((tokens.length - capacity) / step) + 1;
}

/** Split the same token plan into overlapping evidence windows for real inference. */
export function premiseWindows(question: SemanticQuestion, tokenizer: Tokenizer): string[] {
  const { tokens, capacity } = windowPlan(question, tokenizer);
  if (tokens.length <= capacity) return [question.premise];
  if ("comparison" in question) return pairedPremises(question, tokenizer, capacity);
  return decodeWindows(tokens, capacity, tokenizer);
}

function scores(result: Classification, question: SemanticQuestion): SimilarityVerdict {
  if (result.labels.length !== 2 || result.scores.length !== 2 || question.same === question.different ||
      new Set(result.labels).size !== 2 || result.scores.some(value => !Number.isFinite(value) || value < 0 || value > 1)) {
    throw new Error("Invalid zero-shot classification.");
  }
  const byLabel = new Map(result.labels.map((label, i) => [label, result.scores[i] ?? -1]));
  const sameConcept = byLabel.get(question.same) ?? -1;
  const differentConcept = byLabel.get(question.different) ?? -1;
  if (sameConcept < 0 || differentConcept < 0) throw new Error("Missing zero-shot hypothesis score.");
  return {sameConcept, differentConcept};
}

/** Combine evidence without ignoring contradicting windows or averaging away strong evidence. */
export async function assessWindows(question: SemanticQuestion, classifier: Classifier, batchSize = 1): Promise<WindowVerdict> {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 16) {
    throw new Error("Inference batch size must be between 1 and 16.");
  }
  const questionStarted = performance.now();
  const windowingStarted = performance.now();
  const windows = premiseWindows(question, classifier.tokenizer);
  timingObserver({ phase: "windowing", milliseconds: performance.now() - windowingStarted, windows: windows.length });
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
    timingObserver({
      phase: "inference", milliseconds: performance.now() - started,
      window: offset + 1, windows: windows.length, batchSize: group.length, gpuId: null, distinctQuestions: 1
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
  timingObserver({ phase: "verdict", milliseconds: performance.now() - questionStarted, windows: windows.length });
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


type QuestionWork = {
  question: SemanticQuestion;
  windows: readonly string[];
  started: number;
  next: number;
  completed: number;
  sameConcept: number;
  differentConcept: number;
  supportWindow: number;
  oppositionWindow: number;
  resolve: (value: WindowVerdict) => void;
  reject: (error: Error) => void;
};
type WindowWork = { request: QuestionWork; premise: string; index: number };

/**
 * Round-robin windows from independent questions with matching hypotheses.
 * Model calls remain serial on one inference session to avoid GPU contention.
 * Only enabled by the combination of parallel and batch acceleration flags.
 */
export function createQuestionBatcher(classifier: Classifier, batchSize: number): {
  score: (question: SemanticQuestion) => Promise<WindowVerdict>;
} {
  if (!Number.isSafeInteger(batchSize) || batchSize < 2 || batchSize > 16) {
    throw new Error("Cross-question batch size must be between 2 and 16.");
  }
  const queue: QuestionWork[] = [];
  const pending = new Set<QuestionWork>();
  let running = false;
  let scheduled = false;
  let failed = false;
  let failure: Error | null = null;

  function take(request: QuestionWork): WindowWork {
    const index = request.next++;
    const premise = request.windows[index] ?? null;
    if (premise === null) throw new Error("Semantic window queue is inconsistent.");
    if (request.next < request.windows.length) queue.push(request);
    return { request, premise, index };
  }

  function schedule(): void {
    if (running || scheduled || failed) return;
    scheduled = true;
    setImmediate(() => {
      scheduled = false;
      drain().catch(() => {
        const problem = new Error("Semantic queue failed during cleanup.");
        failed = true;
        failure = problem;
        for (const request of pending) request.reject(problem);
        pending.clear();
      });
    });
  }

  async function drain(): Promise<void> {
    if (running || failed) return;
    running = true;
    try {
      while (queue.length) {
        const first = queue.shift() ?? null;
        if (!first) throw new Error("Empty semantic work item.");
        const firstWindow = take(first);
        const batch: WindowWork[] = [firstWindow];
        // The pipeline requires one shared pair of candidate hypotheses per
        // call. Round-robin equivalent questions and leave other groups queued.
        while (batch.length < batchSize) {
          const index = queue.findIndex(request =>
            request.question.same === first.question.same &&
            request.question.different === first.question.different
          );
          if (index < 0) break;
          const request = queue.splice(index, 1)[0] ?? null;
          if (!request) throw new Error("Semantic work queue lost an item.");
          batch.push(take(request));
        }

        const labels = [first.question.same, first.question.different];
        const options: ClassifierOptions = { multi_label: true, hypothesis_template: TEMPLATE };
        const started = performance.now();
        const results = batch.length === 1
          ? [await classifier(firstWindow.premise, labels, options)]
          : await classifyGroup(classifier, batch.map(item => item.premise), labels, options);
        timingObserver({
          phase: "inference", milliseconds: performance.now() - started,
          window: firstWindow.index + 1,
          windows: first.windows.length, batchSize: batch.length,
          gpuId: null, distinctQuestions: new Set(batch.map(item => item.request)).size
        });
        for (const [offset, work] of batch.entries()) {
          const classification = results[offset] ?? null;
          if (!classification) throw new Error("MobileBERT returned fewer classifications than requested.");
          const verdict = scores(classification, work.request.question);
          progressObserver("inference");
          if (verdict.sameConcept > work.request.sameConcept) {
            work.request.sameConcept = verdict.sameConcept;
            work.request.supportWindow = work.index + 1;
          }
          if (verdict.differentConcept > work.request.differentConcept) {
            work.request.differentConcept = verdict.differentConcept;
            work.request.oppositionWindow = work.index + 1;
          }
          work.request.completed += 1;
          if (work.request.completed === work.request.windows.length) {
            const request = work.request;
            pending.delete(request);
            timingObserver({
              phase: "verdict", milliseconds: performance.now() - request.started,
              windows: request.windows.length
            });
            request.resolve({
              sameConcept: request.sameConcept,
              differentConcept: request.differentConcept,
              evidence: {
                windows: request.windows.length,
                supportWindow: request.supportWindow,
                oppositionWindow: request.oppositionWindow
              }
            });
          }
        }
      }
    } catch (error) {
      failed = true;
      const problem = error instanceof Error ? error : new Error("Semantic inference failed.");
      failure = problem;
      queue.length = 0;
      for (const request of pending) request.reject(problem);
      pending.clear();
    } finally {
      running = false;
      if (queue.length) schedule();
    }
  }

  return {
    score: (question): Promise<WindowVerdict> => {
      if (failed) return Promise.reject(failure ?? new Error("Semantic inference failed."));
      const started = performance.now();
      const windowingStarted = performance.now();
      let windows: string[];
      try {
        windows = premiseWindows(question, classifier.tokenizer);
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error("Semantic window preparation failed."));
      }
      timingObserver({
        phase: "windowing", milliseconds: performance.now() - windowingStarted,
        windows: windows.length
      });
      return new Promise<WindowVerdict>((resolve, reject) => {
        const request: QuestionWork = {
          question, windows, started, next: 0, completed: 0,
          sameConcept: 0, differentConcept: 0,
          supportWindow: 0, oppositionWindow: 0, resolve, reject
        };
        pending.add(request);
        queue.push(request);
        schedule();
      });
    }
  };
}

// Remote workers own their inference sessions. Local promises must be
// registered before awaiting them so shutdown can drain accepted requests
// and concurrent cache hits can share the same work.
export async function zeroShot(question: SemanticQuestion): Promise<WindowVerdict> {
  if (remoteScorer) return remoteScorer(question);
  if ((process.env.CODE_GUARDS_REQUIRE_RAW_NLI ?? "") === "1") throw new Error("Complete raw NLI evidence requires a native CPU or WebGPU worker.");
  if (closingClassifier) throw new Error("Semantic model is shutting down.");
  const enabled = acceleration.features.has("cache");
  const key = enabled ? semanticQuestionKey(question) : "";
  const previous = enabled ? (cache.get(key) ?? null) : null;
  if (previous) {
    timingObserver({ phase: "cache-hit", milliseconds: 0 });
    return previous;
  }
  const compute = async (): Promise<WindowVerdict> => {
    classifierPromise ??= loadClassifier();
    const classifier = await classifierPromise;
    if (acceleration.features.has("batch") && acceleration.features.has("parallel")) {
      questionBatcher ??= createQuestionBatcher(classifier, acceleration.batchSize);
      return questionBatcher.score(question);
    }
    return assessWindows(question, classifier, acceleration.features.has("batch") ? acceleration.batchSize : 1);
  };
  const promise = compute();
  pendingLocal.add(promise);
  try { return await retainVerdict(key, enabled, promise); }
  finally { pendingLocal.delete(promise); }
}

async function retainVerdict(key: string, enabled: boolean, promise: Promise<WindowVerdict>): Promise<WindowVerdict> {
  if (!enabled) return promise;
  const oldest = cache.size >= 512 ? ([...cache.keys()][0] ?? null) : null;
  if (oldest !== null) cache.delete(oldest);
  cache.set(key, promise);
  try { return await promise; }
  catch (error) {
    if ((cache.get(key) ?? null) === promise) cache.delete(key);
    throw error instanceof Error ? error : new Error("Semantic inference failed.");
  }
}

/** Drain accepted work before disposing the local model session. */
export async function disposeLocalSemanticModel(): Promise<void> {
  closingClassifier = true;
  try {
    await Promise.allSettled([...pendingLocal]);
    const dispose = disposeClassifier;
    disposeClassifier = null;
    classifierPromise = null;
    questionBatcher = null;
    cache.clear();
    if (dispose) await dispose();
  } finally { closingClassifier = false; }
}

export function supportsReuse(verdict: SimilarityVerdict, minimum = 0.78): boolean {
  return verdict.sameConcept >= minimum && verdict.sameConcept >= verdict.differentConcept + 0.12;
}

export type InvestigationOptions = {
  enabled: boolean;
  context: string;
  refine: () => SemanticQuestion;
  minimum: number;
  maximumOpposition: number;
};

/** Retain the existing decisive result; ask a narrower question only on ambiguity. */
export async function investigateComparison(score: SemanticScorer, question: SemanticQuestion, options: InvestigationOptions): Promise<SimilarityVerdict> {
  const initial = await score(question);
  if (!options.enabled || decisive(initial, options)) return initial;
  const refined = await score(options.refine());
  if (!decisive(refined, options)) console.error(`[Code Guards] Unresolved ${options.context}: initial ${initial.sameConcept}/${initial.differentConcept}, refined ${refined.sameConcept}/${refined.differentConcept}`);
  return refined;
}

function decisive(verdict: SimilarityVerdict, options: InvestigationOptions): boolean {
  const ceiling = options.maximumOpposition;
  return (supportsReuse(verdict, options.minimum) && verdict.differentConcept <= ceiling) ||
    (supportsReuse({sameConcept: verdict.differentConcept, differentConcept: verdict.sameConcept}, options.minimum) && verdict.sameConcept <= ceiling);
}

export function adaptiveComparisonEnabled(): boolean {
  return (process.env.CODE_GUARDS_EXPERIMENTAL_ADAPTIVE ?? "") === "1";
}
