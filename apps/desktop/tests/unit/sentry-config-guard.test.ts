import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { surgicalRepair } from '../../electron/services/surgical-repairer'
import type { LLMService } from '../../electron/services/llm'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pawprint-guard-'))
  fs.mkdirSync(path.join(tmpDir, 'frontend', 'lib'), { recursive: true })
  fs.mkdirSync(path.join(tmpDir, 'backend', 'src', 'routes'), { recursive: true })
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const minimalSpec: any = {
  project: { name: 'Test', slug: 'test', vertical: 'fintech' },
  stack: { type: 'fullstack', backend: 'express' },
  instrumentation: { spans: [] },
}

describe('sentry config guard — frontend_sentry_config', () => {
  test('writes known-good template, NEVER calls LLM', async () => {
    // Create a corrupted config file with JSX (simulates the bug)
    const configPath = path.join(tmpDir, 'frontend', 'sentry.client.config.ts')
    fs.writeFileSync(configPath, `
      import * as Sentry from '@sentry/nextjs';
      // LLM injected JSX into a .ts file — this breaks SWC
      function MyApp({ Component, pageProps }) {
        return <Component {...pageProps} />
      }
      Sentry.init({ dsn: process.env.NEXT_PUBLIC_SENTRY_DSN })
    `)

    const llmCallCount = { count: 0 }
    const mockLLM = {
      callLLMDirect: async () => { llmCallCount.count++; return '' },
    } as unknown as LLMService

    const issues: any[] = [{
      kind: 'missing_propagation_target',
      detail: 'sentry config broken',
      fixable: true,
      severity: 'error',
      affectedFlows: [],
      repairTarget: 'frontend_sentry_config',
    }]

    await surgicalRepair(issues, 1, tmpDir, minimalSpec, [], {}, () => {}, mockLLM)

    expect(llmCallCount.count).toBe(0)

    const content = fs.readFileSync(configPath, 'utf8')
    expect(content).toContain('Sentry.init(')
    expect(content).toContain('browserTracingIntegration')
    expect(content).toContain('tracePropagationTargets')
    // Regression: no JSX in a .ts config file
    expect(content).not.toMatch(/<[A-Z][a-zA-Z]+/)
    expect(content).not.toContain('function MyApp')
  })
})

describe('sentry config guard — frontend_instrumentation', () => {
  test('re-adds Sentry import if LLM response stripped it', async () => {
    const instrPath = path.join(tmpDir, 'frontend', 'lib', 'instrumentation.ts')
    fs.writeFileSync(instrPath, `
      import * as Sentry from '@sentry/nextjs';
      export const trace_checkout = async (cb: any, attrs: any) => {
        return Sentry.startSpan({ name: 'checkout.submit', op: 'ui.action' }, cb)
      }
    `)

    // Mock LLM that strips the import (simulates the bug)
    const mockLLM = {
      callLLMDirect: async () => `
        // LLM response — accidentally stripped the Sentry import
        export const trace_checkout = async (cb: any, attrs: any) => {
          return cb()
        }
      `,
    } as unknown as LLMService

    const issues: any[] = [{
      kind: 'missing_marker',
      spanName: 'checkout.submit',
      detail: 'marker missing',
      fixable: false,
      severity: 'error',
      affectedFlows: [],
      repairTarget: 'frontend_instrumentation',
    }]

    const settings = { llm: { baseUrl: 'http://localhost:1', apiKey: 'test', model: 'test' } }
    await surgicalRepair(issues, 1, tmpDir, minimalSpec, [], settings.llm, () => {}, mockLLM)

    const content = fs.readFileSync(instrPath, 'utf8')
    expect(content).toContain("import * as Sentry from '@sentry/nextjs'")
  })
})
