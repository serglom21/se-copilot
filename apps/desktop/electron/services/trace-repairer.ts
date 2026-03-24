import { CapturedTrace, CapturedSpan } from './trace-ingest';
import { TraceIssue } from './trace-validator';
import { EngagementSpec } from '../../src/types/spec';

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

/**
 * Apply all auto-fixable repairs in-memory to the captured traces.
 * Returns new trace objects — originals are not mutated.
 * Mutated spans are marked with data.repaired = true for envelope merge tracking.
 */
export function repairTraces(
  traces: CapturedTrace[],
  issues: TraceIssue[],
  spec: EngagementSpec
): CapturedTrace[] {
  // Clone traces so originals stay intact (needed for raw envelope diff)
  const cloned = deepCloneTraces(traces);

  for (const trace of cloned) {
    const spanMap = new Map(trace.allSpans.map(s => [s.span_id, s]));

    for (const issue of issues) {
      if (issue.traceId && issue.traceId !== trace.trace_id) continue;
      if (!issue.fixable) continue;

      const span = issue.spanId ? spanMap.get(issue.spanId) : undefined;

      switch (issue.kind) {
        case 'orphan_span':
          if (span) repairOrphanSpan(span, trace, spanMap);
          break;

        case 'disconnected_be_root':
          if (span) repairDisconnectedBeRoot(span, trace);
          break;

        case 'child_outside_parent_bounds':
          if (span && span.parent_span_id) {
            const parent = spanMap.get(span.parent_span_id);
            if (parent) repairTimingBounds(span, parent);
          }
          break;

        case 'zero_duration_io':
          if (span) repairZeroDurationIo(span);
          break;

        case 'zero_duration_transaction': {
          const tx = trace.transactions.find(t => t.span_id === issue.spanId);
          if (tx) repairZeroDurationTransaction(tx, trace);
          break;
        }

        case 'nonstandard_op':
          if (span && OP_REMAP[span.op]) {
            markRepaired(span);
            span.op = OP_REMAP[span.op];
          }
          break;

        case 'http_description_has_host':
          if (span) {
            markRepaired(span);
            span.description = span.description.replace(/^((GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+)https?:\/\/[^/]+/i, '$1');
          }
          break;

        case 'http_description_unparameterized':
          if (span) {
            markRepaired(span);
            // Replace UUIDs first, then numeric segments
            span.description = span.description
              .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:uuid')
              .replace(/\/(\d{2,})(\/|$)/g, '/:id$2');
          }
          break;

        case 'missing_http_status_code':
          if (span) {
            markRepaired(span);
            span.data = span.data ?? {};
            span.data['http.status_code'] = inferStatusCode(span);
          }
          break;

        case 'missing_http_method':
          if (span) {
            markRepaired(span);
            span.data = span.data ?? {};
            span.data['http.method'] = extractMethodFromDescription(span.description) ?? 'GET';
          }
          break;

        case 'missing_server_address':
          if (span) {
            markRepaired(span);
            span.data = span.data ?? {};
            span.data['server.address'] = span.data['server.address'] ?? 'localhost';
            span.data['http.host'] = span.data['http.host'] ?? 'localhost';
          }
          break;

        case 'missing_db_attributes':
          if (span) repairDbAttributes(span, spec);
          break;
      }
    }

    // Sync transaction root spans with repaired allSpans data
    syncTransactionRoots(trace);
  }

  return cloned;
}

// ── Repair implementations ────────────────────────────────────────────────────

function repairOrphanSpan(
  span: CapturedSpan,
  trace: CapturedTrace,
  spanMap: Map<string, CapturedSpan>
): void {
  // Find the best transaction root to re-parent to
  const root = findBestRoot(span, trace, spanMap);
  if (root) {
    markRepaired(span);
    span.parent_span_id = root.span_id;
  }
}

function repairDisconnectedBeRoot(span: CapturedSpan, trace: CapturedTrace): void {
  // Find the FE root (pageload/navigation) and link the BE root to it
  const feRoot = trace.allSpans.find(s => s.op === 'pageload' || s.op === 'navigation');
  if (feRoot) {
    markRepaired(span);
    span.parent_span_id = feRoot.span_id;
  }
}

function repairTimingBounds(span: CapturedSpan, parent: CapturedSpan): void {
  markRepaired(span);
  if (span.start_timestamp < parent.start_timestamp) {
    span.start_timestamp = parent.start_timestamp;
  }
  if (span.timestamp > parent.timestamp) {
    span.timestamp = parent.timestamp;
  }
  // Ensure non-negative duration after clamping
  if (span.timestamp < span.start_timestamp) {
    span.timestamp = span.start_timestamp;
  }
}

function repairZeroDurationIo(span: CapturedSpan): void {
  markRepaired(span);
  span.timestamp = span.start_timestamp + 0.01; // 10ms synthetic duration
  span.data = span.data ?? {};
  span.data['synthetic_duration'] = true;
}

function repairZeroDurationTransaction(
  tx: { start_timestamp: number; timestamp: number; span_id: string },
  trace: CapturedTrace
): void {
  const children = trace.allSpans.filter(s => s.parent_span_id === tx.span_id);
  const childrenDuration = children.reduce((sum, s) => sum + (s.timestamp - s.start_timestamp), 0);
  tx.timestamp = tx.start_timestamp + Math.max(childrenDuration, 0.1);
}

function repairDbAttributes(span: CapturedSpan, spec: EngagementSpec): void {
  markRepaired(span);
  span.data = span.data ?? {};
  if (!span.data['db.system']) {
    span.data['db.system'] = inferDbSystem(spec);
  }
  if (!span.data['db.name']) {
    span.data['db.name'] = 'app_db';
  }
  if (!span.data['db.statement'] && !span.data['db.operation']) {
    // Try to extract operation from db.statement if present
    const stmt = span.data['db.statement'] as string | undefined;
    span.data['db.operation'] = stmt ? stmt.trim().split(/\s+/)[0].toUpperCase() : 'QUERY';
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function findBestRoot(
  span: CapturedSpan,
  trace: CapturedTrace,
  spanMap: Map<string, CapturedSpan>
): CapturedSpan | undefined {
  // Prefer a transaction root that temporally contains this span
  const roots = trace.allSpans.filter(s => !s.parent_span_id);
  const containing = roots.filter(
    r => r.start_timestamp <= span.start_timestamp && r.timestamp >= span.timestamp
  );
  if (containing.length > 0) {
    // Pick the tightest containing root
    return containing.sort(
      (a, b) => (a.timestamp - a.start_timestamp) - (b.timestamp - b.start_timestamp)
    )[0];
  }
  // Fall back to any root — prefer pageload > http.server
  return (
    roots.find(s => s.op === 'pageload' || s.op === 'navigation') ??
    roots.find(s => s.op === 'http.server') ??
    roots[0]
  );
}

function inferStatusCode(span: CapturedSpan): number {
  const status = span.status;
  if (!status || status === 'ok') return 200;
  if (status === 'not_found') return 404;
  if (status === 'unauthenticated') return 401;
  if (status === 'permission_denied') return 403;
  if (status === 'resource_exhausted') return 429;
  if (status === 'internal_error' || status === 'unknown_error') return 500;
  if (status === 'unimplemented') return 501;
  if (status === 'unavailable') return 503;
  return 200;
}

function extractMethodFromDescription(description: string): string | undefined {
  const match = description.match(/^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s/i);
  return match ? match[1].toUpperCase() : undefined;
}

function inferDbSystem(spec: EngagementSpec): string {
  const backend = spec.stack.backend;
  if (backend === 'flask' || backend === 'fastapi') return 'postgresql';
  if (backend === 'express') return 'postgresql';
  return 'postgresql';
}

function markRepaired(span: CapturedSpan): void {
  span.data = span.data ?? {};
  (span.data as any)['_repaired'] = true;
}

function syncTransactionRoots(trace: CapturedTrace): void {
  for (const tx of trace.transactions) {
    const rootSpan = trace.allSpans.find(s => s.span_id === tx.span_id);
    if (rootSpan) {
      tx.timestamp = rootSpan.timestamp;
      tx.start_timestamp = rootSpan.start_timestamp;
    }
  }
}

function deepCloneTraces(traces: CapturedTrace[]): CapturedTrace[] {
  return JSON.parse(JSON.stringify(traces));
}

/** Returns which span IDs were mutated (for raw envelope merge step) */
export function getRepairedSpanIds(
  original: CapturedTrace[],
  repaired: CapturedTrace[]
): Set<string> {
  const mutated = new Set<string>();
  const originalMap = new Map(
    original.flatMap(t => t.allSpans).map(s => [s.span_id, s])
  );
  for (const trace of repaired) {
    for (const span of trace.allSpans) {
      const orig = originalMap.get(span.span_id);
      if (!orig) continue;
      if (JSON.stringify(orig) !== JSON.stringify(span)) {
        mutated.add(span.span_id);
      }
    }
  }
  return mutated;
}
