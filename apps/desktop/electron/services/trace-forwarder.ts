import { CapturedTrace, CapturedTransaction, CapturedSpan, StoredEnvelope } from './trace-ingest';

interface ParsedDsn {
  envelopeUrl: string;
  authHeader: string;
  isFrontend: boolean;
}

/**
 * Forward validated, repaired traces to real Sentry.
 *
 * Strategy:
 * - For envelopes with no repairs: forward raw bytes as-is (full fidelity — keeps measurements, breadcrumbs, etc.)
 * - For envelopes with repaired spans: reconstruct only the mutated items, keep all other items from raw bytes
 */
export async function forwardTracesToSentry(
  traces: CapturedTrace[],
  rawEnvelopes: StoredEnvelope[],
  frontendDsn: string,
  backendDsn: string,
  repairedSpanIds: Set<string>,
  onOutput: (msg: string) => void
): Promise<{ forwarded: number; errors: string[] }> {
  const parsedFe = parseDsn(frontendDsn, true);
  const parsedBe = parseDsn(backendDsn, false);

  let forwarded = 0;
  const errors: string[] = [];

  for (const trace of traces) {
    for (const tx of trace.transactions) {
      const dsn = selectDsn(tx, parsedFe, parsedBe);

      // Find the raw envelope(s) that contain this transaction
      const matchingEnvelopes = rawEnvelopes.filter(e => e.traceId === trace.trace_id);

      if (matchingEnvelopes.length === 0) {
        // No raw envelope — reconstruct from parsed data (last resort)
        onOutput(`   ⚠ No raw envelope for trace ${trace.trace_id.slice(0, 8)}, reconstructing\n`);
        const body = reconstructEnvelope(tx, trace.allSpans, repairedSpanIds);
        const err = await postEnvelope(dsn, body);
        if (err) errors.push(err);
        else forwarded++;
        continue;
      }

      for (const envelope of matchingEnvelopes) {
        // If this envelope has repaired spans, merge repairs into raw bytes
        const hasRepairs = trace.allSpans.some(s => repairedSpanIds.has(s.span_id));
        const body = hasRepairs
          ? mergeRepairsIntoRaw(envelope.raw, trace, repairedSpanIds)
          : envelope.raw;

        const err = await postEnvelope(dsn, body);
        if (err) errors.push(err);
        else forwarded++;
      }
    }
  }

  return { forwarded, errors };
}

// ── DSN handling ─────────────────────────────────────────────────────────────

export function parseDsn(dsn: string, isFrontend: boolean): ParsedDsn {
  try {
    const url = new URL(dsn);
    const publicKey = url.username;
    const host = url.host;
    const projectId = url.pathname.replace(/^\//, '');
    return {
      envelopeUrl: `https://${host}/api/${projectId}/envelope/`,
      authHeader: `Sentry sentry_version=7, sentry_key=${publicKey}`,
      isFrontend,
    };
  } catch {
    throw new Error(`Invalid Sentry DSN: ${dsn}`);
  }
}

function selectDsn(
  tx: CapturedTransaction,
  feDsn: ParsedDsn,
  beDsn: ParsedDsn
): ParsedDsn {
  const sdk = tx.sdk ?? '';
  // BE transaction: Python SDK or Node.js http.server
  if (sdk.includes('python') || (sdk.includes('node') && tx.op === 'http.server')) {
    return beDsn;
  }
  // FE transaction: browser SDK or pageload/navigation
  if (sdk.includes('browser') || sdk.includes('javascript') || tx.op === 'pageload' || tx.op === 'navigation') {
    return feDsn;
  }
  // Fallback: use BE for http.server, FE for everything else
  return tx.op === 'http.server' ? beDsn : feDsn;
}

// ── Raw envelope forwarding ───────────────────────────────────────────────────

/**
 * Merge repaired span data back into the raw envelope bytes.
 * Only touches envelope items that contain a repaired span — everything else
 * (measurements, breadcrumbs, user context, etc.) comes from the raw bytes untouched.
 */
function mergeRepairsIntoRaw(
  raw: Buffer,
  trace: CapturedTrace,
  repairedSpanIds: Set<string>
): Buffer {
  const text = raw.toString('utf8');
  const lines = text.split('\n');
  const output: string[] = [];
  let i = 0;

  // Skip/copy envelope header
  while (i < lines.length && !lines[i].trim()) { output.push(lines[i]); i++; }
  if (i < lines.length) { output.push(lines[i]); i++; } // envelope header

  while (i < lines.length) {
    while (i < lines.length && !lines[i].trim()) { output.push(lines[i]); i++; }
    if (i >= lines.length) break;

    const itemHeaderLine = lines[i];
    output.push(itemHeaderLine);
    i++;

    while (i < lines.length && !lines[i].trim()) { output.push(lines[i]); i++; }
    if (i >= lines.length) break;

    const itemBodyLine = lines[i];
    i++;

    let itemHeader: any;
    try { itemHeader = JSON.parse(itemHeaderLine); } catch { output.push(itemBodyLine); continue; }

    if (itemHeader.type === 'transaction') {
      let body: any;
      try { body = JSON.parse(itemBodyLine); } catch { output.push(itemBodyLine); continue; }

      // Merge repaired spans into the transaction body
      if (Array.isArray(body.spans)) {
        body.spans = body.spans.map((rawSpan: any) => {
          if (!repairedSpanIds.has(rawSpan.span_id)) return rawSpan;
          const repairedSpan = trace.allSpans.find(s => s.span_id === rawSpan.span_id);
          if (!repairedSpan) return rawSpan;
          return {
            ...rawSpan,
            op: repairedSpan.op,
            description: repairedSpan.description,
            parent_span_id: repairedSpan.parent_span_id,
            start_timestamp: repairedSpan.start_timestamp,
            timestamp: repairedSpan.timestamp,
            data: { ...rawSpan.data, ...repairedSpan.data },
          };
        });
      }

      // Merge root span repairs (the transaction itself may be repaired)
      const rootSpan = trace.allSpans.find(s => s.span_id === body.contexts?.trace?.span_id);
      if (rootSpan && repairedSpanIds.has(rootSpan.span_id)) {
        body.timestamp = rootSpan.timestamp;
        body.start_timestamp = rootSpan.start_timestamp;
        if (body.contexts?.trace) {
          body.contexts.trace.parent_span_id = rootSpan.parent_span_id;
        }
      }

      output.push(JSON.stringify(body));
    } else {
      output.push(itemBodyLine);
    }
  }

  return Buffer.from(output.join('\n'), 'utf8');
}

// ── Fallback: reconstruct envelope from parsed data ───────────────────────────

/**
 * Reconstruct a Sentry envelope from parsed CapturedTransaction + spans.
 * Used only when no raw envelope is available (should be rare).
 * NOTE: This loses measurements, breadcrumbs, and other transaction-level data.
 */
function reconstructEnvelope(
  tx: CapturedTransaction,
  allSpans: CapturedSpan[],
  repairedSpanIds: Set<string>
): Buffer {
  const envelopeHeader = JSON.stringify({
    event_id: tx.event_id,
    sent_at: new Date().toISOString(),
    sdk: { name: tx.sdk ?? 'sentry.javascript.browser', version: '8.0.0' },
  });

  const itemHeader = JSON.stringify({ type: 'transaction', length: 0 });

  const childSpans = allSpans
    .filter(s => s.trace_id === tx.trace_id && s.span_id !== tx.span_id && s.parent_span_id);

  const item = JSON.stringify({
    type: 'transaction',
    transaction: tx.transaction,
    event_id: tx.event_id,
    start_timestamp: tx.start_timestamp,
    timestamp: tx.timestamp,
    contexts: {
      trace: {
        trace_id: tx.trace_id,
        span_id: tx.span_id,
        parent_span_id: tx.parent_span_id ?? undefined,
        op: tx.op,
        status: 'ok',
      },
    },
    spans: childSpans.map(s => ({
      span_id: s.span_id,
      parent_span_id: s.parent_span_id,
      trace_id: s.trace_id,
      op: s.op,
      description: s.description,
      start_timestamp: s.start_timestamp,
      timestamp: s.timestamp,
      status: s.status ?? 'ok',
      origin: s.origin,
      data: s.data ?? {},
      tags: s.tags ?? {},
    })),
    sdk: { name: tx.sdk ?? 'sentry.javascript.browser', version: '8.0.0' },
    environment: 'production',
  });

  return Buffer.from(`${envelopeHeader}\n${itemHeader}\n${item}\n`, 'utf8');
}

// ── HTTP post ─────────────────────────────────────────────────────────────────

async function postEnvelope(dsn: ParsedDsn, body: Buffer): Promise<string | null> {
  try {
    const response = await fetch(dsn.envelopeUrl, {
      method: 'POST',
      headers: {
        'X-Sentry-Auth': dsn.authHeader,
        'Content-Type': 'application/x-sentry-envelope',
        'Content-Length': String(body.length),
      },
      body,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return `Sentry rejected envelope: ${response.status} ${text.slice(0, 200)}`;
    }
    return null;
  } catch (err: any) {
    return `Failed to forward envelope: ${err?.message ?? err}`;
  }
}
