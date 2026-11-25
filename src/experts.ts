import { createHash } from "node:crypto";
import type { GuardName, Location } from "./model.ts";
import { MODEL, MAX_MODEL_TOKENS, loadTransformers } from "./semantic.ts";

export type Capability = "compiler-facts" | "semantic-judgement" | "prose-retrieval" | "code-retrieval";
export type ExpertProfile = {
  model: string;
  revision: string;
  capability: Capability;
  contextTokens: number;
  modelContextTokens: number;
  dimensions: number;
  batchSize: number;
  provider: "cpu";
  precision: "fp32";
  cacheNamespace: string;
  licence: string;
  weightBytes: number;
};
export const PROSE_EXPERT: ExpertProfile = {
  model: "Xenova/all-MiniLM-L6-v2",
  revision: "5356e92506bd45bf15c2295d5c8e19b5bc7abf94",
  capability: "prose-retrieval",
  contextTokens: 256,
  modelContextTokens: 256,
  dimensions: 384,
  batchSize: 8,
  provider: "cpu",
  precision: "fp32",
  cacheNamespace: "mean-normalised-complete-paragraph-v1",
  licence: "Apache-2.0",
  weightBytes: 90400000
};
export const CODE_EXPERT: ExpertProfile = {
  model: "jinaai/jina-embeddings-v2-base-code",
  revision: "9d61b434b354511c603038133a8c1ce2190e4d98",
  capability: "code-retrieval",
  contextTokens: 1024,
  modelContextTokens: 8192,
  dimensions: 768,
  batchSize: 2,
  provider: "cpu",
  precision: "fp32",
  cacheNamespace: "mean-normalised-complete-implementation-v1",
  licence: "Apache-2.0",
  weightBytes: 642000000
};
export const FINAL_JUDGE = {model: MODEL, contextTokens: MAX_MODEL_TOKENS, capability: "semantic-judgement"} as const;

export function guardCapabilities(guard: GuardName): readonly Capability[] {
  if (guard === "documentation") return ["compiler-facts", "prose-retrieval", "semantic-judgement"];
  if (guard === "function-quality") return ["compiler-facts", "code-retrieval", "semantic-judgement"];
  if (guard === "type-reuse" || guard === "module-cohesion") return ["compiler-facts", "semantic-judgement"];
  return ["compiler-facts"];
}

export type SourceEvidence = { location: Location; text: string };
export type ProseMatch = { earlier: SourceEvidence; later: SourceEvidence; relevance: number };
export type RetrievalResult = { matches: ProseMatch[]; unresolved: SourceEvidence[] };
export type EmbeddingRuntime = {
  embed: (passages: readonly string[]) => Promise<(number[] | null)[]>;
  dispose: () => Promise<void>;
};
export type ExpertMetrics = {
  loads: number; batches: number; cacheHits: number; loadMilliseconds: number;
  sampledPeakRssBytes: number; rssAfterDisposalBytes: number;
};

async function loadEmbeddingRuntime(profile: ExpertProfile): Promise<EmbeddingRuntime> {
  const { pipeline } = await loadTransformers();
  const extractor = await pipeline("feature-extraction", profile.model, {
    revision: profile.revision, device: profile.provider, dtype: profile.precision
  });
  return {
    embed: async passages => {
      const accepted = passages.map(text =>
        extractor.tokenizer.encode(text, {add_special_tokens: false}).length <= profile.contextTokens - 2);
      const inputs = passages.filter((_, index) => accepted[index] ?? false);
      if (!inputs.length) return passages.map(() => null);
      const tensor = await extractor(inputs, {pooling: "mean", normalize: true});
      try {
        const output: { readonly data: object | null } = tensor;
        const data = output.data;
        if (!(data instanceof Float32Array) || data.length !== inputs.length * profile.dimensions) throw new Error("Unexpected specialist embedding shape.");
        const rows = inputs.map((_, index) => Array.from(data.slice(index * profile.dimensions, (index + 1) * profile.dimensions)));
        let cursor = 0;
        return accepted.map(valid => valid ? rows[cursor++] ?? null : null);
      } finally { tensor.dispose(); }
    },
    dispose: async () => { await extractor.dispose(); }
  };
}

function contentKey(profile: ExpertProfile, text: string): string {
  return createHash("sha256").update(JSON.stringify([
    profile.model, profile.revision, profile.provider,
    profile.precision, profile.cacheNamespace, profile.contextTokens, profile.dimensions, text
  ])).digest("hex");
}

function cosine(left: number[], right: number[]): number {
  if (!left.length || left.length !== right.length) throw new Error("Incompatible expert embeddings.");
  const dot = left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0);
  const leftNorm = Math.sqrt(left.reduce((sum, value) => sum + value * value, 0));
  const rightNorm = Math.sqrt(right.reduce((sum, value) => sum + value * value, 0));
  if (!leftNorm || !rightNorm) throw new Error("Invalid zero-norm embedding.");
  return Math.max(-1, Math.min(1, dot / (leftNorm * rightNorm)));
}
type VectorEvidence = { evidence: SourceEvidence; vector: number[] };

export type RetrievalFilter = (earlier: SourceEvidence, later: SourceEvidence) => boolean;

function nearestEarlier(rows: VectorEvidence[], eligible: RetrievalFilter): ProseMatch[] {
  const matches: ProseMatch[] = [];
  for (const [index, later] of rows.entries()) {
    const nearest = rows.slice(0, index).reduce<ProseMatch | null>((best, item) => {
      if (!eligible(item.evidence, later.evidence)) return best;
      const relevance = cosine(item.vector, later.vector);
      return !best || relevance > best.relevance
        ? {earlier: item.evidence, later: later.evidence, relevance} : best;
    }, null);
    if (nearest && nearest.relevance > 0) matches.push(nearest);
  }
  return matches;
}

/** Own one lazily allocated CPU specialist session and its bounded embedding cache. */
export class EmbeddingExpert {
  private runtime: EmbeddingRuntime | null = null;
  private readonly vectors = new Map<string, number[] | null>();
  private busy: Promise<RetrievalResult> | null = null;
  private closed = false;
  readonly metrics: ExpertMetrics = {
    loads: 0, batches: 0, cacheHits: 0, loadMilliseconds: 0,
    sampledPeakRssBytes: 0, rssAfterDisposalBytes: 0
  };

  constructor(private readonly profile: ExpertProfile, private readonly load: () => Promise<EmbeddingRuntime>,
    private readonly rssBudgetBytes: number) {
    if (!Number.isSafeInteger(rssBudgetBytes) || rssBudgetBytes <= 0) throw new Error("Expert RSS budget must be a positive integer.");
  }

  private sampleMemory(): void {
    const rss = process.memoryUsage().rss;
    this.metrics.sampledPeakRssBytes = Math.max(this.metrics.sampledPeakRssBytes, rss);
    if (rss > this.rssBudgetBytes) throw new Error("Embedding expert exceeded the configured process RSS budget.");
  }

  private async session(): Promise<EmbeddingRuntime> {
    if (this.runtime) return this.runtime;
    this.sampleMemory();
    const start = performance.now();
    const runtime = await this.load();
    this.runtime = runtime;
    this.metrics.loads += 1;
    this.metrics.loadMilliseconds += performance.now() - start;
    this.sampleMemory();
    return runtime;
  }

  private remember(key: string, vector: number[] | null): void {
    const oldest = this.vectors.size >= 1024 ? ([...this.vectors.keys()][0] ?? null) : null;
    if (oldest !== null) this.vectors.delete(oldest);
    this.vectors.set(key, vector);
  }

  private async embedGroup(group: SourceEvidence[]): Promise<(number[] | null)[]> {
    const keys = group.map(item => contentKey(this.profile, item.text));
    const completed = new Map<string, number[] | null>();
    for (const key of keys) {
      if (this.vectors.has(key)) completed.set(key, this.vectors.get(key) ?? null);
    }
    const missing = group.filter(item => !completed.has(contentKey(this.profile, item.text)));
    this.metrics.cacheHits += group.length - missing.length;
    if (!missing.length) return keys.map(key => completed.get(key) ?? null);
    const session = await this.session();
    const vectors = await session.embed(missing.map(item => item.text));
    if (vectors.length !== missing.length) throw new Error("Incomplete embedding expert batch.");
    for (const [index, item] of missing.entries()) {
      const key = contentKey(this.profile, item.text);
      const vector = vectors[index] ?? null;
      completed.set(key, vector);
      this.remember(key, vector);
    }
    this.metrics.batches += 1;
    this.sampleMemory();
    return keys.map(key => completed.get(key) ?? null);
  }

  private async retrieve(passages: SourceEvidence[], eligible: RetrievalFilter): Promise<RetrievalResult> {
    const rows: VectorEvidence[] = [];
    const unresolved: SourceEvidence[] = [];
    for (let offset = 0; offset < passages.length; offset += this.profile.batchSize) {
      const group = passages.slice(offset, offset + this.profile.batchSize);
      const vectors = await this.embedGroup(group);
      for (const [index, evidence] of group.entries()) {
        const vector = vectors[index] ?? null;
        if (vector) rows.push({evidence, vector});
        else unresolved.push(evidence);
      }
    }
    return {matches: nearestEarlier(rows, eligible), unresolved};
  }

  async rank(passages: SourceEvidence[], eligible: RetrievalFilter = (a, b) => a.text !== b.text): Promise<RetrievalResult> {
    if (this.closed || this.busy) throw new Error("Embedding expert is closed or already evaluating a batch.");
    if (passages.length < 2) return {matches: [], unresolved: []};
    const work = this.retrieve(passages, eligible);
    this.busy = work;
    try { return await work; }
    finally { this.busy = null; }
  }

  async close(): Promise<void> {
    this.closed = true;
    const pending = this.busy;
    if (pending) await Promise.allSettled([pending]);
    const runtime = this.runtime;
    this.runtime = null;
    this.vectors.clear();
    if (runtime) await runtime.dispose();
    this.metrics.rssAfterDisposalBytes = process.memoryUsage().rss;
  }
}

export class ProseExpert extends EmbeddingExpert {
  constructor(load: () => Promise<EmbeddingRuntime> = () => loadEmbeddingRuntime(PROSE_EXPERT),
    rssBudgetBytes = 2147483648) {
    super(PROSE_EXPERT, load, rssBudgetBytes);
  }
}

export class CodeExpert extends EmbeddingExpert {
  constructor(load: () => Promise<EmbeddingRuntime> = () => loadEmbeddingRuntime(CODE_EXPERT),
    rssBudgetBytes = 2147483648) {
    super(CODE_EXPERT, load, rssBudgetBytes);
  }
}

function configuredBudget(): number {
  return Number(process.env.CODE_GUARDS_EXPERT_RAM_MIB ?? "2048") * 1048576;
}

export function configuredProseExpert(): ProseExpert | null {
  if ((process.env.CODE_GUARDS_EXPERIMENTAL_PROSE ?? "") !== "1") return null;
  return new ProseExpert(() => loadEmbeddingRuntime(PROSE_EXPERT), configuredBudget());
}

export function configuredCodeExpert(): CodeExpert | null {
  if ((process.env.CODE_GUARDS_EXPERIMENTAL_CODE ?? "") !== "1") return null;
  return new CodeExpert(() => loadEmbeddingRuntime(CODE_EXPERT), configuredBudget());
}
