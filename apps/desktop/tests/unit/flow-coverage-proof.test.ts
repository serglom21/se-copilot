import { describe, test, expect } from 'vitest'
import { computeFlowCoverageProof, validateFlowSelectors } from '../../electron/services/flow-coverage-proof'
import { UserFlow } from '../../electron/services/live-data-generator'
import { TraceTopologyContract } from '../../electron/services/trace-topology-contract'

function makeContract(spanNames: string[]): TraceTopologyContract {
  return {
    projectId: 'test', generatedAt: new Date().toISOString(), frozen: true,
    spans: spanNames.map(name => ({
      name, op: 'http.server', layer: 'backend' as const,
      parentSpan: 'http.server', requiredAttributes: [],
      route: `/api/${name}`, httpMethod: 'POST' as const,
      description: name,
    })),
    transactions: [],
  }
}

function makeFlow(name: string, coversSpans: string[]): UserFlow {
  return { name, description: `Flow: ${name}`, coversSpans, steps: [] }
}

describe('computeFlowCoverageProof', () => {
  test('full coverage → uncoveredSpans empty, 100%', () => {
    const contract = makeContract(['checkout.submit', 'payment.process', 'fraud.score_check'])
    const flows = [makeFlow('checkout flow', ['checkout.submit', 'payment.process', 'fraud.score_check'])]
    const proof = computeFlowCoverageProof(contract, flows)
    expect(proof.uncoveredSpans).toHaveLength(0)
    expect(proof.coveragePercent).toBe(100)
  })

  test('one span missing → appears in uncoveredSpans', () => {
    const contract = makeContract(['checkout.submit', 'payment.process', 'fraud.score_check'])
    const flows = [makeFlow('checkout flow', ['checkout.submit', 'payment.process'])]
    const proof = computeFlowCoverageProof(contract, flows)
    expect(proof.uncoveredSpans).toContain('fraud.score_check')
    expect(proof.coveredSpans).toHaveLength(2)
  })

  test('coverage percent calculation rounds correctly', () => {
    const contract = makeContract(['a', 'b', 'c'])
    const flows = [makeFlow('f', ['a', 'b'])]
    const proof = computeFlowCoverageProof(contract, flows)
    expect(proof.coveragePercent).toBe(67)
  })

  test('empty contract → 100% coverage, no divide-by-zero', () => {
    const proof = computeFlowCoverageProof(makeContract([]), [])
    expect(proof.coveragePercent).toBe(100)
    expect(proof.uncoveredSpans).toHaveLength(0)
    expect(proof.contractSpans).toHaveLength(0)
  })

  test('no flows → all spans uncovered', () => {
    const contract = makeContract(['a', 'b'])
    const proof = computeFlowCoverageProof(contract, [])
    expect(proof.uncoveredSpans).toHaveLength(2)
    expect(proof.coveragePercent).toBe(0)
  })

  test('flowCoverageMap maps each span to covering flow names', () => {
    const contract = makeContract(['a', 'b'])
    const flows = [
      makeFlow('flow1', ['a']),
      makeFlow('flow2', ['a', 'b']),
    ]
    const proof = computeFlowCoverageProof(contract, flows)
    expect(proof.flowCoverageMap['a']).toEqual(expect.arrayContaining(['flow1', 'flow2']))
    expect(proof.flowCoverageMap['b']).toEqual(['flow2'])
  })

  test('flow with no coversSpans → covers nothing', () => {
    const contract = makeContract(['a'])
    const flows = [{ name: 'flow1', description: '', steps: [] }] // no coversSpans
    const proof = computeFlowCoverageProof(contract, flows)
    expect(proof.uncoveredSpans).toContain('a')
  })
})

describe('validateFlowSelectors', () => {
  test('bare class selector → bare_css_selector issue', () => {
    const flows: UserFlow[] = [{
      name: 'test flow', description: '', coversSpans: [],
      steps: [{ action: 'click', selector: '.checkout-button' }],
    }]
    const result = validateFlowSelectors(flows)
    expect(result.valid).toBe(false)
    expect(result.issues.some(i => i.issue === 'bare_css_selector')).toBe(true)
  })

  test('bare id selector → bare_css_selector issue', () => {
    const flows: UserFlow[] = [{
      name: 'test flow', description: '', coversSpans: [],
      steps: [{ action: 'click', selector: '#submit-btn' }],
    }]
    const result = validateFlowSelectors(flows)
    expect(result.valid).toBe(false)
    expect(result.issues.some(i => i.issue === 'bare_css_selector')).toBe(true)
  })

  test('CSS child combinator → bare_css_selector issue', () => {
    const flows: UserFlow[] = [{
      name: 'test flow', description: '', coversSpans: [],
      steps: [{ action: 'click', selector: 'form > button' }],
    }]
    const result = validateFlowSelectors(flows)
    expect(result.valid).toBe(false)
    expect(result.issues.some(i => i.issue === 'bare_css_selector')).toBe(true)
  })

  test('data-testid selector → no issues', () => {
    const flows: UserFlow[] = [{
      name: 'test flow', description: '', coversSpans: [],
      steps: [{ action: 'click', selector: "[data-testid='submit-btn']" }],
    }]
    const result = validateFlowSelectors(flows)
    expect(result.valid).toBe(true)
    expect(result.issues).toHaveLength(0)
  })

  test('steps without selector → no issues', () => {
    const flows: UserFlow[] = [{
      name: 'test flow', description: '', coversSpans: [],
      steps: [
        { action: 'navigate', url: '/' },
        { action: 'wait', duration: 500 },
      ],
    }]
    const result = validateFlowSelectors(flows)
    expect(result.valid).toBe(true)
  })

  test('issue includes correct flowName and stepIndex', () => {
    const flows: UserFlow[] = [{
      name: 'checkout flow', description: '', coversSpans: [],
      steps: [
        { action: 'navigate', url: '/' },
        { action: 'click', selector: '.bad-selector' }, // index 1
      ],
    }]
    const result = validateFlowSelectors(flows)
    expect(result.issues[0].flowName).toBe('checkout flow')
    expect(result.issues[0].stepIndex).toBe(1)
    expect(result.issues[0].selector).toBe('.bad-selector')
  })
})
