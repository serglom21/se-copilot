import path from 'path';
import fs from 'fs';
import os from 'os';
import { app } from 'electron';
import { OpResolver, SpanContext, ResolvedOp } from './op-resolver';

export interface OpValidationResult {
  known: boolean;
  confidence: 'high' | 'low';
}

export interface FieldValidationResult {
  known: boolean;
  type: 'duration' | 'count' | 'string' | 'custom' | 'unknown';
}

export interface AggregateValidationResult {
  valid: boolean;
  confidence: 'high' | 'low';
}

export interface DisplayTypeValidationResult {
  known: boolean;
}

interface DashboardSchema {
  fields: string[];
  aggregates: string[];
  displayTypes: string[];
  fieldTypes: Record<string, string>; // field → type
  aggregateFieldCompat: Record<string, string[]>; // aggregate → compatible field types
}

// ---------------------------------------------------------------------------
// Seed data
// ---------------------------------------------------------------------------

const SEED_OPS = [
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

const SEED_SCHEMA: DashboardSchema = {
  fields: [
    'span.duration',
    'span.op',
    'span.description',
    'span.status',
    'transaction',
    'count()',
    'failure_rate()',
    'p50(span.duration)',
    'p75(span.duration)',
    'p95(span.duration)',
    'p99(span.duration)',
    'avg(span.duration)',
    'count_unique(user)',
    'sum(span.duration)',
  ],
  aggregates: [
    'count',
    'count_unique',
    'avg',
    'p50',
    'p75',
    'p95',
    'p99',
    'failure_rate',
    'sum',
  ],
  displayTypes: ['big_number', 'area', 'line', 'table', 'bar'],
  fieldTypes: {
    'span.duration': 'duration',
    'span.op': 'string',
    'span.description': 'string',
    'span.status': 'string',
    'transaction': 'string',
    'count()': 'count',
    'failure_rate()': 'count',
    'p50(span.duration)': 'duration',
    'p75(span.duration)': 'duration',
    'p95(span.duration)': 'duration',
    'p99(span.duration)': 'duration',
    'avg(span.duration)': 'duration',
    'count_unique(user)': 'count',
    'sum(span.duration)': 'duration',
  },
  aggregateFieldCompat: {
    p50: ['duration'],
    p75: ['duration'],
    p95: ['duration'],
    p99: ['duration'],
    avg: ['duration'],
    count: ['count', 'string', 'duration'],
    count_unique: ['string'],
    failure_rate: ['count'],
    sum: ['duration', 'count'],
  },
};

// ---------------------------------------------------------------------------
// ConstraintRegistry class
// ---------------------------------------------------------------------------

export class ConstraintRegistry {
  // Reference set only — not a gate. Ops outside this set are flagged, not rejected.
  knownOps: Set<string>;
  layerDefaults: { frontend: string; backend: string } = {
    frontend: 'ui.render',
    backend: 'http.server',
  };

  private dashboardSchema: DashboardSchema;
  private opResolver: OpResolver | null = null;
  private schemaCache: string;

  constructor() {
    this.knownOps = new Set(SEED_OPS);
    this.dashboardSchema = { ...SEED_SCHEMA };

    // Resolve userData path robustly — app may not be ready in all contexts
    let userDataDir: string;
    try {
      userDataDir = app.getPath('userData');
    } catch {
      userDataDir = path.join(os.homedir(), '.se-copilot');
    }

    this.schemaCache = path.join(userDataDir, 'sentry-schema-cache.json');
  }

  // -------------------------------------------------------------------------
  // Initialisation
  // -------------------------------------------------------------------------

  async init(orgSlug?: string, sentryToken?: string): Promise<void> {
    let schemaLoaded = false;

    // 1. Attempt live schema from Sentry API
    if (orgSlug && sentryToken) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);

        const response = await fetch(
          `https://sentry.io/api/0/organizations/${orgSlug}/metrics/meta/`,
          {
            headers: {
              Authorization: `Bearer ${sentryToken}`,
              'Content-Type': 'application/json',
            },
            signal: controller.signal,
          },
        );

        clearTimeout(timeoutId);

        if (response.ok) {
          const data = await response.json() as Record<string, unknown>;
          // Attempt to enrich schema from live response if it contains field info
          if (Array.isArray(data.fields)) {
            this.dashboardSchema.fields = [
              ...new Set([...SEED_SCHEMA.fields, ...(data.fields as string[])]),
            ];
          }
          // Persist enriched schema for offline use
          this.persistSchemaCache();
          schemaLoaded = true;
        }
      } catch {
        // Fail silently — network errors or timeout are expected in offline mode
      }
    }

    // 2. Fall back to cached schema
    if (!schemaLoaded) {
      try {
        if (fs.existsSync(this.schemaCache)) {
          const raw = fs.readFileSync(this.schemaCache, 'utf-8');
          const cached = JSON.parse(raw) as { schema?: DashboardSchema; cachedAt?: string };

          if (cached.schema) {
            this.dashboardSchema = cached.schema;
            schemaLoaded = true;

            // Warn if cache is older than 7 days
            if (cached.cachedAt) {
              const age = Date.now() - new Date(cached.cachedAt).getTime();
              const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
              if (age > sevenDaysMs) {
                console.warn(
                  '[ConstraintRegistry] Using stale schema cache (cached at:',
                  cached.cachedAt,
                  '). Consider reconnecting to Sentry to refresh.',
                );
              }
            }
          }
        }
      } catch (err) {
        console.warn('[ConstraintRegistry] Could not read schema cache:', err);
      }
    }

    // 3. If neither live nor cache worked, seed schema is already in place
    if (!schemaLoaded) {
      console.warn(
        '[ConstraintRegistry] Using seed schema — no live or cached schema available.',
      );
    }

    // 4. Attempt to read SDK op constants from @sentry/core
    this.loadSdkOps();
  }

  // -------------------------------------------------------------------------
  // SDK op discovery
  // -------------------------------------------------------------------------

  private loadSdkOps(): void {
    try {
      // Walk common locations for @sentry/core
      const searchRoots = [
        path.join(process.cwd(), 'node_modules', '@sentry', 'core'),
        path.join(__dirname, '..', '..', 'node_modules', '@sentry', 'core'),
        path.join(__dirname, '..', '..', '..', 'node_modules', '@sentry', 'core'),
      ];

      for (const root of searchRoots) {
        if (!fs.existsSync(root)) continue;

        // Recursively scan .js and .ts files for string constants that look like op values
        const files = this.findFiles(root, /\.(js|ts)$/, 3);
        for (const file of files) {
          try {
            const content = fs.readFileSync(file, 'utf-8');
            // Match patterns like: export const SPAN_STATUS_OK = "http.client"
            // or op: 'db.query' style assignments
            const matches = content.matchAll(
              /(?:op|spanOp|SPAN_OP)[^=]*=\s*['"]([a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)*)['"]|['"]([a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+)['"]/g,
            );
            for (const match of matches) {
              const candidate = match[1] ?? match[2];
              if (candidate && /^[a-z]/.test(candidate) && candidate.includes('.')) {
                this.knownOps.add(candidate);
              }
            }
          } catch {
            // Skip unreadable files
          }
        }
        break; // Stop after first found root
      }
    } catch (err) {
      console.warn('[ConstraintRegistry] SDK op discovery failed (non-fatal):', err);
    }
  }

  private findFiles(dir: string, pattern: RegExp, maxDepth: number): string[] {
    if (maxDepth <= 0) return [];
    const results: string[] = [];
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          results.push(...this.findFiles(fullPath, pattern, maxDepth - 1));
        } else if (entry.isFile() && pattern.test(entry.name)) {
          results.push(fullPath);
        }
      }
    } catch {
      // Skip directories we can't read
    }
    return results;
  }

  // -------------------------------------------------------------------------
  // Schema cache persistence
  // -------------------------------------------------------------------------

  private persistSchemaCache(): void {
    try {
      const dir = path.dirname(this.schemaCache);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(
        this.schemaCache,
        JSON.stringify({ schema: this.dashboardSchema, cachedAt: new Date().toISOString() }, null, 2),
        'utf-8',
      );
    } catch (err) {
      console.warn('[ConstraintRegistry] Could not persist schema cache:', err);
    }
  }

  // -------------------------------------------------------------------------
  // Resolver wiring
  // -------------------------------------------------------------------------

  setOpResolver(resolver: OpResolver): void {
    this.opResolver = resolver;
  }

  // -------------------------------------------------------------------------
  // Op validation
  // -------------------------------------------------------------------------

  validateOp(op: string): OpValidationResult {
    if (this.knownOps.has(op)) {
      return { known: true, confidence: 'high' };
    }
    console.log(
      `[ConstraintRegistry] Unknown op encountered: "${op}" — flagged but not rejected.`,
    );
    return { known: false, confidence: 'low' };
  }

  // -------------------------------------------------------------------------
  // Op resolution (delegates to OpResolver if available)
  // -------------------------------------------------------------------------

  async resolveOp(spanContext: SpanContext): Promise<string> {
    if (this.opResolver) {
      try {
        const resolved: ResolvedOp = await this.opResolver.resolve(spanContext);
        return resolved.op;
      } catch (err) {
        console.warn('[ConstraintRegistry] OpResolver failed, falling back to heuristic:', err);
      }
    }

    // Simple heuristic fallback when no resolver is configured
    return spanContext.layer === 'frontend'
      ? this.layerDefaults.frontend
      : this.layerDefaults.backend;
  }

  // -------------------------------------------------------------------------
  // Field validation
  // -------------------------------------------------------------------------

  validateField(field: string, spanAttributes?: string[]): FieldValidationResult {
    if (this.dashboardSchema.fields.includes(field)) {
      const rawType = this.dashboardSchema.fieldTypes[field];
      const type = this.toFieldType(rawType);
      return { known: true, type };
    }

    // Check if the field matches a known span attribute key
    if (spanAttributes && spanAttributes.includes(field)) {
      return { known: true, type: 'custom' };
    }

    return { known: false, type: 'unknown' };
  }

  private toFieldType(raw: string | undefined): FieldValidationResult['type'] {
    if (!raw) return 'unknown';
    if (raw === 'duration') return 'duration';
    if (raw === 'count') return 'count';
    if (raw === 'string') return 'string';
    return 'unknown';
  }

  // -------------------------------------------------------------------------
  // Aggregate validation
  // -------------------------------------------------------------------------

  validateAggregate(aggregate: string, fieldType: string): AggregateValidationResult {
    if (!this.dashboardSchema.aggregates.includes(aggregate)) {
      return { valid: false, confidence: 'high' };
    }

    const compat = this.dashboardSchema.aggregateFieldCompat[aggregate];
    if (!compat || !compat.includes(fieldType)) {
      // Aggregate exists but field type compatibility is uncertain
      return { valid: true, confidence: 'low' };
    }

    return { valid: true, confidence: 'high' };
  }

  // -------------------------------------------------------------------------
  // Display type validation
  // -------------------------------------------------------------------------

  validateDisplayType(type: string): DisplayTypeValidationResult {
    return { known: this.dashboardSchema.displayTypes.includes(type) };
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

export const constraintRegistry = new ConstraintRegistry();
