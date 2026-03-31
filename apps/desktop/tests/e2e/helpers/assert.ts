import { expect } from 'vitest'

export function assertNoOrphans(
  spans: Array<{ spanId: string; parentSpanId?: string; description?: string }>,
  transactions: Array<{ spanId: string; op: string }>
): void {
  const allIds = new Set([
    ...spans.map(s => s.spanId),
    ...transactions.map(t => t.spanId),
  ])
  const orphans = spans.filter(s => s.parentSpanId && !allIds.has(s.parentSpanId))
  if (orphans.length > 0) {
    console.error('Orphan spans:', orphans.map(s => `${s.description} (parent: ${s.parentSpanId})`))
  }
  expect(orphans, 'All spans should have a known parent').toHaveLength(0)
}

export function assertDistributedConnection(
  spans: Array<{ spanId: string; traceId: string; description?: string; parentSpanId?: string }>,
  feSpanName: string,
  beSpanName: string
): void {
  const feSpans = spans.filter(s => s.description === feSpanName)
  const beSpans = spans.filter(s => s.description === beSpanName)
  expect(feSpans.length, `Frontend span "${feSpanName}" should appear in traces`).toBeGreaterThan(0)
  expect(beSpans.length, `Backend span "${beSpanName}" should appear in traces`).toBeGreaterThan(0)

  const feTraceIds = new Set(feSpans.map(s => s.traceId))
  const beTraceIds = new Set(beSpans.map(s => s.traceId))
  const shared = [...feTraceIds].filter(id => beTraceIds.has(id))
  expect(shared.length, `Spans "${feSpanName}" and "${beSpanName}" should share a traceId`).toBeGreaterThan(0)
}
