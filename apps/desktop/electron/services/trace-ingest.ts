import http from 'http';
import { EventEmitter } from 'events';
import zlib from 'zlib';

export interface CapturedSpan {
  span_id: string;
  parent_span_id: string | null;
  trace_id: string;
  op: string;
  description: string;
  start_timestamp: number;
  timestamp: number;
  status?: string;
  origin?: string;  // e.g. 'auto.http.browser', 'auto.db', 'manual' — set by Sentry SDK
  data?: Record<string, any>;
  tags?: Record<string, string>;
}

export interface CapturedTransaction {
  event_id: string;
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  transaction: string;
  timestamp: number;
  start_timestamp: number;
  op: string;
  spans: CapturedSpan[];
  sdk?: string;
  capturedAt: number;
}

export interface CapturedTrace {
  trace_id: string;
  transactions: CapturedTransaction[];
  allSpans: CapturedSpan[];
  orphanSpanIds: string[];
  score: number;
  grade: string;
  capturedAt: number;
}

export interface StoredEnvelope {
  raw: Buffer;
  traceId: string;
  receivedAt: number;
}

export class TraceIngestService extends EventEmitter {
  private server: http.Server | null = null;
  private readonly port: number;
  private traces = new Map<string, CapturedTrace>();
  private rawEnvelopes = new Map<string, StoredEnvelope[]>(); // traceId → envelopes

  constructor(port = 9999) {
    super();
    this.port = port;
  }

  async start(): Promise<void> {
    if (this.server?.listening) return;
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', '*');

        if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

        if (req.method === 'POST' && req.url?.includes('/envelope/')) {
          const chunks: Buffer[] = [];
          req.on('data', chunk => chunks.push(chunk));
          req.on('end', () => {
            const buf = Buffer.concat(chunks);
            const encoding = req.headers['content-encoding'];
            if (encoding === 'gzip') {
              zlib.gunzip(buf, (err, result) => {
                if (!err) {
                  const text = result.toString('utf8');
                  const traceId = this.extractTraceIdFromEnvelope(text);
                  if (traceId) this.storeRawEnvelope(traceId, result);
                  this.tryParse(text);
                }
              });
            } else {
              const text = buf.toString('utf8');
              const traceId = this.extractTraceIdFromEnvelope(text);
              if (traceId) this.storeRawEnvelope(traceId, buf);
              this.tryParse(text);
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{}');
          });
          return;
        }
        res.writeHead(200); res.end('{}');
      });

      this.server.on('error', reject);
      this.server.listen(this.port, '127.0.0.1', () => resolve());
    });
  }

  stop(): void {
    this.server?.close();
    this.server = null;
  }

  clear(): void {
    this.traces.clear();
    this.rawEnvelopes.clear();
    this.emit('cleared');
  }

  getTraces(): CapturedTrace[] {
    return [...this.traces.values()].sort((a, b) => b.capturedAt - a.capturedAt);
  }

  getRawEnvelopes(traceId: string): StoredEnvelope[] {
    return this.rawEnvelopes.get(traceId) ?? [];
  }

  getAllRawEnvelopes(): StoredEnvelope[] {
    return [...this.rawEnvelopes.values()].flat();
  }

  getLocalDsn(): string {
    return `http://localingest@127.0.0.1:${this.port}/0`;
  }

  isRunning(): boolean {
    return this.server?.listening ?? false;
  }

  /**
   * Wait until no new envelopes have arrived for quietMs milliseconds.
   * Resolves with all traces collected so far.
   * Use after all flows complete to ensure distributed traces have fully settled.
   */
  waitForAllQuiet(quietMs = 2000): Promise<CapturedTrace[]> {
    return new Promise(resolve => {
      let timer: ReturnType<typeof setTimeout>;

      const reschedule = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          this.off('trace-updated', reschedule);
          resolve(this.getTraces());
        }, quietMs);
      };

      this.on('trace-updated', reschedule);
      reschedule(); // start the timer immediately
    });
  }

  /**
   * Wait until a specific trace goes quiet (no new spans for quietMs ms).
   */
  waitForTraceQuiet(traceId: string, quietMs = 2000): Promise<CapturedTrace | undefined> {
    return new Promise(resolve => {
      let timer: ReturnType<typeof setTimeout>;

      const reschedule = (updated: CapturedTrace) => {
        if (updated.trace_id !== traceId) return;
        clearTimeout(timer);
        timer = setTimeout(() => {
          this.off('trace-updated', reschedule);
          resolve(this.traces.get(traceId));
        }, quietMs);
      };

      this.on('trace-updated', reschedule);
      reschedule(this.traces.get(traceId) ?? { trace_id: traceId } as CapturedTrace);
    });
  }

  private tryParse(body: string): void {
    try { this.parseEnvelope(body); } catch (e) {
      console.error('[TraceIngest] Parse error:', e);
    }
  }

  private parseEnvelope(raw: string): void {
    const lines = raw.split('\n');
    let i = 0;
    // Skip envelope header
    while (i < lines.length && !lines[i].trim()) i++;
    if (i >= lines.length) return;
    try { JSON.parse(lines[i]); } catch { return; }
    i++;

    while (i < lines.length) {
      // Skip blank lines
      while (i < lines.length && !lines[i].trim()) i++;
      if (i >= lines.length) break;

      let itemHeader: any;
      try { itemHeader = JSON.parse(lines[i]); i++; } catch { i++; continue; }

      // Skip blank lines between header and body
      while (i < lines.length && !lines[i].trim()) i++;
      if (i >= lines.length) break;

      let itemBody: any;
      try { itemBody = JSON.parse(lines[i]); i++; } catch { i++; continue; }

      if (itemHeader.type === 'transaction') this.ingestTransaction(itemBody);
      else if (itemHeader.type === 'span') this.ingestLooseSpan(itemBody);
    }
  }

  private ingestTransaction(tx: any): void {
    const traceCtx = tx.contexts?.trace || {};
    const traceId = traceCtx.trace_id || tx.trace_id;
    if (!traceId) return;

    const transaction: CapturedTransaction = {
      event_id: tx.event_id || '',
      trace_id: traceId,
      span_id: traceCtx.span_id || tx.span_id || '',
      parent_span_id: traceCtx.parent_span_id || null,
      transaction: tx.transaction || tx.name || 'unknown',
      timestamp: tx.timestamp || Date.now() / 1000,
      start_timestamp: tx.start_timestamp || Date.now() / 1000,
      op: traceCtx.op || tx.op || 'unknown',
      spans: (tx.spans || []).map((s: any) => this.normalizeSpan(s, traceId)),
      sdk: tx.sdk?.name,
      capturedAt: Date.now(),
    };

    let trace = this.traces.get(traceId);
    if (!trace) { trace = this.makeTrace(traceId); }

    trace.transactions.push(transaction);
    trace.capturedAt = transaction.capturedAt;

    // Add root span for this transaction
    trace.allSpans.push({
      span_id: transaction.span_id,
      parent_span_id: transaction.parent_span_id,
      trace_id: traceId,
      op: transaction.op,
      description: transaction.transaction,
      start_timestamp: transaction.start_timestamp,
      timestamp: transaction.timestamp,
      status: traceCtx.status || 'ok',
      origin: traceCtx.origin || tx.origin,
      data: traceCtx.data || {},
    });
    // Add child spans
    trace.allSpans.push(...transaction.spans);

    this.recompute(trace);
    this.traces.set(traceId, trace);
    this.emit('trace-updated', trace);
  }

  private ingestLooseSpan(span: any): void {
    const traceId = span.trace_id;
    if (!traceId) return;
    let trace = this.traces.get(traceId);
    if (!trace) { trace = this.makeTrace(traceId); }
    trace.allSpans.push(this.normalizeSpan(span, traceId));
    trace.capturedAt = Date.now();
    this.recompute(trace);
    this.traces.set(traceId, trace);
    this.emit('trace-updated', trace);
  }

  private normalizeSpan(s: any, traceId: string): CapturedSpan {
    return {
      span_id: s.span_id || '',
      parent_span_id: s.parent_span_id || null,
      trace_id: traceId,
      op: s.op || 'unknown',
      description: s.description || s.name || s.op || 'unknown',
      start_timestamp: s.start_timestamp || 0,
      timestamp: s.timestamp || s.start_timestamp || 0,
      status: s.status,
      origin: s.origin,  // top-level field in Sentry envelope — 'auto.*' = SDK-generated, 'manual' = custom
      data: s.data,
      tags: s.tags,
    };
  }

  private storeRawEnvelope(traceId: string, raw: Buffer): void {
    const existing = this.rawEnvelopes.get(traceId) ?? [];
    existing.push({ raw, traceId, receivedAt: Date.now() });
    this.rawEnvelopes.set(traceId, existing);
  }

  /** Fast extraction of trace_id from the first parseable JSON object in the envelope */
  private extractTraceIdFromEnvelope(text: string): string | null {
    const lines = text.split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        const id = obj?.trace_id
          || obj?.contexts?.trace?.trace_id
          || obj?.trace?.trace_id;
        if (id && typeof id === 'string') return id;
      } catch {
        // keep scanning
      }
    }
    return null;
  }

  private makeTrace(traceId: string): CapturedTrace {
    return { trace_id: traceId, transactions: [], allSpans: [], orphanSpanIds: [], score: 100, grade: 'A', capturedAt: Date.now() };
  }

  private recompute(trace: CapturedTrace): void {
    const spanIds = new Set(trace.allSpans.map(s => s.span_id).filter(Boolean));
    trace.orphanSpanIds = trace.allSpans
      .filter(s => s.parent_span_id && !spanIds.has(s.parent_span_id))
      .map(s => s.span_id);

    let score = 100;
    score -= trace.orphanSpanIds.length * 15;

    // Penalize GET / route names on BE
    const badRoutes = trace.allSpans.filter(
      s => s.op === 'http.server' && (s.description === 'GET /' || s.description === 'POST /' || s.description === '/')
    );
    score -= badRoutes.length * 10;

    // Check FE→BE connectivity: if there are both FE and BE transactions, BE root should have a parent
    const hasFeRoot = trace.allSpans.some(s => s.op === 'pageload' || s.op === 'navigation');
    const beRoots = trace.allSpans.filter(s => s.op === 'http.server' && !s.parent_span_id);
    if (hasFeRoot && beRoots.length > 0) score -= beRoots.length * 20; // orphaned BE roots

    trace.score = Math.max(0, score);
    if (trace.score >= 90) trace.grade = 'A';
    else if (trace.score >= 75) trace.grade = 'B';
    else if (trace.score >= 60) trace.grade = 'C';
    else if (trace.score >= 40) trace.grade = 'D';
    else trace.grade = 'F';
  }
}
