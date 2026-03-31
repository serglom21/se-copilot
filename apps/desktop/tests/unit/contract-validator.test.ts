import { describe, test, expect } from 'vitest'
import {
  validateTopologyContract,
  loadTopologyContract,
  formatContractForPrompt,
  TraceTopologyContract,
} from '../../electron/services/trace-topology-contract'

function makeContract(overrides: Partial<TraceTopologyContract> = {}): TraceTopologyContract {
  return {
    projectId: 'test',
    generatedAt: new Date().toISOString(),
    frozen: true,
    spans: [],
    transactions: [],
    ...overrides,
  }
}

function makeSpan(overrides = {}) {
  return {
    name: 'payment.process',
    op: 'http.server',
    layer: 'backend' as const,
    parentSpan: 'http.server',
    requiredAttributes: [],
    route: '/api/payment/process',
    httpMethod: 'POST' as const,
    description: 'Processes a payment',
    ...overrides,
  }
}

describe('validateTopologyContract', () => {
  test('valid minimal fullstack contract passes', () => {
    const contract = makeContract({
      spans: [
        // frontend span distributes to backend
        makeSpan({ name: 'checkout.submit', layer: 'frontend', parentSpan: 'pageload', distributedTo: 'payment.process', route: undefined, httpMethod: undefined }),
        makeSpan(), // backend span receiving the distributed trace
      ],
      transactions: [
        { name: 'GET /', op: 'pageload', layer: 'frontend', rootSpans: ['checkout.submit'] },
        { name: 'POST /api/payment/process', op: 'http.server', layer: 'backend', rootSpans: ['payment.process'] },
      ],
    })
    const result = validateTopologyContract(contract)
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  test('duplicate span names → duplicate_span_name error', () => {
    const contract = makeContract({ spans: [makeSpan(), makeSpan()] })
    const result = validateTopologyContract(contract)
    expect(result.errors.some(e => e.kind === 'duplicate_span_name')).toBe(true)
  })

  test('duplicate backend routes → duplicate_route error', () => {
    const contract = makeContract({
      spans: [makeSpan({ name: 'a' }), makeSpan({ name: 'b' })], // same route POST /api/payment/process
    })
    const result = validateTopologyContract(contract)
    expect(result.errors.some(e => e.kind === 'duplicate_route')).toBe(true)
  })

  test('self-parent → self_parent error', () => {
    const contract = makeContract({ spans: [makeSpan({ parentSpan: 'payment.process' })] })
    const result = validateTopologyContract(contract)
    expect(result.errors.some(e => e.kind === 'self_parent')).toBe(true)
  })

  test('cycle A→B→A → cycle_detected error', () => {
    const contract = makeContract({
      spans: [
        makeSpan({ name: 'a', parentSpan: 'b', route: '/api/a', httpMethod: 'GET' }),
        makeSpan({ name: 'b', parentSpan: 'a', route: '/api/b', httpMethod: 'GET' }),
      ],
    })
    const result = validateTopologyContract(contract)
    expect(result.errors.some(e => e.kind === 'cycle_detected')).toBe(true)
  })

  test('distributedTo references nonexistent span → unknown_distributed_to_target error', () => {
    const contract = makeContract({
      spans: [makeSpan({ name: 'fe', layer: 'frontend', distributedTo: 'does.not.exist', parentSpan: 'pageload', route: undefined, httpMethod: undefined })],
    })
    const result = validateTopologyContract(contract)
    expect(result.errors.some(e => e.kind === 'unknown_distributed_to_target')).toBe(true)
  })

  test('backend span missing route → backend_missing_route error', () => {
    const contract = makeContract({ spans: [makeSpan({ route: undefined })] })
    const result = validateTopologyContract(contract)
    expect(result.errors.some(e => e.kind === 'backend_missing_route')).toBe(true)
  })

  test('backend span missing httpMethod → backend_missing_method error', () => {
    const contract = makeContract({ spans: [makeSpan({ httpMethod: undefined })] })
    const result = validateTopologyContract(contract)
    expect(result.errors.some(e => e.kind === 'backend_missing_method')).toBe(true)
  })

  test('span with unreachable parent chain → unresolvable_parent error', () => {
    const contract = makeContract({
      spans: [makeSpan({ parentSpan: 'nonexistent.parent' })],
    })
    const result = validateTopologyContract(contract)
    expect(result.errors.some(e => e.kind === 'unresolvable_parent')).toBe(true)
  })

  test('frontend spans with no frontend transaction → no_frontend_transaction error', () => {
    const contract = makeContract({
      spans: [makeSpan({ name: 'fe', layer: 'frontend', parentSpan: 'pageload', route: undefined, httpMethod: undefined })],
      transactions: [
        { name: 'POST /api', op: 'http.server', layer: 'backend', rootSpans: [] },
      ],
    })
    const result = validateTopologyContract(contract)
    expect(result.errors.some(e => e.kind === 'no_frontend_transaction')).toBe(true)
  })

  test('backend spans with no backend transaction → no_backend_transaction error', () => {
    const contract = makeContract({
      spans: [makeSpan()],
      transactions: [
        { name: 'GET /', op: 'pageload', layer: 'frontend', rootSpans: [] },
      ],
    })
    const result = validateTopologyContract(contract)
    expect(result.errors.some(e => e.kind === 'no_backend_transaction')).toBe(true)
  })

  test('loadTopologyContract returns null if file does not exist', () => {
    const result = loadTopologyContract('/nonexistent/path/that/does/not/exist')
    expect(result).toBeNull()
  })

  test('formatContractForPrompt produces no undefined/null fields and has content', () => {
    const contract = makeContract({ spans: [makeSpan()] })
    const formatted = formatContractForPrompt(contract)
    expect(formatted).not.toContain('undefined')
    expect(formatted).not.toContain('null')
    expect(formatted.length).toBeGreaterThan(50)
  })
})
