/**
 * Read-only accounting of the semantic work Code Guards would request.
 *
 * Candidate selection is owned by the production guards. A recording scorer
 * visits their genuine semantic questions without initialising a classifier.
 */
import { performance } from "node:perf_hooks";
import { type AccelerationConfig, accelerationNames } from "./acceleration.ts";
import { documentation, handoverQuestion, styleQuestion } from "./guards/documentation.ts";
import { functionQuality } from "./guards/function-quality.ts";
import { moduleCohesion } from "./guards/module-cohesion.ts";
import { guardCapabilities } from "./experts.ts";
import { typeReuse } from "./guards/type-reuse.ts";
import type { AnalysisOptions } from "./engine.ts";
import { loadProject } from "./project.ts";
import { configureSemanticAcceleration, loadTransformers, MODEL, premiseWindowCount,
  type SemanticQuestion, type SemanticScorer, type Tokenizer } from "./semantic.ts";

export type InferenceWork = {
  questions: number;
  inferenceQuestions: number;
  cacheHits: number;
  windows: number;
  modelCallsMinimum: number;
  modelCallsMaximum: number;
};

export type PreflightStage = {
  guard: "type-reuse" | "function-quality" | "module-cohesion" | "documentation";
  minimum: InferenceWork;
  maximum: InferenceWork;
};

export type InferencePreflight = {
  mode: "preflight";
  model: string;
  project: string;
  sourceFiles: number;
  enabledGuards: string[];
  evaluatedSemanticGuards: string[];
  tokenizer: "MobileBERT model tokenizer (no model weights)";
  acceleration: string[];
  batchSize: number;
  concurrency: number;
  gpuIds: number[];
  stages: PreflightStage[];
  minimum: InferenceWork;
  maximum: InferenceWork;
  exactQuestionCount: boolean;
  estimatedWarmInferenceSeconds: { minimum: number; maximum: number } | null;
  calibration: string | null;
  limitations: string[];
  preparationMilliseconds: number;
};

const EMPTY: InferenceWork = {
  questions: 0, inferenceQuestions: 0, cacheHits: 0, windows: 0,
  modelCallsMinimum: 0, modelCallsMaximum: 0
};

function combine(items: readonly InferenceWork[]): InferenceWork {
  return items.reduce((total, item) => ({
    questions: total.questions + item.questions,
    inferenceQuestions: total.inferenceQuestions + item.inferenceQuestions,
    cacheHits: total.cacheHits + item.cacheHits,
    windows: total.windows + item.windows,
    modelCallsMinimum: total.modelCallsMinimum + item.modelCallsMinimum,
    modelCallsMaximum: total.modelCallsMaximum + item.modelCallsMaximum
  }), { ...EMPTY });
}

type BatchGroup = { windows: number; separateCalls: number };

/**
 * Use the production question body, hypothesis pair and token-window budget.
 * Cache accounting retains the same 512-entry FIFO eviction as zeroShot.
 */
export class InferenceCounter {
  private questions = 0;
  private inferenceQuestions = 0;
  private cacheHits = 0;
  private windows = 0;
  private readonly groups = new Map<string, BatchGroup>();
  private readonly cache = new Set<string>();
  private readonly batchSize: number;
  private readonly crossQuestionBatching: boolean;
  private readonly cacheEnabled: boolean;

  constructor(private readonly tokenizer: Tokenizer, config: AccelerationConfig) {
    this.batchSize = config.features.has("batch") ? config.batchSize : 1;
    // Physical workers batch each question in isolation. In-process batching
    // can coalesce only questions with identical hypothesis labels.
    this.crossQuestionBatching = config.features.has("batch") &&
      config.features.has("parallel") && !config.gpuIds.length;
    this.cacheEnabled = config.features.has("cache");
  }

  readonly reject: SemanticScorer = async question => this.record(question, false);
  readonly accept: SemanticScorer = async question => this.record(question, true);

  private record(question: SemanticQuestion, accepted: boolean): {
    sameConcept: number; differentConcept: number
  } {
    this.questions += 1;
    const key = JSON.stringify([MODEL, question.premise, question.same, question.different]);
    if (this.cacheEnabled && this.cache.has(key)) {
      this.cacheHits += 1;
    } else {
      const windows = premiseWindowCount(question, this.tokenizer);
      this.windows += windows;
      this.inferenceQuestions += 1;
      const pair = JSON.stringify([question.same, question.different]);
      const group = this.groups.get(pair) ?? { windows: 0, separateCalls: 0 };
      group.windows += windows;
      group.separateCalls += Math.ceil(windows / this.batchSize);
      this.groups.set(pair, group);
      this.remember(key);
    }
    // These are NOT model predictions. The two deterministic outcomes allow
    // us to bound README style checks dependent on the handover verdict.
    return accepted
      ? { sameConcept: 1, differentConcept: 0 }
      : { sameConcept: 0, differentConcept: 1 };
  }

  private remember(key: string): void {
    if (!this.cacheEnabled) return;
    const oldest = this.cache.size >= 512 ? ([...this.cache][0] ?? null) : null;
    if (oldest !== null) this.cache.delete(oldest);
    this.cache.add(key);
  }

  snapshot(): InferenceWork {
    const groups = [...this.groups.values()];
    const separateCalls = groups.reduce((total, item) => total + item.separateCalls, 0);
    const combinedCalls = groups.reduce((total, item) =>
      total + Math.ceil(item.windows / this.batchSize), 0);
    return {
      questions: this.questions,
      inferenceQuestions: this.inferenceQuestions,
      cacheHits: this.cacheHits,
      windows: this.windows,
      modelCallsMinimum: this.crossQuestionBatching ? combinedCalls : separateCalls,
      modelCallsMaximum: separateCalls
    };
  }
}

/**
 * Load ONLY the model tokenizer vocabulary/configuration. No pipeline,
 * inference session, ONNX weights or physical GPU worker is initialised.
 */
export async function loadPreflightTokenizer(): Promise<Tokenizer> {
  const { AutoTokenizer } = await loadTransformers();
  const tokenizer = await AutoTokenizer.from_pretrained(MODEL);
  return {
    encode: (text, options) => tokenizer.encode(text, options),
    decode: (ids, options) => tokenizer.decode(ids, options)
  };
}

function gpuReferenceRate(config: AccelerationConfig): number | null {
  if (!config.features.has("webgpu")) return null;
  if (config.gpuIds.length === 1) return 1569 / 60;
  if (config.gpuIds.length === 2) return 3372 / 60;
  return null;
}

/**
 * Enumerate production semantic questions without making model predictions.
 *
 * README style questions are score-dependent. Two runs of the SAME
 * documentation guard with opposite synthetic decisions give the possible
 * lower and upper workloads; no simulated verdict is treated as truth.
 */
export async function estimateInference(
  config: AnalysisOptions, acceleration: AccelerationConfig,
  tokenizer: Tokenizer | null = null, progress: (message: string) => void = () => {}
): Promise<InferencePreflight> {
  const started = performance.now();
  progress("[Code Guards] Preflight: loading TypeScript project");
  const project = loadProject(config.project);
  const enabled = [...config.enabled];
  const needsModel = enabled.some(guard => guardCapabilities(guard).includes("semantic-judgement"));
  const tokeniser = tokenizer ?? (needsModel ? await loadPreflightTokenizer() : null);
  const stages: PreflightStage[] = [];
  const restore = configureSemanticAcceleration(acceleration);
  try {
    if (tokeniser && config.enabled.has("type-reuse")) {
      progress("[Code Guards] Preflight: enumerating type-reuse candidates");
      const counter = new InferenceCounter(tokeniser, acceleration);
      await typeReuse(project, config.includeTests, counter.reject);
      const result = counter.snapshot();
      stages.push({guard: "type-reuse", minimum: result, maximum: result});
    }
    if (tokeniser && config.enabled.has("function-quality")) {
      progress("[Code Guards] Preflight: enumerating function-quality candidates");
      const counter = new InferenceCounter(tokeniser, acceleration);
      await functionQuality(project, config.includeTests, counter.reject);
      const result = counter.snapshot();
      stages.push({guard: "function-quality", minimum: result, maximum: result});
    }
    if (tokeniser && config.enabled.has("module-cohesion")) {
      progress("[Code Guards] Preflight: enumerating module-cohesion candidates");
      const minimum = new InferenceCounter(tokeniser, acceleration);
      const maximum = new InferenceCounter(tokeniser, acceleration);
      await moduleCohesion(project, config.includeTests, minimum.reject);
      await moduleCohesion(project, config.includeTests, async question =>
        question.same.includes("this module combines") ? maximum.accept(question) : maximum.reject(question));
      stages.push({guard: "module-cohesion", minimum: minimum.snapshot(), maximum: maximum.snapshot()});
    }
    if (tokeniser && config.enabled.has("documentation")) {
      progress("[Code Guards] Preflight: enumerating documentation questions");
      const maximum = new InferenceCounter(tokeniser, acceleration);
      await documentation(project, question => question.same === styleQuestion.same ? maximum.accept(question) : maximum.reject(question));
      const minimum = new InferenceCounter(tokeniser, acceleration);
      await documentation(project, question => question.same === handoverQuestion.same ? minimum.accept(question) : minimum.reject(question));
      stages.push({
        guard: "documentation", minimum: minimum.snapshot(),
        maximum: maximum.snapshot()
      });
    }
  } finally {
    restore();
  }

  const minimum = combine(stages.map(stage => stage.minimum));
  const maximum = combine(stages.map(stage => stage.maximum));
  const rate = gpuReferenceRate(acceleration);
  const projected = rate === null ? null : {
    minimum: Math.round(minimum.windows / rate * 100) / 100,
    maximum: Math.round(maximum.windows / rate * 100) / 100
  };
  const conditional = minimum.questions !== maximum.questions ||
    minimum.windows !== maximum.windows;
  const limitations = [
    "No semantic predictions are performed. Existing deterministic candidate selection is reused.",
    "The projected model-call range reflects batching compatibility, not GPU scheduling or runtime occupancy.",
    "Tokenizer-only preparation excludes model weight loading, native GPU workers and neural execution.",
    ...((process.env.CODE_GUARDS_EXPERIMENTAL_PROSE ?? "") === "1" && config.enabled.has("documentation") ? ["Experimental prose retrieval is not included in these counts; it requires embedding inference."] : []),
    ...(conditional ? [
      "Semantic decisions control later documentation and module-cohesion questions. The minimum and maximum are possible workloads; the actual path cannot be known without neural inference."
    ] : []),
    ...(rate === null ? [
      "No matching measured WebGPU calibration was supplied for these settings, so no runtime duration is claimed."
    ] : [
      "Warm-inference seconds use the supplied 60-second native WebGPU benchmark and exclude model loading, tokenisation, queue latency and resource contention."
    ])
  ];

  return {
    mode: "preflight", model: MODEL, project: project.root,
    sourceFiles: project.files.length, enabledGuards: enabled,
    evaluatedSemanticGuards: stages.map(stage => stage.guard),
    tokenizer: "MobileBERT model tokenizer (no model weights)",
    acceleration: accelerationNames(acceleration),
    batchSize: acceleration.features.has("batch") ? acceleration.batchSize : 1,
    concurrency: acceleration.features.has("parallel") ? acceleration.concurrency : 1,
    gpuIds: [...acceleration.gpuIds],
    stages, minimum, maximum,
    exactQuestionCount: !conditional,
    estimatedWarmInferenceSeconds: projected,
    calibration: rate === null ? null :
      (acceleration.gpuIds.length === 2
        ? "3,372 windows / 60 s; two RTX 2080 Ti, native WebGPU"
        : "1,569 windows / 60 s; one RTX 2080 Ti, native WebGPU"),
    limitations,
    preparationMilliseconds: Math.round((performance.now() - started) * 100) / 100
  };
}

/** Compact console report when JSON output has not been requested. */
export function formatInferencePreflight(result: InferencePreflight): string {
  const format = (work: InferenceWork): string =>
    String(work.questions) + " questions, " + String(work.windows) +
    " windows, " + String(work.modelCallsMinimum) + "–" +
    String(work.modelCallsMaximum) + " model calls";
  const lines = [
    "Code Guards inference preflight (no model inference)",
    "Project: " + result.project,
    "Source files: " + result.sourceFiles,
    ...result.stages.map(stage => stage.guard + ": " +
      format(stage.minimum) +
      (stage.minimum.questions !== stage.maximum.questions ||
       stage.minimum.windows !== stage.maximum.windows
        ? " to " + format(stage.maximum) : "")),
    "Total minimum: " + format(result.minimum),
    "Total maximum: " + format(result.maximum),
    ...(result.estimatedWarmInferenceSeconds === null ? [] : [
      "Estimated warm GPU inference: " +
      result.estimatedWarmInferenceSeconds.minimum + "–" +
      result.estimatedWarmInferenceSeconds.maximum + " seconds"
    ]),
    ...result.limitations.map(note => "Note: " + note)
  ];
  return lines.join("\n");
}
