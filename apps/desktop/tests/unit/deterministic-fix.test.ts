import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { applyDeterministicFix } from '../../electron/services/generation-state'
import { TopologyIssue } from '../../electron/services/static-topology-validator'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pawprint-fix-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function writeAndFix(filename: string, content: string, issue: TopologyIssue): { changed: boolean; content: string } {
  const filePath = path.join(tmpDir, filename)
  fs.writeFileSync(filePath, content)
  const issueWithFile = { ...issue, file: filePath }
  const result = applyDeterministicFix(issueWithFile)
  return { changed: result, content: fs.readFileSync(filePath, 'utf8') }
}

describe('applyDeterministicFix — missing_propagation_target', () => {
  test('adds tracePropagationTargets when absent', () => {
    const content = `Sentry.init({\n  dsn: 'https://test@sentry.io/1',\n  debug: process.env.NODE_ENV === 'development',\n  integrations: [],\n})`
    const result = writeAndFix('sentry.client.config.ts', content, {
      type: 'missing_propagation_target', file: '', severity: 'error',
      expected: "tracePropagationTargets: ['localhost', '127.0.0.1', /^\\//] in Sentry.init()",
      found: 'tracePropagationTargets not found',
    })
    expect(result.changed).toBe(true)
    expect(result.content).toContain('tracePropagationTargets')
    expect(result.content).toContain('localhost')
  })

  test('idempotent — returns false and does not duplicate if already present', () => {
    const content = `Sentry.init({\n  dsn: 'https://test@sentry.io/1',\n  debug: true,\n  tracePropagationTargets: ['localhost'],\n})`
    const result = writeAndFix('sentry.client.config.ts', content, {
      type: 'missing_propagation_target', file: '', severity: 'error',
      expected: "tracePropagationTargets: ['localhost']",
      found: 'tracePropagationTargets not found',
    })
    expect(result.changed).toBe(false)
    const count = (result.content.match(/tracePropagationTargets/g) ?? []).length
    expect(count).toBe(1)
  })
})

describe('applyDeterministicFix — method_mismatch', () => {
  test('fixes GET→POST method mismatch', () => {
    const content = `await fetch('/api/payment', { method: 'GET', body: JSON.stringify(data) })`
    const result = writeAndFix('page.tsx', content, {
      type: 'method_mismatch', file: '', severity: 'error',
      expected: "fetch() with method: 'POST' (matches contract route POST /api/payment)",
      found: "fetch() with method: 'GET'",
    })
    expect(result.changed).toBe(true)
    expect(result.content).toContain("method: 'POST'")
    expect(result.content).not.toContain("method: 'GET'")
  })

  test('fixes POST→GET method mismatch', () => {
    const content = `await fetch('/api/data', { method: 'POST' })`
    const result = writeAndFix('page.tsx', content, {
      type: 'method_mismatch', file: '', severity: 'error',
      expected: "fetch() with method: 'GET' (matches contract route GET /api/data)",
      found: "fetch() with method: 'POST'",
    })
    expect(result.changed).toBe(true)
    expect(result.content).toContain("method: 'GET'")
    expect(result.content).not.toContain("method: 'POST'")
  })

  test('returns false when method already matches (no-op)', () => {
    const content = `await fetch('/api/payment', { method: 'POST' })`
    // 'found' says POST but 'expected' also says POST — nothing to change
    const result = writeAndFix('page.tsx', content, {
      type: 'method_mismatch', file: '', severity: 'error',
      expected: "fetch() with method: 'POST'",
      found: "fetch() with method: 'POST'",
    })
    // When found === expected, the regex replace finds the same string — content doesn't change
    expect(result.changed).toBe(false)
  })
})
