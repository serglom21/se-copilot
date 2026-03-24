import { CapturedTrace, CapturedSpan } from './trace-ingest';
import { EngagementSpec } from '../../src/types/spec';
import { UserFlow } from './live-data-generator';

export type IssueKind =
  | 'missing_spec_span'
  | 'orphan_span'
  | 'disconnected_be_root'
  | 'child_outside_parent_bounds'
  | 'zero_duration_io'
  | 'zero_duration_transaction'
  | 'nonstandard_op'
  | 'http_description_has_host'
  | 'http_description_unparameterized'
  | 'http_description_root_only'
  | 'missing_http_status_code'
  | 'missing_http_method'
  | 'missing_server_address'
  | 'missing_db_attributes'
  | 'no_pageload_transaction'
  | 'no_be_transaction_for_fe'
  | 'parent_duration_gap';

export interface TraceIssue {
  kind: IssueKind;
  traceId?: string;
  spanId?: string;
  spanName?: string;
  detail: string;
  fixable: boolean;
  severity: 'fatal' | 'error' | 'warning';
  /** Flows that cover the affected span — populated from UserFlow.coversSpans */
  affectedFlows: string[];
  /** For surgical repair: which file to patch */
  repairTarget?: 'frontend_instrumentation' | 'backend_routes' | 'frontend_sentry_config' | 'flows';
}

// Sentry semantic op allowlist
const VALID_OPS = new Set([
  'pageload', 'navigation',
  'http.client', 'http.server',
  'db', 'db.query', 'db.sql.query',
  'cache.get', 'cache.set', 'cache.put', 'cache.flush',
  'ui.render', 'ui.action', 'ui.domContentLoaded', 'ui.pageLoad', 'ui.load',
  'browser.paint', 'browser.resource',
  'network.http.request',
  'function', 'task', 'rpc', 'graphql',
  'serialize', 'deserialize',
  'websocket.client', 'websocket.server',
]);

const OP_REMAP: Record<string, string> = {
  'browser.domContentLoadedEvent': 'ui.domContentLoaded',
  'browser.loadEvent': 'ui.pageLoad',
  'browser.connect': 'network.http.request',
  'router.express': 'http.server',
  'middleware.express': 'http.server',
  'function.nextjs': 'http.server',
  'request_handler.express': 'http.server',
  'resource.link': 'browser.resource',
  'resource.script': 'browser.resource',
  'paint': 'browser.paint',
  'api-call': 'http.client',
  'database': 'db.query',
  'render': 'ui.render',
};

const IO_OPS = new Set(['db', 'db.query', 'db.sql.query', 'http.client', 'http.server', 'cache.get', 'cache.set', 'cache.put']);

export function validateTraces(
  traces: CapturedTrace[],
  spec: EngagementSpec,
  flows: UserFlow[] = []
): TraceIssue[] {
  const issues: TraceIssue[] = [];
  const isBackendOnly = spec.stack.type === 'backend-only';

  // Build flow coverage index: spanName → flow names that cover it
  const spanFlowIndex = buildSpanFlowIndex(flows);

  // ── Check 1: Missing spec spans ──────────────────────────────────────────
  for (const specSpan of spec.instrumentation.spans) {
    const found = traces.some(t =>
      t.allSpans.some(s => s.description === specSpan.name)
    );
    if (!found) {
      const affectedFlows = spanFlowIndex.get(specSpan.name) ?? [];
      issues.push({
        kind: 'missing_spec_span',
        spanName: specSpan.name,
        detail: `Spec span "${specSpan.name}" (op: ${specSpan.op}, layer: ${specSpan.layer}) never appeared in any captured trace`,
        fixable: false,
        severity: 'fatal',
        affectedFlows,
        repairTarget: specSpan.layer === 'frontend' ? 'frontend_instrumentation' : 'backend_routes',
      });
    }
  }

  // ── Checks 15 & 16: Transaction-level existence ──────────────────────────
  if (!isBackendOnly) {
    const hasPageload = traces.some(t =>
      t.allSpans.some(s => s.op === 'pageload' || s.op === 'navigation')
    );
    if (!hasPageload) {
      issues.push({
        kind: 'no_pageload_transaction',
        detail: 'No pageload or navigation transaction found in any trace. Frontend Sentry SDK is not initialized or deferred.',
        fixable: false,
        severity: 'fatal',
        affectedFlows: [],
        repairTarget: 'frontend_sentry_config',
      });
    }

    // Check FE traces that have no corresponding BE transaction
    const feTraces = traces.filter(t =>
      t.allSpans.some(s => s.op === 'pageload' || s.op === 'navigation')
    );
    for (const feTrace of feTraces) {
      const hasBeTransaction = feTrace.transactions.some(tx => tx.op === 'http.server');
      if (!hasBeTransaction) {
        issues.push({
          kind: 'no_be_transaction_for_fe',
          traceId: feTrace.trace_id,
          detail: `FE trace ${feTrace.trace_id.slice(0, 8)} has no corresponding BE transaction. The sentry-trace header is not being propagated or honored.`,
          fixable: false,
          severity: 'fatal',
          affectedFlows: [],
          repairTarget: 'backend_routes',
        });
      }
    }
  }

  // ── Per-trace span checks ─────────────────────────────────────────────────
  for (const trace of traces) {
    const spanMap = new Map(trace.allSpans.map(s => [s.span_id, s]));
    const spanIds = new Set(trace.allSpans.map(s => s.span_id).filter(Boolean));

    const hasFeRoot = trace.allSpans.some(s => s.op === 'pageload' || s.op === 'navigation');

    for (const span of trace.allSpans) {
      // ── Check 2: Orphan spans ───────────────────────────────────────────
      if (span.parent_span_id && !spanIds.has(span.parent_span_id)) {
        issues.push({
          kind: 'orphan_span',
          traceId: trace.trace_id,
          spanId: span.span_id,
          spanName: span.description,
          detail: `Span "${span.description}" (${span.span_id.slice(0, 8)}) references parent "${span.parent_span_id.slice(0, 8)}" which does not exist in this trace`,
          fixable: true,
          severity: 'fatal',
          affectedFlows: spanFlowIndex.get(span.description) ?? [],
        });
      }

      // ── Check 3: Disconnected BE root ──────────────────────────────────
      if (hasFeRoot && span.op === 'http.server' && !span.parent_span_id) {
        issues.push({
          kind: 'disconnected_be_root',
          traceId: trace.trace_id,
          spanId: span.span_id,
          spanName: span.description,
          detail: `BE transaction "${span.description}" has no parent despite FE root existing in same trace. The sentry-trace header was not propagated.`,
          fixable: true, // re-parent to FE root — structural fix; code is still wrong
          severity: 'fatal',
          affectedFlows: [],
          repairTarget: 'backend_routes',
        });
      }

      // ── Check 4: Child outside parent bounds ───────────────────────────
      if (span.parent_span_id) {
        const parent = spanMap.get(span.parent_span_id);
        if (parent) {
          const startViolation = span.start_timestamp < parent.start_timestamp - 0.001;
          const endViolation = span.timestamp > parent.timestamp + 0.001;
          if (startViolation || endViolation) {
            issues.push({
              kind: 'child_outside_parent_bounds',
              traceId: trace.trace_id,
              spanId: span.span_id,
              spanName: span.description,
              detail: `Span "${span.description}" [${fmt(span.start_timestamp)}, ${fmt(span.timestamp)}] exceeds parent "${parent.description}" [${fmt(parent.start_timestamp)}, ${fmt(parent.timestamp)}]`,
              fixable: true,
              severity: 'error',
              affectedFlows: [],
            });
          }
        }
      }

      // ── Check 5: Zero-duration I/O span ────────────────────────────────
      if (IO_OPS.has(span.op)) {
        const duration = span.timestamp - span.start_timestamp;
        if (duration < 0.001) {
          issues.push({
            kind: 'zero_duration_io',
            traceId: trace.trace_id,
            spanId: span.span_id,
            spanName: span.description,
            detail: `I/O span "${span.description}" (op: ${span.op}) has ~0ms duration. The actual async operation was not awaited inside the span callback.`,
            fixable: true,
            severity: 'error',
            affectedFlows: [],
          });
        }
      }

      // ── Check 7: Non-standard op value ─────────────────────────────────
      if (!VALID_OPS.has(span.op) && !OP_REMAP[span.op]) {
        issues.push({
          kind: 'nonstandard_op',
          traceId: trace.trace_id,
          spanId: span.span_id,
          spanName: span.description,
          detail: `Span "${span.description}" has non-standard op "${span.op}". Must use Sentry semantic conventions.`,
          fixable: false, // unknown op — no safe remap
          severity: 'warning',
          affectedFlows: [],
        });
      } else if (OP_REMAP[span.op]) {
        issues.push({
          kind: 'nonstandard_op',
          traceId: trace.trace_id,
          spanId: span.span_id,
          spanName: span.description,
          detail: `Span "${span.description}" uses deprecated op "${span.op}" — should be "${OP_REMAP[span.op]}"`,
          fixable: true,
          severity: 'error',
          affectedFlows: [],
        });
      }

      // ── Checks 8 & 9: HTTP description format ─────────────────────────
      if (span.op === 'http.client' || span.op === 'http.server') {
        if (/^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+https?:\/\//i.test(span.description)) {
          issues.push({
            kind: 'http_description_has_host',
            traceId: trace.trace_id,
            spanId: span.span_id,
            spanName: span.description,
            detail: `HTTP span description contains full URL: "${span.description}". Should be "METHOD /path" only.`,
            fixable: true,
            severity: 'error',
            affectedFlows: [],
          });
        } else if (/\/([\d]{2,})(\/|$)/.test(span.description) || /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(span.description)) {
          issues.push({
            kind: 'http_description_unparameterized',
            traceId: trace.trace_id,
            spanId: span.span_id,
            spanName: span.description,
            detail: `HTTP span description contains raw IDs: "${span.description}". Should use :id / :uuid parameters.`,
            fixable: true,
            severity: 'error',
            affectedFlows: [],
          });
        } else if (/^(GET|POST|PUT|DELETE|PATCH)\s+\/$/.test(span.description.trim())) {
          issues.push({
            kind: 'http_description_root_only',
            traceId: trace.trace_id,
            spanId: span.span_id,
            spanName: span.description,
            detail: `HTTP span has generic root description: "${span.description}". Express sub-router mounting is likely wrong.`,
            fixable: false,
            severity: 'error',
            affectedFlows: [],
            repairTarget: 'backend_routes',
          });
        }

        // ── Check 11: Missing http.status_code ─────────────────────────
        if (!span.data?.['http.status_code'] && span.data?.['http.status_code'] !== 0) {
          issues.push({
            kind: 'missing_http_status_code',
            traceId: trace.trace_id,
            spanId: span.span_id,
            spanName: span.description,
            detail: `HTTP span "${span.description}" is missing http.status_code attribute`,
            fixable: true,
            severity: 'error',
            affectedFlows: [],
          });
        }

        // ── Check 12: Missing http.method ──────────────────────────────
        if (!span.data?.['http.method']) {
          issues.push({
            kind: 'missing_http_method',
            traceId: trace.trace_id,
            spanId: span.span_id,
            spanName: span.description,
            detail: `HTTP span "${span.description}" is missing http.method attribute`,
            fixable: true,
            severity: 'error',
            affectedFlows: [],
          });
        }

        // ── Check 13: Missing server.address (http.server only) ────────
        if (span.op === 'http.server' && !span.data?.['server.address']) {
          issues.push({
            kind: 'missing_server_address',
            traceId: trace.trace_id,
            spanId: span.span_id,
            spanName: span.description,
            detail: `HTTP server span "${span.description}" is missing server.address attribute`,
            fixable: true,
            severity: 'warning',
            affectedFlows: [],
          });
        }
      }

      // ── Check 14: Missing DB attributes ───────────────────────────────
      if (span.op === 'db' || span.op === 'db.query' || span.op === 'db.sql.query') {
        const missingFields: string[] = [];
        if (!span.data?.['db.system']) missingFields.push('db.system');
        if (!span.data?.['db.name']) missingFields.push('db.name');
        if (!span.data?.['db.statement'] && !span.data?.['db.operation']) missingFields.push('db.statement or db.operation');
        if (missingFields.length > 0) {
          issues.push({
            kind: 'missing_db_attributes',
            traceId: trace.trace_id,
            spanId: span.span_id,
            spanName: span.description,
            detail: `DB span "${span.description}" is missing required attributes: ${missingFields.join(', ')}`,
            fixable: true,
            severity: 'error',
            affectedFlows: [],
          });
        }
      }
    }

    // ── Check 6: Zero-duration transactions ────────────────────────────────
    for (const tx of trace.transactions) {
      if (tx.timestamp - tx.start_timestamp < 0.001) {
        issues.push({
          kind: 'zero_duration_transaction',
          traceId: trace.trace_id,
          spanId: tx.span_id,
          spanName: tx.transaction,
          detail: `Transaction "${tx.transaction}" has ~0ms duration — it was never properly closed`,
          fixable: true,
          severity: 'error',
          affectedFlows: [],
        });
      }
    }

    // ── Check 17: Parent duration gap (warning only) ───────────────────────
    checkParentDurationGaps(trace, issues);
  }

  return deduplicateIssues(issues);
}

function checkParentDurationGaps(trace: CapturedTrace, issues: TraceIssue[]): void {
  const spanMap = new Map(trace.allSpans.map(s => [s.span_id, s]));
  const childDurationSum = new Map<string, number>();

  for (const span of trace.allSpans) {
    if (span.parent_span_id && spanMap.has(span.parent_span_id)) {
      const existing = childDurationSum.get(span.parent_span_id) ?? 0;
      childDurationSum.set(span.parent_span_id, existing + (span.timestamp - span.start_timestamp));
    }
  }

  for (const [parentId, childSum] of childDurationSum.entries()) {
    const parent = spanMap.get(parentId);
    if (!parent) continue;
    const parentDuration = parent.timestamp - parent.start_timestamp;
    const gapMs = (parentDuration - childSum) * 1000;
    if (parentDuration > childSum * 2 && gapMs > 100) {
      issues.push({
        kind: 'parent_duration_gap',
        traceId: trace.trace_id,
        spanId: parentId,
        spanName: parent.description,
        detail: `Span "${parent.description}" has ${Math.round(gapMs)}ms of unaccounted time (parent: ${Math.round(parentDuration * 1000)}ms, children sum: ${Math.round(childSum * 1000)}ms). Consider adding intermediate spans.`,
        fixable: false,
        severity: 'warning',
        affectedFlows: [],
      });
    }
  }
}

/** Build index: spanName → flow names that cover it */
function buildSpanFlowIndex(flows: UserFlow[]): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const flow of flows) {
    for (const spanName of flow.coversSpans ?? []) {
      const existing = index.get(spanName) ?? [];
      if (!existing.includes(flow.name)) existing.push(flow.name);
      index.set(spanName, existing);
    }
  }
  return index;
}

/** Remove exact duplicate issues (same kind + spanId) */
function deduplicateIssues(issues: TraceIssue[]): TraceIssue[] {
  const seen = new Set<string>();
  return issues.filter(issue => {
    const key = `${issue.kind}:${issue.spanId ?? ''}:${issue.traceId ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function fmt(ts: number): string {
  return `${(ts * 1000).toFixed(0)}ms`;
}

/** Summary for logging */
export function summarizeIssues(issues: TraceIssue[]): string {
  const counts: Record<string, number> = {};
  for (const issue of issues) {
    counts[issue.kind] = (counts[issue.kind] ?? 0) + 1;
  }
  return Object.entries(counts)
    .map(([kind, count]) => `${kind}: ${count}`)
    .join(', ');
}
