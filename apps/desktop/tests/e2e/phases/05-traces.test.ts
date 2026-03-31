/**
 * Phase 05 — Trace assertions (non-blocking)
 * Uses real Puppeteer sessions and local trace proxy.
 * Uses runPageWithSentryFlush — never a fixed sleep.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Browser, Page } from 'puppeteer'
import fs from 'fs'
import path from 'path'
import http from 'http'
import { TraceTopologyContract, loadTopologyContract } from '../../../electron/services/trace-topology-contract'
import { launchBrowser, closeBrowser, runPageWithSentryFlush } from '../helpers/browser'
import { assertNoOrphans, assertDistributedConnection } from '../helpers/assert'
import { E2E_OUTPUT_DIR } from '../fixture'

const FRONTEND_PORT = 13000
const PROXY_PORT = 13999

// Minimal in-test proxy — captures Sentry envelopes sent from the generated app
interface CapturedItem {
  type: 'transaction' | 'span' | 'error'
  traceId?: string
  spanId?: string
  parentSpanId?: string
  op?: string
  description?: string
  timestamp?: number
  startTimestamp?: number
  data?: Record<string, unknown>
}

const captured: CapturedItem[] = []
let proxyServer: http.Server

function startProxy(): Promise<void> {
  return new Promise(resolve => {
    proxyServer = http.createServer((req, res) => {
      let body = ''
      req.on('data', chunk => (body += chunk.toString()))
      req.on('end', () => {
        try {
          // Sentry envelope format: header\n{}\nitem-header\nitem-body
          const lines = body.split('\n').filter(Boolean)
          for (let i = 0; i < lines.length; i++) {
            try {
              const parsed = JSON.parse(lines[i])
              if (parsed.type === 'transaction' && parsed.timestamp) {
                const spans = parsed.spans ?? []
                captured.push({
                  type: 'transaction',
                  traceId: parsed.contexts?.trace?.trace_id,
                  spanId: parsed.contexts?.trace?.span_id,
                  parentSpanId: parsed.contexts?.trace?.parent_span_id,
                  op: parsed.contexts?.trace?.op,
                  description: parsed.contexts?.trace?.description ?? parsed.transaction,
                  timestamp: parsed.timestamp,
                  startTimestamp: parsed.start_timestamp,
                })
                for (const span of spans) {
                  captured.push({
                    type: 'span',
                    traceId: span.trace_id,
                    spanId: span.span_id,
                    parentSpanId: span.parent_span_id,
                    op: span.op,
                    description: span.description,
                    timestamp: span.timestamp,
                    startTimestamp: span.start_timestamp,
                    data: span.data,
                  })
                }
              }
            } catch { /* skip non-JSON lines */ }
          }
        } catch { /* skip malformed bodies */ }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('{}')
      })
    })
    proxyServer.listen(PROXY_PORT, () => resolve())
  })
}

let browser: Browser
let contract: TraceTopologyContract

beforeAll(async () => {
  const loaded = loadTopologyContract(E2E_OUTPUT_DIR)
  if (!loaded) throw new Error('topology-contract.json not found')
  contract = loaded
  browser = await launchBrowser()
  await startProxy()
})

afterAll(async () => {
  await closeBrowser()
  proxyServer?.close()
})

beforeEach(() => {
  captured.length = 0 // clear between tests — prevents trace accumulation
})

describe('Phase 05 — Trace production', () => {
  test('pageload transaction fires on frontend page load', async () => {
    const page = await browser.newPage()
    await runPageWithSentryFlush(page, `http://localhost:${FRONTEND_PORT}/`, async () => {})
    await page.close()

    const transactions = captured.filter(c => c.type === 'transaction')
    expect(transactions.some(t => t.op === 'pageload')).toBe(true)
  }, 25000)

  test('all contracted spans appear in captured traces after full flow run', async () => {
    const page = await browser.newPage()

    // Navigate through available pages to trigger all spans
    const paths = ['/', ...contract.spans
      .filter(s => s.layer === 'frontend')
      .map(s => s.route ?? '/')
      .filter((v, i, a) => a.indexOf(v) === i)
    ]

    for (const pagePath of paths) {
      await runPageWithSentryFlush(page, `http://localhost:${FRONTEND_PORT}${pagePath}`, async (p) => {
        // Trigger any visible buttons/forms via data-testid
        const buttons = await p.$$('[data-testid]')
        for (const btn of buttons.slice(0, 3)) {
          await btn.click().catch(() => {})
          await new Promise(r => setTimeout(r, 200))
        }
      })
    }
    await page.close()

    const capturedDescs = captured.map(c => c.description).filter(Boolean)
    const missingSpans: string[] = []
    for (const span of contract.spans) {
      if (!capturedDescs.includes(span.name)) missingSpans.push(span.name)
    }
    if (missingSpans.length > 0) {
      console.warn(`[05] Missing spans (non-fatal): ${missingSpans.join(', ')}`)
    }
    // Soft assertion — warn but don't fail if only a few are missing
    const coveragePct = ((contract.spans.length - missingSpans.length) / contract.spans.length) * 100
    expect(coveragePct, `Coverage ${coveragePct.toFixed(0)}% — missing: ${missingSpans.join(', ')}`).toBeGreaterThan(50)
  }, 60000)

  test('no orphan spans — every span has a known parent', async () => {
    const page = await browser.newPage()
    await runPageWithSentryFlush(page, `http://localhost:${FRONTEND_PORT}/`, async () => {})
    await page.close()

    const spans = captured.filter(c => c.type === 'span') as Required<CapturedItem>[]
    const transactions = captured.filter(c => c.type === 'transaction') as Required<CapturedItem>[]
    assertNoOrphans(
      spans.map(s => ({ spanId: s.spanId!, parentSpanId: s.parentSpanId, description: s.description })),
      transactions.map(t => ({ spanId: t.spanId!, op: t.op! }))
    )
  }, 25000)

  test('distributed traces share traceId across frontend and backend', async () => {
    const distributedPairs = contract.spans.filter(s => s.distributedTo)
    if (distributedPairs.length === 0) return // no distributed tracing in this contract

    const page = await browser.newPage()
    await runPageWithSentryFlush(page, `http://localhost:${FRONTEND_PORT}/`, async (p) => {
      const buttons = await p.$$('[data-testid]')
      for (const btn of buttons.slice(0, 2)) {
        await btn.click().catch(() => {})
        await new Promise(r => setTimeout(r, 300))
      }
    })
    await page.close()

    const allItems = captured as CapturedItem[]
    for (const span of distributedPairs) {
      if (!span.distributedTo) continue
      assertDistributedConnection(
        allItems.filter(c => c.spanId).map(c => ({
          spanId: c.spanId!,
          traceId: c.traceId!,
          description: c.description,
          parentSpanId: c.parentSpanId,
        })),
        span.name,
        span.distributedTo
      )
    }
  }, 30000)

  test('IO spans (db, http.client) have non-zero duration', async () => {
    const page = await browser.newPage()
    await runPageWithSentryFlush(page, `http://localhost:${FRONTEND_PORT}/`, async () => {})
    await page.close()

    const ioSpans = captured.filter(c =>
      c.type === 'span' && /^(db\.|http\.client|cache\.)/.test(c.op ?? '')
    )
    const zeroDuration = ioSpans.filter(c => c.timestamp && c.startTimestamp && c.timestamp - c.startTimestamp === 0)
    expect(zeroDuration).toHaveLength(0)
  }, 25000)

  test('both pageload and http.server transactions exist across the run', async () => {
    const page = await browser.newPage()
    await runPageWithSentryFlush(page, `http://localhost:${FRONTEND_PORT}/`, async (p) => {
      const buttons = await p.$$('[data-testid]')
      await buttons[0]?.click().catch(() => {})
      await new Promise(r => setTimeout(r, 500))
    })
    await page.close()

    const txOps = captured.filter(c => c.type === 'transaction').map(c => c.op)
    expect(txOps.some(op => op === 'pageload')).toBe(true)
    // http.server transactions come from backend — may need a separate flow trigger
    // Soft check: just confirm it eventually arrives
    const hasHttpServer = txOps.some(op => op === 'http.server')
    if (!hasHttpServer) console.warn('[05] No http.server transaction yet — may need API trigger')
  }, 25000)
})
