import path from 'path';
import fs from 'fs';
import { app } from 'electron';

export interface SpanContext {
  spanIntent: string;       // free text from LLM
  spanName: string;         // e.g. "payment.process_transaction"
  description: string;      // full description
  layer: 'frontend' | 'backend';
  stack: string[];          // e.g. ['nextjs', 'express', 'postgresql']
  vertical: string;         // e.g. 'fintech', 'healthcare'
  attributes: { key: string; type: string; sampleValue: string }[];
}

export interface ResolvedOp {
  op: string;
  tier: 1 | 2 | 3;
  confidence: number;
}

interface OpRule {
  name: string;
  condition: (s: SpanContext) => boolean;
  result: string | ((s: SpanContext) => string);
  confidence: 'high' | 'medium';
}

interface CacheEntry {
  intentTokens: string[];
  resolvedOp: string;
  vertical: string;
  stackFingerprint: string;
  layer: 'frontend' | 'backend';
  confidence: number;
  resolvedAt: string;
  confirmedByTraces: boolean;
  correctedOp: string | null;
  usageCount: number;
}

interface CacheStore {
  entries: CacheEntry[];
  thresholds: Record<string, number>; // vertical → threshold
}

// ---------------------------------------------------------------------------
// Text utilities
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'to', 'for', 'of', 'and', 'or', 'with',
  'in', 'on', 'at', 'by', 'from', 'that', 'this', 'it', 'as',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s\-_.\/]+/)
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

function cosineSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;

  // Build TF vectors
  const tfA: Record<string, number> = {};
  const tfB: Record<string, number> = {};

  for (const t of a) tfA[t] = (tfA[t] ?? 0) + 1;
  for (const t of b) tfB[t] = (tfB[t] ?? 0) + 1;

  // Normalise by length (term frequency)
  for (const k of Object.keys(tfA)) tfA[k] /= a.length;
  for (const k of Object.keys(tfB)) tfB[k] /= b.length;

  // Dot product over shared terms
  let dot = 0;
  let magA = 0;
  let magB = 0;

  const allTerms = new Set([...Object.keys(tfA), ...Object.keys(tfB)]);
  for (const t of allTerms) {
    const va = tfA[t] ?? 0;
    const vb = tfB[t] ?? 0;
    dot += va * vb;
    magA += va * va;
    magB += vb * vb;
  }

  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

function stackFingerprint(stack: string[]): string {
  return [...stack].sort().join('+');
}

// ---------------------------------------------------------------------------
// Structural rules
// ---------------------------------------------------------------------------

const STRUCTURAL_RULES: OpRule[] = [
  {
    name: 'db_attribute_signal',
    condition: (s) => s.attributes.some((a) => a.key.startsWith('db.')),
    result: 'db.query',
    confidence: 'high',
  },
  {
    name: 'cache_system_attribute',
    condition: (s) =>
      s.attributes.some(
        (a) => a.key === 'db.system' && /redis|memcach|elasticache/i.test(a.sampleValue),
      ),
    result: 'cache.get',
    confidence: 'high',
  },
  {
    name: 'http_attribute_signal',
    condition: (s) =>
      s.attributes.some((a) =>
        ['http.method', 'http.url', 'http.status_code', 'server.address'].includes(a.key),
      ),
    result: (s) => (s.layer === 'frontend' ? 'http.client' : 'http.server'),
    confidence: 'high',
  },
  {
    name: 'frontend_ui_action_attribute',
    condition: (s) =>
      s.layer === 'frontend' &&
      s.attributes.some((a) => ['user.action', 'ui.component'].includes(a.key)),
    result: 'ui.action',
    confidence: 'high',
  },
  {
    name: 'graphql_stack',
    condition: (s) =>
      s.stack.includes('graphql') &&
      /(query|mutation|subscription|resolve)/i.test(s.spanIntent),
    result: (s) => {
      if (/mutation/i.test(s.spanIntent)) return 'graphql.execute';
      if (/parse/i.test(s.spanIntent)) return 'graphql.parse';
      if (/valid/i.test(s.spanIntent)) return 'graphql.validate';
      return 'graphql.execute';
    },
    confidence: 'high',
  },
  {
    name: 'grpc_stack',
    condition: (s) => s.stack.includes('grpc'),
    result: (s) => (s.layer === 'frontend' ? 'grpc.client' : 'grpc.server'),
    confidence: 'high',
  },
  {
    name: 'queue_worker_stack',
    condition: (s) =>
      s.stack.some((t) =>
        ['celery', 'bullmq', 'sidekiq', 'rq', 'kafka', 'rabbitmq', 'sqs', 'pubsub'].includes(t),
      ),
    result: 'task',
    confidence: 'high',
  },
  {
    name: 'websocket_stack',
    condition: (s) => s.stack.includes('websocket') || s.stack.includes('socket.io'),
    result: 'websocket',
    confidence: 'high',
  },
  {
    name: 'frontend_navigation_intent',
    condition: (s) =>
      s.layer === 'frontend' &&
      /(navigate|route|page transition|view change|screen)/i.test(
        s.spanIntent + ' ' + s.description,
      ),
    result: 'navigation',
    confidence: 'medium',
  },
  {
    name: 'backend_outbound_intent',
    condition: (s) =>
      s.layer === 'backend' &&
      /(external|third.?party|outbound|webhook|partner service)/i.test(
        s.spanIntent + ' ' + s.description,
      ) &&
      /(call|request|fetch|send|post)/i.test(s.spanIntent + ' ' + s.description),
    result: 'http.client',
    confidence: 'medium',
  },
  {
    name: 'backend_inbound_intent',
    condition: (s) =>
      s.layer === 'backend' &&
      /(handle|receive|process|endpoint|route|controller|handler)/i.test(s.spanIntent),
    result: 'http.server',
    confidence: 'medium',
  },
  {
    name: 'background_job_intent',
    condition: (s) =>
      /(background|async|scheduled|cron|worker|queue|job|batch)/i.test(
        s.spanIntent + ' ' + s.description,
      ),
    result: 'task',
    confidence: 'medium',
  },
  {
    name: 'frontend_layer_default',
    condition: (s) => s.layer === 'frontend',
    result: 'ui.render',
    confidence: 'medium',
  },
  {
    name: 'backend_layer_default',
    condition: (s) => s.layer === 'backend',
    result: 'function',
    confidence: 'medium',
  },
];

// ---------------------------------------------------------------------------
// Valid ops for LLM prompt
// ---------------------------------------------------------------------------

const VALID_OPS = [
  'http.client',
  'http.server',
  'db.query',
  'db.transaction',
  'cache.get',
  'cache.put',
  'cache.remove',
  'ui.render',
  'ui.action',
  'ui.load',
  'function',
  'task',
  'navigation',
  'pageload',
  'resource',
  'websocket',
  'grpc.client',
  'grpc.server',
  'graphql.execute',
  'graphql.parse',
  'graphql.validate',
  'custom',
];

// ---------------------------------------------------------------------------
// OpResolver class
// ---------------------------------------------------------------------------

export class OpResolver {
  private cacheFilePath: string;
  private llmCallerFn: (prompt: string) => Promise<string>;
  private cache: CacheStore;

  constructor(cacheFilePath: string, llmCallerFn: (prompt: string) => Promise<string>) {
    this.cacheFilePath = cacheFilePath;
    this.llmCallerFn = llmCallerFn;
    this.cache = this.loadCache();
  }

  // -------------------------------------------------------------------------
  // Cache persistence
  // -------------------------------------------------------------------------

  private loadCache(): CacheStore {
    try {
      if (fs.existsSync(this.cacheFilePath)) {
        const raw = fs.readFileSync(this.cacheFilePath, 'utf-8');
        return JSON.parse(raw) as CacheStore;
      }
    } catch (err) {
      console.warn('[OpResolver] Could not load cache, starting fresh:', err);
    }
    return { entries: [], thresholds: {} };
  }

  private saveCache(): void {
    try {
      const dir = path.dirname(this.cacheFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.cacheFilePath, JSON.stringify(this.cache, null, 2), 'utf-8');
    } catch (err) {
      console.error('[OpResolver] Failed to save cache:', err);
    }
  }

  // -------------------------------------------------------------------------
  // Main resolution pipeline
  // -------------------------------------------------------------------------

  async resolve(spanContext: SpanContext): Promise<ResolvedOp> {
    let mediumCandidate: string | null = null;

    // Tier 1 — structural rules
    for (const rule of STRUCTURAL_RULES) {
      if (rule.condition(spanContext)) {
        const resultOp =
          typeof rule.result === 'function' ? rule.result(spanContext) : rule.result;

        if (rule.confidence === 'high') {
          return { op: resultOp, tier: 1, confidence: 0.95 };
        }

        if (rule.confidence === 'medium' && mediumCandidate === null) {
          mediumCandidate = resultOp;
        }
      }
    }

    // Tier 2 — cache lookup
    const cacheHit = this.lookupCache(spanContext);
    if (cacheHit) {
      return {
        op: cacheHit.correctedOp ?? cacheHit.resolvedOp,
        tier: 2,
        confidence: cacheHit.confidence,
      };
    }

    // Tier 3 — LLM
    const llmResult = await this.callLLMForOp(spanContext);
    if (llmResult.confidence >= 0.6) {
      this.storeInCache(spanContext, llmResult.op, llmResult.confidence);
      return { op: llmResult.op, tier: 3, confidence: llmResult.confidence };
    }

    // Fallback
    return { op: mediumCandidate ?? 'function', tier: 1, confidence: 0.3 };
  }

  // -------------------------------------------------------------------------
  // Cache lookup
  // -------------------------------------------------------------------------

  lookupCache(spanContext: SpanContext): CacheEntry | null {
    const queryTokens = tokenize(spanContext.spanIntent);
    const fp = stackFingerprint(spanContext.stack);
    const defaultThreshold = this.cache.thresholds[spanContext.vertical] ?? 0.82;

    const candidates = this.cache.entries.filter(
      (e) =>
        e.vertical === spanContext.vertical &&
        e.stackFingerprint === fp &&
        e.layer === spanContext.layer,
    );

    let bestEntry: CacheEntry | null = null;
    let bestScore = -1;

    for (const entry of candidates) {
      const threshold = entry.confirmedByTraces
        ? defaultThreshold - 0.05
        : defaultThreshold;

      const score = cosineSimilarity(queryTokens, entry.intentTokens);
      if (score >= threshold && score > bestScore) {
        bestScore = score;
        bestEntry = entry;
      }
    }

    if (bestEntry) {
      // Increment usage count
      bestEntry.usageCount = (bestEntry.usageCount ?? 0) + 1;
      this.saveCache();
    }

    return bestEntry;
  }

  // -------------------------------------------------------------------------
  // LLM call
  // -------------------------------------------------------------------------

  async callLLMForOp(
    spanContext: SpanContext,
  ): Promise<{ op: string; confidence: number }> {
    const prompt = `You are a Sentry observability expert. Given the span context below, select the single most appropriate Sentry op string.

Sentry op semantics:
- http.client: outbound HTTP requests made by the app
- http.server: inbound HTTP requests handled by the app
- db.query: database read/write operations
- db.transaction: database transaction boundaries
- cache.get / cache.put / cache.remove: cache operations (Redis, Memcached, etc.)
- ui.render: React/Vue/Angular component render cycles
- ui.action: user-triggered UI interactions (click, submit, etc.)
- ui.load: initial load of a UI view or screen
- function: generic function call (default backend fallback)
- task: background jobs, queue workers, cron, async tasks
- navigation: client-side page/route transitions
- pageload: full browser page load
- resource: static asset loading (JS, CSS, images)
- websocket: WebSocket message send/receive
- grpc.client / grpc.server: gRPC calls
- graphql.execute / graphql.parse / graphql.validate: GraphQL lifecycle
- custom: anything that doesn't fit the above

Valid ops: ${VALID_OPS.join(', ')}

Span context:
- Intent: ${spanContext.spanIntent}
- Name: ${spanContext.spanName}
- Description: ${spanContext.description}
- Layer: ${spanContext.layer}
- Stack: ${spanContext.stack.join(', ')}
- Vertical: ${spanContext.vertical}
- Attributes: ${JSON.stringify(spanContext.attributes)}

Respond with ONLY a JSON object in this exact shape:
{"op": "<one of the valid ops>", "confidence": <0.0-1.0>}`;

    const tryParse = (raw: string): { op: string; confidence: number } | null => {
      try {
        // Strip markdown fences if present
        let text = raw.replace(/^```(?:json)?\s*/m, '').replace(/```[\s\S]*$/m, '').trim();
        const start = text.indexOf('{');
        if (start === -1) return null;
        let depth = 0;
        let inString = false;
        let escape = false;
        for (let i = start; i < text.length; i++) {
          const ch = text[i];
          if (escape) { escape = false; continue; }
          if (ch === '\\' && inString) { escape = true; continue; }
          if (ch === '"') { inString = !inString; continue; }
          if (inString) continue;
          if (ch === '{') depth++;
          else if (ch === '}') {
            depth--;
            if (depth === 0) {
              const parsed = JSON.parse(text.slice(start, i + 1));
              if (
                typeof parsed.op === 'string' &&
                VALID_OPS.includes(parsed.op) &&
                typeof parsed.confidence === 'number'
              ) {
                return parsed as { op: string; confidence: number };
              }
              return null;
            }
          }
        }
        return null;
      } catch {
        return null;
      }
    };

    try {
      const raw = await this.llmCallerFn(prompt);
      const result = tryParse(raw);
      if (result) return result;

      // One retry
      const raw2 = await this.llmCallerFn(prompt);
      const result2 = tryParse(raw2);
      if (result2) return result2;
    } catch (err) {
      console.error('[OpResolver] LLM call failed:', err);
    }

    return { op: 'function', confidence: 0.0 };
  }

  // -------------------------------------------------------------------------
  // Cache write
  // -------------------------------------------------------------------------

  storeInCache(spanContext: SpanContext, op: string, confidence: number): void {
    const entry: CacheEntry = {
      intentTokens: tokenize(spanContext.spanIntent),
      resolvedOp: op,
      vertical: spanContext.vertical,
      stackFingerprint: stackFingerprint(spanContext.stack),
      layer: spanContext.layer,
      confidence,
      resolvedAt: new Date().toISOString(),
      confirmedByTraces: false,
      correctedOp: null,
      usageCount: 1,
    };
    this.cache.entries.push(entry);
    this.saveCache();
  }

  // -------------------------------------------------------------------------
  // Feedback helpers
  // -------------------------------------------------------------------------

  markConfirmed(spanName: string, vertical: string, stackFP: string): void {
    const entry = this.cache.entries.find(
      (e) =>
        e.vertical === vertical &&
        e.stackFingerprint === stackFP &&
        tokenize(spanName).some((t) => e.intentTokens.includes(t)),
    );
    if (entry) {
      entry.confirmedByTraces = true;
      this.saveCache();
    }
  }

  markCorrected(
    spanName: string,
    vertical: string,
    stackFP: string,
    correctOp: string,
  ): void {
    const entry = this.cache.entries.find(
      (e) =>
        e.vertical === vertical &&
        e.stackFingerprint === stackFP &&
        tokenize(spanName).some((t) => e.intentTokens.includes(t)),
    );
    if (entry) {
      entry.correctedOp = correctOp;
      this.saveCache();
    }
  }
}
