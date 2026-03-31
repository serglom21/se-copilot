import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { runStaticTopologyValidation } from '../../electron/services/static-topology-validator'
import { TraceTopologyContract } from '../../electron/services/trace-topology-contract'

let tmpDir: string

function makeContract(overrides: Partial<TraceTopologyContract> = {}): TraceTopologyContract {
  return {
    projectId: 'test', generatedAt: new Date().toISOString(), frozen: true,
    spans: [], transactions: [], ...overrides,
  }
}

function makeSpan(overrides = {}) {
  return {
    name: 'payment.process', op: 'http.server', layer: 'backend' as const,
    parentSpan: 'http.server', requiredAttributes: [],
    route: '/api/payment/process', httpMethod: 'POST' as const,
    description: 'Processes payment', ...overrides,
  }
}

function writeFile(relPath: string, content: string) {
  const full = path.join(tmpDir, relPath)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content)
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pawprint-test-'))
  fs.mkdirSync(path.join(tmpDir, 'frontend', 'app'), { recursive: true })
  fs.mkdirSync(path.join(tmpDir, 'backend', 'src'), { recursive: true })
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('runStaticTopologyValidation', () => {
  test('missing INSTRUMENT marker → missing_marker error', () => {
    const contract = makeContract({ spans: [makeSpan()] })
    writeFile('backend/src/routes.ts', `router.post('/api/payment/process', (req, res) => { res.json({}) })`)
    const result = runStaticTopologyValidation(contract, tmpDir)
    expect(result.errors.some(i => i.type === 'missing_marker' && i.spanName === 'payment.process')).toBe(true)
  })

  test('INSTRUMENT marker present → no missing_marker error', () => {
    const contract = makeContract({ spans: [makeSpan()] })
    writeFile('backend/src/routes.ts', `
      router.post('/api/payment/process', (req, res) => {
        // INSTRUMENT: payment.process — wraps payment handler
        res.json({ ok: true })
      })
    `)
    const result = runStaticTopologyValidation(contract, tmpDir)
    expect(result.errors.some(i => i.type === 'missing_marker')).toBe(false)
  })

  test('marker for span not in contract → invented_span error', () => {
    const contract = makeContract({ spans: [] })
    writeFile('frontend/app/page.tsx', `// INSTRUMENT: invented.span — not in contract`)
    const result = runStaticTopologyValidation(contract, tmpDir)
    expect(result.errors.some(i => i.type === 'invented_span' && i.spanName === 'invented.span')).toBe(true)
  })

  test('distributedTo marker outside Sentry.startSpan → span_outside_start_span error', () => {
    const feSpan = makeSpan({
      name: 'checkout.submit', layer: 'frontend', parentSpan: 'pageload',
      distributedTo: 'payment.process', route: undefined, httpMethod: undefined,
    })
    const beSpan = makeSpan()
    const contract = makeContract({ spans: [feSpan, beSpan] })
    // marker present but NOT inside Sentry.startSpan
    writeFile('frontend/app/page.tsx', `
      // INSTRUMENT: checkout.submit — submits checkout
      await fetch('/api/payment/process', { method: 'POST' })
    `)
    writeFile('backend/src/routes.ts', `
      // INSTRUMENT: payment.process — payment handler
    `)
    const result = runStaticTopologyValidation(contract, tmpDir)
    expect(result.errors.some(i => i.type === 'span_outside_start_span')).toBe(true)
  })

  test('distributedTo marker inside Sentry.startSpan → no span_outside_start_span', () => {
    const feSpan = makeSpan({
      name: 'checkout.submit', layer: 'frontend', parentSpan: 'pageload',
      distributedTo: 'payment.process', route: undefined, httpMethod: undefined,
    })
    const beSpan = makeSpan()
    const contract = makeContract({ spans: [feSpan, beSpan] })
    writeFile('frontend/app/page.tsx', `
      Sentry.startSpan({ name: 'checkout.submit', op: 'ui.action' }, async () => {
        // INSTRUMENT: checkout.submit — submits checkout
        await fetch('/api/payment/process', { method: 'POST' })
      })
    `)
    writeFile('backend/src/routes.ts', `// INSTRUMENT: payment.process`)
    const result = runStaticTopologyValidation(contract, tmpDir)
    expect(result.errors.some(i => i.type === 'span_outside_start_span')).toBe(false)
  })

  test('backend distributed entry missing continueTrace → missing_continue_trace error', () => {
    const feSpan = makeSpan({
      name: 'checkout.submit', layer: 'frontend', parentSpan: 'pageload',
      distributedTo: 'payment.process', route: undefined, httpMethod: undefined,
    })
    const beSpan = makeSpan()
    const contract = makeContract({ spans: [feSpan, beSpan] })
    writeFile('frontend/app/page.tsx', `
      Sentry.startSpan({}, async () => {
        // INSTRUMENT: checkout.submit
        await fetch('/api/payment/process', { method: 'POST' })
      })
    `)
    // backend file has marker but no trace propagation setup
    writeFile('backend/src/routes.ts', `
      router.post('/api/payment/process', (req, res) => {
        // INSTRUMENT: payment.process — handler
        res.json({ ok: true })
      })
    `)
    const result = runStaticTopologyValidation(contract, tmpDir)
    expect(result.errors.some(i => i.type === 'missing_continue_trace' && i.spanName === 'payment.process')).toBe(true)
  })

  test('missing tracePropagationTargets when distributedTo exists → missing_propagation_target error', () => {
    const feSpan = makeSpan({
      name: 'checkout.submit', layer: 'frontend', parentSpan: 'pageload',
      distributedTo: 'payment.process', route: undefined, httpMethod: undefined,
    })
    const beSpan = makeSpan()
    const contract = makeContract({ spans: [feSpan, beSpan] })
    writeFile('frontend/sentry.client.config.ts', `
      Sentry.init({ dsn: 'https://test@sentry.io/1', integrations: [Sentry.browserTracingIntegration()] })
    `)
    writeFile('frontend/app/page.tsx', `
      Sentry.startSpan({}, async () => { // INSTRUMENT: checkout.submit
      })
    `)
    writeFile('backend/src/routes.ts', `// INSTRUMENT: payment.process`)
    const result = runStaticTopologyValidation(contract, tmpDir)
    expect(result.errors.some(i => i.type === 'missing_propagation_target')).toBe(true)
  })

  test('required attribute absent after marker → missing_attribute warning', () => {
    const contract = makeContract({ spans: [makeSpan({ requiredAttributes: ['user.id'] })] })
    writeFile('backend/src/routes.ts', `
      router.post('/api/payment/process', (req, res) => {
        // INSTRUMENT: payment.process — handler
        const result = processPayment()
        res.json(result)
      })
    `)
    const result = runStaticTopologyValidation(contract, tmpDir)
    const attrIssue = result.issues.find(i => i.type === 'missing_attribute' && i.spanName === 'payment.process')
    expect(attrIssue).toBeDefined()
    expect(attrIssue?.severity).toBe('warning')
  })

  test('fetch method mismatch → method_mismatch error', () => {
    const feSpan = makeSpan({
      name: 'checkout.submit', layer: 'frontend', parentSpan: 'pageload',
      distributedTo: 'payment.process', route: undefined, httpMethod: undefined,
    })
    const beSpan = makeSpan() // httpMethod: 'POST'
    const contract = makeContract({ spans: [feSpan, beSpan] })
    writeFile('frontend/app/page.tsx', `
      Sentry.startSpan({ name: 'checkout.submit' }, async () => {
        // INSTRUMENT: checkout.submit
        await fetch('/api/payment/process', { method: 'GET' })
      })
    `)
    writeFile('backend/src/routes.ts', `// INSTRUMENT: payment.process`)
    const result = runStaticTopologyValidation(contract, tmpDir)
    expect(result.errors.some(i => i.type === 'method_mismatch')).toBe(true)
  })

  test('clean generated app → zero error-severity issues', () => {
    const feSpan = makeSpan({
      name: 'checkout.submit', layer: 'frontend', parentSpan: 'pageload',
      distributedTo: 'payment.process', op: 'ui.action',
      requiredAttributes: ['user.id'], route: undefined, httpMethod: undefined,
    })
    const beSpan = makeSpan({ requiredAttributes: ['user.id'] })
    const contract = makeContract({
      spans: [feSpan, beSpan],
      transactions: [
        { name: 'GET /', op: 'pageload', layer: 'frontend', rootSpans: ['checkout.submit'] },
        { name: 'POST /api/payment/process', op: 'http.server', layer: 'backend', rootSpans: ['payment.process'] },
      ],
    })
    writeFile('frontend/sentry.client.config.ts', `
      import * as Sentry from '@sentry/nextjs';
      Sentry.init({ dsn: 'https://test@sentry.io/1', tracePropagationTargets: ['localhost', '127.0.0.1', /^\//], integrations: [Sentry.browserTracingIntegration()], tracesSampleRate: 1.0 })
    `)
    writeFile('frontend/app/page.tsx', `
      'use client'
      import * as Sentry from '@sentry/nextjs'
      export default function Page() {
        const handleSubmit = async () => {
          Sentry.startSpan({ name: 'checkout.submit', op: 'ui.action' }, async () => {
            // INSTRUMENT: checkout.submit — wraps payment fetch
            await fetch('/api/payment/process', { method: 'POST', body: JSON.stringify({ 'user.id': userId }) })
          })
        }
        return <button data-testid="submit-btn" onClick={handleSubmit}>Pay</button>
      }
    `)
    writeFile('backend/src/routes.ts', `
      router.post('/api/payment/process', (req, res) => {
        Sentry.continueTrace({ sentryTrace: req.headers['sentry-trace'], baggage: req.headers['baggage'] }, () => {
          // INSTRUMENT: payment.process — processes payment
          const userId = req.body['user.id']
          res.json({ ok: true })
        })
      })
    `)
    const result = runStaticTopologyValidation(contract, tmpDir)
    expect(result.errors).toHaveLength(0)
  })
})
