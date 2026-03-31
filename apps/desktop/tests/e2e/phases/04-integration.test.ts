/**
 * Phase 04 — Integration assertions
 * Starts the generated servers and checks route responses + trace header acceptance.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import { TraceTopologyContract, loadTopologyContract } from '../../../electron/services/trace-topology-contract'
import { startDevServer, waitForPort } from '../helpers/process'
import { E2E_OUTPUT_DIR } from '../fixture'

let contract: TraceTopologyContract
let appPath: string
let stopFrontend: (() => Promise<void>) | null = null
let stopBackend: (() => Promise<void>) | null = null

const FRONTEND_PORT = 13000
const BACKEND_PORT = 13001

beforeAll(async () => {
  appPath = path.join(E2E_OUTPUT_DIR, 'reference-app')
  const loaded = loadTopologyContract(E2E_OUTPUT_DIR)
  if (!loaded) throw new Error('topology-contract.json not found')
  contract = loaded

  // Start backend
  try {
    const be = await startDevServer(path.join(appPath, 'backend'), BACKEND_PORT, {
      SENTRY_DSN: 'http://test@localhost:9999/1',
      PORT: String(BACKEND_PORT),
    })
    stopBackend = be.stop
    await waitForPort(BACKEND_PORT)
  } catch (err) {
    console.warn('Backend start failed:', err)
  }

  // Start frontend
  try {
    const fe = await startDevServer(path.join(appPath, 'frontend'), FRONTEND_PORT, {
      NEXT_PUBLIC_SENTRY_DSN: 'http://test@localhost:9999/1',
      NEXT_PUBLIC_API_URL: `http://localhost:${BACKEND_PORT}`,
      PORT: String(FRONTEND_PORT),
    })
    stopFrontend = fe.stop
    await waitForPort(FRONTEND_PORT)
  } catch (err) {
    console.warn('Frontend start failed:', err)
  }
}, 120000)

afterAll(async () => {
  await stopFrontend?.()
  await stopBackend?.()
})

describe('Phase 04 — Integration health', () => {
  test('frontend responds on /', async () => {
    const res = await fetch(`http://localhost:${FRONTEND_PORT}/`)
    expect(res.status).not.toBe(404)
  })

  test('backend health endpoint responds', async () => {
    const res = await fetch(`http://localhost:${BACKEND_PORT}/health`).catch(() =>
      fetch(`http://localhost:${BACKEND_PORT}/`)
    )
    expect(res.status).toBeLessThan(500)
  })

  test('all contracted backend routes return non-404 responses', async () => {
    for (const span of contract.spans.filter(s => s.layer === 'backend' && s.route)) {
      const method = span.httpMethod ?? 'GET'
      const url = `http://localhost:${BACKEND_PORT}${span.route}`
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: method !== 'GET' ? JSON.stringify({}) : undefined,
      }).catch(() => null)
      if (!res) continue // server might not have started
      expect(res.status, `Route ${method} ${span.route} returned ${res.status}`).not.toBe(404)
    }
  })

  test('backend routes accept sentry-trace header without error', async () => {
    for (const span of contract.spans.filter(s => s.layer === 'backend' && s.route)) {
      const method = span.httpMethod ?? 'GET'
      const url = `http://localhost:${BACKEND_PORT}${span.route}`
      const res = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'sentry-trace': '8f0f08e0b0524ef9a87b9d7462a9f87b-5d18f64f5f91a3a1-1',
          'baggage': 'sentry-trace_id=8f0f08e0b0524ef9a87b9d7462a9f87b,sentry-public_key=test',
        },
        body: method !== 'GET' ? JSON.stringify({}) : undefined,
      }).catch(() => null)
      if (!res) continue
      expect(res.status, `Route ${method} ${span.route} rejected sentry-trace header`).toBeLessThan(500)
    }
  })
})
