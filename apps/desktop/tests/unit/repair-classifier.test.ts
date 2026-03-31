import { describe, test, expect } from 'vitest'
import { classifyRepair } from '../../electron/services/generation-state'
import { TopologyIssue } from '../../electron/services/static-topology-validator'

function makeIssue(type: TopologyIssue['type'], overrides: Partial<TopologyIssue> = {}): TopologyIssue {
  return {
    type,
    file: '/some/file.ts',
    severity: 'error',
    expected: 'something expected',
    found: 'something found',
    ...overrides,
  }
}

describe('classifyRepair', () => {
  test('invented_span always → contract_violation regardless of count or attempts', () => {
    expect(classifyRepair(makeIssue('invented_span'), 1, 0)).toBe('contract_violation')
    expect(classifyRepair(makeIssue('invented_span'), 10, 5)).toBe('contract_violation')
  })

  test('missing_propagation_target always → deterministic', () => {
    expect(classifyRepair(makeIssue('missing_propagation_target'), 1, 0)).toBe('deterministic')
    expect(classifyRepair(makeIssue('missing_propagation_target'), 10, 5)).toBe('deterministic')
  })

  test('method_mismatch always → deterministic', () => {
    expect(classifyRepair(makeIssue('method_mismatch'), 1, 0)).toBe('deterministic')
    expect(classifyRepair(makeIssue('method_mismatch'), 5, 3)).toBe('deterministic')
  })

  test('missing_marker with 1 issue in file, 0 prior attempts → targeted_patch', () => {
    expect(classifyRepair(makeIssue('missing_marker'), 1, 0)).toBe('targeted_patch')
  })

  test('missing_marker with 2 issues in file, 0 prior attempts → targeted_patch', () => {
    expect(classifyRepair(makeIssue('missing_marker'), 2, 0)).toBe('targeted_patch')
  })

  test('missing_marker with 3 issues in file, 0 prior attempts → targeted_patch (boundary)', () => {
    expect(classifyRepair(makeIssue('missing_marker'), 3, 0)).toBe('targeted_patch')
  })

  test('missing_marker with >3 issues in file → file_rewrite', () => {
    expect(classifyRepair(makeIssue('missing_marker'), 4, 0)).toBe('file_rewrite')
    expect(classifyRepair(makeIssue('missing_marker'), 10, 0)).toBe('file_rewrite')
  })

  test('missing_marker with ≥2 prior attempts → file_rewrite regardless of issue count', () => {
    expect(classifyRepair(makeIssue('missing_marker'), 1, 2)).toBe('file_rewrite')
    expect(classifyRepair(makeIssue('missing_marker'), 1, 5)).toBe('file_rewrite')
  })

  test('missing_continue_trace with 1 issue, 1 prior attempt → targeted_patch', () => {
    expect(classifyRepair(makeIssue('missing_continue_trace'), 1, 1)).toBe('targeted_patch')
  })

  test('span_outside_start_span with 1 issue, 0 attempts → targeted_patch', () => {
    expect(classifyRepair(makeIssue('span_outside_start_span'), 1, 0)).toBe('targeted_patch')
  })
})
