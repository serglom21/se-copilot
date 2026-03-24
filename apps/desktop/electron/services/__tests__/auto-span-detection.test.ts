/**
 * Tests that origin is captured correctly from Sentry envelopes and that
 * the isAutoSpan() classification works for both root and child spans.
 *
 * Run with: pnpm --filter @se-copilot/desktop test
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TraceIngestService } from '../trace-ingest';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const isAutoSpan = (s: { origin?: string }) => (s.origin || '').includes('auto');

/** Build a minimal Sentry envelope string with one transaction item. */
function makeEnvelope(tx: object): string {
  const header = JSON.stringify({ event_id: 'aaa', sent_at: new Date().toISOString() });
  const itemHeader = JSON.stringify({ type: 'transaction' });
  const itemBody = JSON.stringify(tx);
  return [header, itemHeader, itemBody].join('\n');
}

/** Wait until the ingest service holds at least one trace (or timeout). */
async function waitForTrace(ingest: TraceIngestService, ms = 2000): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (ingest.getTraces().length > 0) { resolve(); return; }
    const t = setTimeout(() => reject(new Error('Timeout waiting for trace')), ms);
    ingest.once('trace-updated', () => { clearTimeout(t); resolve(); });
  });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TRACE_ID = 'abcdef1234567890abcdef1234567890';

/** A pageload transaction — root span is auto-instrumented by Sentry browser SDK. */
const pageloadTransaction = {
  event_id: 'ev001',
  transaction: '/products',
  start_timestamp: 1700000000,
  timestamp: 1700000005,
  contexts: {
    trace: {
      trace_id: TRACE_ID,
      span_id: 'root0001',
      parent_span_id: null,
      op: 'pageload',
      status: 'ok',
      origin: 'auto.pageload.browser',  // SDK-set origin on the root span
    },
  },
  spans: [
    {
      // Child: auto-instrumented resource span (SDK)
      span_id: 'child001',
      parent_span_id: 'root0001',
      op: 'resource.script',
      description: 'https://cdn.example.com/main.js',
      start_timestamp: 1700000000.1,
      timestamp: 1700000000.9,
      origin: 'auto.resource.browser',
    },
    {
      // Child: custom http.client span (developer-written)
      span_id: 'child002',
      parent_span_id: 'root0001',
      op: 'http.client',
      description: 'GET /api/products',
      start_timestamp: 1700000001,
      timestamp: 1700000002,
      origin: 'manual',
    },
    {
      // Child: custom product span (developer-written, no origin)
      span_id: 'child003',
      parent_span_id: 'root0001',
      op: 'product.view',
      description: 'view-product-detail',
      start_timestamp: 1700000002,
      timestamp: 1700000003,
      // origin intentionally absent — should be treated as custom
    },
  ],
};

/** A backend http.server transaction — auto-named by Express integration. */
const backendTransaction = {
  event_id: 'ev002',
  transaction: 'GET /api/products',
  start_timestamp: 1700000001.1,
  timestamp: 1700000001.8,
  contexts: {
    trace: {
      trace_id: TRACE_ID,
      span_id: 'be0001',
      parent_span_id: 'child002',  // linked to FE http.client span
      op: 'http.server',
      status: 'ok',
      origin: 'auto.http.node',   // SDK-set origin
    },
  },
  spans: [
    {
      // Auto DB span created by Sentry DB integration
      span_id: 'be_child001',
      parent_span_id: 'be0001',
      op: 'db.query',
      description: 'SELECT * FROM products',
      start_timestamp: 1700000001.2,
      timestamp: 1700000001.6,
      origin: 'auto.db.postgres',
    },
    {
      // Custom span added by the developer to track cache hit/miss
      span_id: 'be_child002',
      parent_span_id: 'be0001',
      op: 'cache.get',
      description: 'products-cache',
      start_timestamp: 1700000001.15,
      timestamp: 1700000001.18,
      origin: 'manual',
    },
  ],
};

// ---------------------------------------------------------------------------
// Suite 1: Frontend pageload transaction (root + children)
// ---------------------------------------------------------------------------

describe('TraceIngestService — frontend pageload origin capture', () => {
  let ingest: TraceIngestService;
  let allSpans: ReturnType<TraceIngestService['getTraces']>[0]['allSpans'];

  beforeAll(async () => {
    ingest = new TraceIngestService(19991);
    await ingest.start();
    await fetch('http://127.0.0.1:19991/envelope/', {
      method: 'POST',
      body: makeEnvelope(pageloadTransaction),
    });
    await waitForTrace(ingest);
    allSpans = ingest.getTraces()[0].allSpans;
  });

  afterAll(() => ingest.stop());

  it('captures auto origin on root (pageload) span', () => {
    const span = allSpans.find(s => s.span_id === 'root0001');
    expect(span).toBeDefined();
    expect(span!.origin).toBe('auto.pageload.browser');
    expect(isAutoSpan(span!)).toBe(true);
  });

  it('captures auto origin on SDK-generated resource child span', () => {
    const span = allSpans.find(s => s.span_id === 'child001');
    expect(span).toBeDefined();
    expect(span!.origin).toBe('auto.resource.browser');
    expect(isAutoSpan(span!)).toBe(true);
  });

  it('captures manual origin on custom http.client child span', () => {
    const span = allSpans.find(s => s.span_id === 'child002');
    expect(span).toBeDefined();
    expect(span!.origin).toBe('manual');
    expect(isAutoSpan(span!)).toBe(false);
  });

  it('treats missing origin as custom (not auto)', () => {
    const span = allSpans.find(s => s.span_id === 'child003');
    expect(span).toBeDefined();
    expect(span!.origin).toBeUndefined();
    expect(isAutoSpan(span!)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Suite 2: Backend http.server transaction (root + children)
// ---------------------------------------------------------------------------

describe('TraceIngestService — backend transaction origin capture', () => {
  let ingest: TraceIngestService;
  let allSpans: ReturnType<TraceIngestService['getTraces']>[0]['allSpans'];

  beforeAll(async () => {
    ingest = new TraceIngestService(19992);
    await ingest.start();
    await fetch('http://127.0.0.1:19992/envelope/', {
      method: 'POST',
      body: makeEnvelope(backendTransaction),
    });
    await waitForTrace(ingest);
    allSpans = ingest.getTraces()[0].allSpans;
  });

  afterAll(() => ingest.stop());

  it('captures auto origin on http.server root span', () => {
    const span = allSpans.find(s => s.span_id === 'be0001');
    expect(span).toBeDefined();
    expect(span!.origin).toBe('auto.http.node');
    expect(isAutoSpan(span!)).toBe(true);
  });

  it('captures auto origin on SDK-generated DB child span', () => {
    const span = allSpans.find(s => s.span_id === 'be_child001');
    expect(span).toBeDefined();
    expect(span!.origin).toBe('auto.db.postgres');
    expect(isAutoSpan(span!)).toBe(true);
  });

  it('captures manual origin on custom cache child span', () => {
    const span = allSpans.find(s => s.span_id === 'be_child002');
    expect(span).toBeDefined();
    expect(span!.origin).toBe('manual');
    expect(isAutoSpan(span!)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Suite 3: isAutoSpan() unit classification (no server needed)
// ---------------------------------------------------------------------------

describe('isAutoSpan — classification logic', () => {
  const cases: Array<{ origin: string | undefined; expected: boolean; label: string }> = [
    { origin: 'auto.pageload.browser',  expected: true,  label: 'pageload (browser)' },
    { origin: 'auto.http.browser',      expected: true,  label: 'http.client (browser SDK)' },
    { origin: 'auto.http.node',         expected: true,  label: 'http.server (node SDK)' },
    { origin: 'auto.db.postgres',       expected: true,  label: 'db auto (postgres)' },
    { origin: 'auto.resource.browser',  expected: true,  label: 'resource (browser)' },
    { origin: 'auto',                   expected: true,  label: 'bare "auto"' },
    { origin: 'manual',                 expected: false, label: 'manual (developer span)' },
    { origin: '',                       expected: false, label: 'empty string' },
    { origin: undefined,                expected: false, label: 'undefined (no origin)' },
    { origin: 'custom.checkout',        expected: false, label: 'custom non-auto' },
  ];

  for (const { origin, expected, label } of cases) {
    it(`"${label}" → ${expected ? 'auto' : 'custom'}`, () => {
      expect(isAutoSpan({ origin })).toBe(expected);
    });
  }
});
