// flow-coverage-proof.ts
// Deterministic (no LLM) proof that the generated UserFlow set collectively
// covers every span in the TraceTopologyContract before Puppeteer runs.
//
// Separate from pre-execution selector validation (which asks "will each step run?").
// This asks "does the FULL set of flows reach every span in the contract?"
//
// If uncoveredSpans is non-empty, the Flow Orchestrator is asked to re-reason once.
// After that, uncovered spans surface as warnings — partial data > no data.

import { TraceTopologyContract } from './trace-topology-contract';
import { UserFlow } from './live-data-generator';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FlowCoverageProof {
  contractSpans: string[];
  coveredSpans: string[];
  uncoveredSpans: string[];
  coveragePercent: number;
  flowCoverageMap: Record<string, string[]>; // spanName → flow names that cover it
}

// ---------------------------------------------------------------------------
// Selector validation result (pre-execution)
// ---------------------------------------------------------------------------

export interface SelectorValidationIssue {
  flowName: string;
  stepIndex: number;
  selector: string;
  issue: 'no_data_testid_in_selector' | 'bare_css_selector';
}

export interface SelectorValidationResult {
  valid: boolean;
  issues: SelectorValidationIssue[];
}

// ---------------------------------------------------------------------------
// Coverage proof
// ---------------------------------------------------------------------------

/**
 * Checks that the flow set covers all spans in the contract.
 * Coverage is determined by UserFlow.coversSpans[] — flows must declare
 * which contract spans they exercise.
 */
export function computeFlowCoverageProof(
  contract: TraceTopologyContract,
  flows: UserFlow[]
): FlowCoverageProof {
  const contractSpans = contract.spans.map(s => s.name);

  // Build coverage map: which flows cover which spans
  const flowCoverageMap: Record<string, string[]> = {};
  for (const span of contractSpans) {
    flowCoverageMap[span] = flows
      .filter(f => f.coversSpans?.includes(span))
      .map(f => f.name);
  }

  const coveredSpans = contractSpans.filter(s => flowCoverageMap[s].length > 0);
  const uncoveredSpans = contractSpans.filter(s => flowCoverageMap[s].length === 0);

  return {
    contractSpans,
    coveredSpans,
    uncoveredSpans,
    coveragePercent: contractSpans.length === 0
      ? 100
      : Math.round((coveredSpans.length / contractSpans.length) * 100),
    flowCoverageMap,
  };
}

/**
 * Formats the coverage proof for the Flow Orchestrator's re-reason prompt.
 * Called when uncoveredSpans is non-empty.
 */
export function formatCoverageGapForReReason(
  proof: FlowCoverageProof,
  contract: TraceTopologyContract
): string {
  const lines = [
    `FLOW COVERAGE INCOMPLETE — ${proof.uncoveredSpans.length} span(s) have no flow:`,
    '',
  ];
  for (const spanName of proof.uncoveredSpans) {
    const span = contract.spans.find(s => s.name === spanName);
    lines.push(`  - ${spanName} (${span?.layer}, parent: ${span?.parentSpan})`);
    if (span?.route) lines.push(`    route: ${span.httpMethod} ${span.route}`);
    if (span?.distributedTo) lines.push(`    distributedTo: ${span.distributedTo}`);
  }
  lines.push('');
  lines.push('Add or extend flows so that each uncovered span appears in at least one flow\'s coversSpans[].');
  lines.push('Existing flows that could be extended:');
  for (const flow of contract.spans
    .filter(s => proof.uncoveredSpans.includes(s.name))
    .flatMap(s => {
      // find flows that cover sibling spans (same layer/parent)
      return Object.entries(proof.flowCoverageMap)
        .filter(([sibling]) => {
          const siblingSp = contract.spans.find(sp => sp.name === sibling);
          return siblingSp?.parentSpan === s.parentSpan && proof.flowCoverageMap[sibling]?.length > 0;
        })
        .flatMap(([, flowNames]) => flowNames);
    })) {
    lines.push(`  - ${flow}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Pre-execution selector validation
// ---------------------------------------------------------------------------

/**
 * Validates that Puppeteer flow steps use data-testid selectors (not raw CSS).
 * Raw CSS selectors break when the page layout changes.
 */
export function validateFlowSelectors(flows: UserFlow[]): SelectorValidationResult {
  const issues: SelectorValidationIssue[] = [];

  for (const flow of flows) {
    for (let i = 0; i < flow.steps.length; i++) {
      const step = flow.steps[i];
      if (!step.selector) continue;

      // Warn if selector looks like raw CSS (no data-testid)
      const isDataTestId = step.selector.includes('[data-testid=') || step.selector.startsWith('[data-testid');
      const isBareClass = step.selector.startsWith('.') && !step.selector.includes('[data-testid');
      const isBareId = step.selector.startsWith('#');
      const isCssChain = step.selector.includes('>') || step.selector.includes(' ');

      if (!isDataTestId && (isBareClass || isBareId || isCssChain)) {
        issues.push({
          flowName: flow.name,
          stepIndex: i,
          selector: step.selector,
          issue: 'bare_css_selector',
        });
      }
    }
  }

  return { valid: issues.length === 0, issues };
}

// ---------------------------------------------------------------------------
// Format for output
// ---------------------------------------------------------------------------

export function formatCoverageProofSummary(proof: FlowCoverageProof): string {
  const lines = [
    `🐾 Flow coverage: ${proof.coveragePercent}% (${proof.coveredSpans.length}/${proof.contractSpans.length} spans)`,
  ];
  if (proof.uncoveredSpans.length > 0) {
    lines.push(`   ⚠ Uncovered: ${proof.uncoveredSpans.join(', ')}`);
  }
  return lines.join('\n');
}
