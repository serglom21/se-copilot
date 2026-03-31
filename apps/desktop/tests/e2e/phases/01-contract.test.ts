/**
 * Phase 01 — Contract assertions
 * Validates the topology contract produced by the Architect agent.
 * Blocking: if this fails, subsequent phases do not run.
 */
import { describe, test, expect, beforeAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import { validateTopologyContract, TraceTopologyContract } from '../../../electron/services/trace-topology-contract'
import { E2E_OUTPUT_DIR } from '../fixture'

let contract: TraceTopologyContract

beforeAll(() => {
  const contractPath = path.join(E2E_OUTPUT_DIR, 'topology-contract.json')
  if (!fs.existsSync(contractPath)) {
    throw new Error(`topology-contract.json not found at ${contractPath} — run the generation step first`)
  }
  contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'))
})

describe('Phase 01 — Contract structure', () => {
  test('contract is frozen', () => {
    expect(contract.frozen).toBe(true)
  })

  test('contract passes deterministic validator with zero errors', () => {
    const result = validateTopologyContract(contract)
    if (!result.valid) {
      console.error('Contract errors:', result.errors.map(e => e.detail).join('\n'))
    }
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  test('at least one frontend span exists', () => {
    expect(contract.spans.some(s => s.layer === 'frontend')).toBe(true)
  })

  test('at least one backend span exists', () => {
    expect(contract.spans.some(s => s.layer === 'backend')).toBe(true)
  })

  test('all backend spans have route and httpMethod', () => {
    const invalid = contract.spans.filter(s => s.layer === 'backend' && (!s.route || !s.httpMethod))
    expect(invalid, `Backend spans missing route/method: ${invalid.map(s => s.name).join(', ')}`).toHaveLength(0)
  })

  test('all distributedTo references resolve', () => {
    const spanNames = new Set(contract.spans.map(s => s.name))
    const broken = contract.spans.filter(s => s.distributedTo && !spanNames.has(s.distributedTo))
    expect(broken, `Broken distributedTo: ${broken.map(s => `${s.name}→${s.distributedTo}`).join(', ')}`).toHaveLength(0)
  })

  test('at least one frontend transaction (pageload/navigation)', () => {
    expect(contract.transactions.some(t => t.layer === 'frontend')).toBe(true)
  })

  test('at least one backend transaction (http.server)', () => {
    expect(contract.transactions.some(t => t.layer === 'backend')).toBe(true)
  })

  test('span names are unique', () => {
    const names = contract.spans.map(s => s.name)
    const unique = new Set(names)
    expect(unique.size).toBe(names.length)
  })

  test('backend routes are unique (method+path)', () => {
    const sigs = contract.spans
      .filter(s => s.layer === 'backend' && s.route && s.httpMethod)
      .map(s => `${s.httpMethod} ${s.route}`)
    const unique = new Set(sigs)
    expect(unique.size, `Duplicate routes: ${sigs.filter((s, i) => sigs.indexOf(s) !== i).join(', ')}`).toBe(sigs.length)
  })
})
