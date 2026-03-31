// generation-state.ts
// Explicit state machine for the Pawprint generation pipeline.
// Every terminal state produces a human-readable outcome — nothing goes silent.

import { ContractValidationResult } from './trace-topology-contract';
import { StaticValidationResult } from './static-topology-validator';

// ---------------------------------------------------------------------------
// Fix 3: Post-generation check — validates LLM output before writing to disk
// ---------------------------------------------------------------------------

export interface PostCheckResult {
  clean: boolean;
  issues: string[];
}

/**
 * Validate LLM-generated code before writing to disk:
 * 1. No invented markers — every // INSTRUMENT: name must be in contractSpanNames
 * 2. No duplicate `const <name> =` declarations (first word after `const`)
 *
 * @param code             Generated source code string
 * @param contractSpanNames Full list of span names that are valid for this layer
 * @param filename         File name for error messages
 */
export function postGenerationCheck(
  code: string,
  contractSpanNames: string[],
  filename: string
): PostCheckResult {
  const issues: string[] = [];

  // --- Check 1: No invented markers ---
  const markerRe = /\/\/\s*INSTRUMENT:\s*([^\s—–\-][^—–\n]*)(?:\s*[—–\-].*)?/g;
  let m: RegExpExecArray | null;
  while ((m = markerRe.exec(code)) !== null) {
    const markerName = m[1].trim();
    // Match if any contract span name is a prefix/exact match (normalised)
    const normalised = markerName.replace(/[-\.]/g, '_');
    const found = contractSpanNames.some(n => {
      const cn = n.replace(/[-\.]/g, '_');
      return cn === normalised || normalised.startsWith(cn) || cn.startsWith(normalised);
    });
    if (!found) {
      issues.push(`invented_marker in ${filename}: "// INSTRUMENT: ${markerName}" — span not in contract`);
    }
  }

  // --- Check 2: No duplicate const declarations ---
  const constRe = /\bconst\s+(\w+)\s*=/g;
  const constNames = new Map<string, number>();
  while ((m = constRe.exec(code)) !== null) {
    const name = m[1];
    constNames.set(name, (constNames.get(name) ?? 0) + 1);
  }
  for (const [name, count] of constNames) {
    if (count > 1) {
      issues.push(`duplicate_const in ${filename}: "const ${name}" declared ${count} times`);
    }
  }

  return { clean: issues.length === 0, issues };
}

/**
 * Validate an InstrumentationDeclaration before using it for code generation.
 * Returns { valid, errors } where errors is a list of human-readable problems.
 */
export function validateInstrumentationDeclaration(
  declaration: { unaccountedSpans: string[]; inventedSpans: string[] },
  contractSpanNames: string[]
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (declaration.unaccountedSpans.length > 0) {
    errors.push(
      `Unaccounted spans (missing from declaration): ${declaration.unaccountedSpans.join(', ')}\n` +
      `Every span in the contract must appear in spanCoverage.`
    );
  }

  if (declaration.inventedSpans.length > 0) {
    errors.push(
      `Invented spans (not in contract): ${declaration.inventedSpans.join(', ')}\n` +
      `Remove these from spanCoverage — they are not part of the frozen contract.`
    );
  }

  // Cross-check: any coverage entry whose spanName isn't in the contract
  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

export type GenerationState =
  // Architect phase
  | 'architect:running'
  | 'architect:contract_validation_failed'    // terminal — surface to SE, halt

  // Contract frozen
  | 'contract:frozen'

  // Parallel code generation
  | 'generation:running'
  | 'generation:frontend_failed'              // terminal for frontend path
  | 'generation:backend_failed'               // terminal for backend path

  // Static topology validation
  | 'static_validation:running'
  | 'static_validation:issues_found'          // → QA repair agent
  | 'static_validation:passed'

  // QA repair
  | 'qa:repairing'
  | 'qa:max_attempts_exceeded'                // terminal — surface issues, proceed with warnings

  // Build + integration health check
  | 'build:running'
  | 'build:passed'
  | 'build:failed'                            // terminal — surface build errors

  // Flow generation
  | 'flow_generation:running'
  | 'flow_generation:coverage_incomplete'     // warning, not terminal

  // Execution
  | 'puppeteer:running'
  | 'trace_validation:running'
  | 'trace_repair:running'

  // Completion
  | 'complete:passed'
  | 'complete:passed_with_warnings'
  | 'complete:failed'

// Terminal states that halt the pipeline
const TERMINAL_HALT_STATES = new Set<GenerationState>([
  'architect:contract_validation_failed',
  'generation:frontend_failed',
  'generation:backend_failed',
  'build:failed',
]);

// Terminal states that proceed with warnings
const TERMINAL_WARN_STATES = new Set<GenerationState>([
  'qa:max_attempts_exceeded',
  'flow_generation:coverage_incomplete',
]);

export function isTerminalHalt(state: GenerationState): boolean {
  return TERMINAL_HALT_STATES.has(state);
}

export function isTerminalWarn(state: GenerationState): boolean {
  return TERMINAL_WARN_STATES.has(state);
}

// ---------------------------------------------------------------------------
// Outcome types — every terminal state produces one of these
// ---------------------------------------------------------------------------

export interface GenerationOutcome {
  state: GenerationState;
  success: boolean;
  /** Top-level human-readable message for the SE */
  headline: string;
  /** Structured detail about what went wrong */
  detail?: string;
  /** What the SE can do next */
  nextSteps?: string[];
  /** Non-blocking warnings that don't halt the pipeline */
  warnings?: string[];
}

// ---------------------------------------------------------------------------
// Outcome factory — converts state + context → human-readable outcome
// ---------------------------------------------------------------------------

export function buildOutcome(
  state: GenerationState,
  context: {
    contractErrors?: ContractValidationResult['errors'];
    staticIssues?: StaticValidationResult['errors'];
    buildError?: string;
    qaAttempts?: number;
    warnings?: string[];
  } = {}
): GenerationOutcome {
  const warnings = context.warnings ?? [];

  switch (state) {
    case 'architect:contract_validation_failed':
      return {
        state,
        success: false,
        headline: '🐾 Pawprint could not produce a valid Trace Topology Contract',
        detail: context.contractErrors
          ? context.contractErrors.map(e => `• [${e.kind}] ${e.detail}`).join('\n')
          : 'Contract failed validation after 3 attempts.',
        nextSteps: [
          'Simplify the engagement brief — fewer spans, clearer scope',
          'Check the project notes for conflicting requirements',
          'Try re-generating — the LLM may produce a valid contract on the next attempt',
        ],
        warnings,
      };

    case 'generation:frontend_failed':
      return {
        state,
        success: false,
        headline: '🐾 Frontend code generation failed',
        detail: context.buildError,
        nextSteps: [
          'Check the LLM is reachable and returning valid responses',
          'Try re-generating — transient LLM errors resolve on retry',
        ],
        warnings,
      };

    case 'generation:backend_failed':
      return {
        state,
        success: false,
        headline: '🐾 Backend code generation failed',
        detail: context.buildError,
        nextSteps: [
          'Check the LLM is reachable and returning valid responses',
          'Try re-generating',
        ],
        warnings,
      };

    case 'build:failed':
      return {
        state,
        success: false,
        headline: '🐾 Build failed after QA repair attempts',
        detail: context.buildError,
        nextSteps: [
          'Review the build errors above — they may indicate a code generation pattern issue',
          'Check the generated files for syntax errors',
          'Re-generate the app',
        ],
        warnings,
      };

    case 'qa:max_attempts_exceeded':
      return {
        state,
        success: true,
        headline: '🐾 Generation complete — some topology issues unresolved',
        detail: context.staticIssues
          ? `${context.staticIssues.length} issue(s) remain after ${context.qaAttempts} repair attempt(s):\n` +
            context.staticIssues.map(i => `• [${i.type}]${i.spanName ? ` (${i.spanName})` : ''}: ${i.expected}`).join('\n')
          : undefined,
        nextSteps: [
          'The app will still run — some spans may be missing or orphaned in Sentry',
          'Check the issues above and patch the affected files manually if needed',
          'Re-run the data simulator after fixing',
        ],
        warnings,
      };

    case 'flow_generation:coverage_incomplete':
      return {
        state,
        success: true,
        headline: '🐾 Flow coverage incomplete — some spans may not appear in traces',
        nextSteps: [
          'Add more user flows that exercise the uncovered spans',
          'Re-run the data simulator',
        ],
        warnings,
      };

    case 'complete:passed':
      return {
        state,
        success: true,
        headline: '🐾 All traces validated — data forwarded to Sentry',
        warnings,
      };

    case 'complete:passed_with_warnings':
      return {
        state,
        success: true,
        headline: '🐾 Generation complete with warnings',
        warnings,
      };

    case 'complete:failed':
      return {
        state,
        success: false,
        headline: '🐾 Generation failed',
        warnings,
      };

    default:
      return { state, success: false, headline: `Unexpected terminal state: ${state}`, warnings };
  }
}

// ---------------------------------------------------------------------------
// Repair strategy classifier
// ---------------------------------------------------------------------------

export type RepairStrategy =
  | 'deterministic'        // known pattern, no LLM needed — fixed by rule
  | 'targeted_patch'       // LLM fixes one specific location, diff-locked
  | 'file_rewrite'         // too many issues in file — LLM rewrites whole file
  | 'contract_violation'   // span not in contract — escalate to Architect, not QA

import { TopologyIssue, TopologyIssueType } from './static-topology-validator';

// Issues fixable without LLM
const DETERMINISTIC_ISSUE_TYPES = new Set<TopologyIssueType>([
  'missing_propagation_target',  // known config add to sentry.client.config.ts
  'method_mismatch',             // string replace fetch() method
  // missing_continue_trace: left to LLM (requires inserting a properly-closed async callback)
]);

// Issues that mean the code contradicts the contract — don't patch, re-plan
const CONTRACT_VIOLATION_TYPES = new Set<TopologyIssueType>([
  'invented_span',
]);

export function classifyRepair(
  issue: TopologyIssue,
  issueCountInFile: number,
  priorAttempts: number
): RepairStrategy {
  if (CONTRACT_VIOLATION_TYPES.has(issue.type)) return 'contract_violation';
  if (DETERMINISTIC_ISSUE_TYPES.has(issue.type)) return 'deterministic';
  if (issueCountInFile > 3 || priorAttempts >= 2) return 'file_rewrite';
  return 'targeted_patch';
}

/**
 * Apply a deterministic fix for issues that don't need LLM.
 * Returns true if the fix was applied.
 */
import fs from 'fs';

export function applyDeterministicFix(issue: TopologyIssue): boolean {
  try {
    if (issue.type === 'missing_propagation_target') {
      const content = fs.readFileSync(issue.file, 'utf8');
      if (content.includes('tracePropagationTargets')) return false; // already there
      const fixed = content.replace(
        /debug:.*?,?\n/,
        `debug: process.env.NODE_ENV === 'development',\n  tracePropagationTargets: ['localhost', '127.0.0.1', /^\\//],\n`
      );
      if (fixed !== content) { fs.writeFileSync(issue.file, fixed); return true; }
    }

    if (issue.type === 'method_mismatch') {
      // Extract expected method from issue.expected
      const expectedMatch = issue.expected.match(/method: '([A-Z]+)'/);
      if (!expectedMatch) return false;
      const expectedMethod = expectedMatch[1];
      const content = fs.readFileSync(issue.file, 'utf8');
      // Replace the incorrect method in the fetch() block near the marker
      const foundMatch = issue.found.match(/method: '([A-Z]+)'/);
      if (!foundMatch) return false;
      const wrongMethod = foundMatch[1];
      const fixed = content.replace(
        new RegExp(`method:\\s*['"\`]${wrongMethod}['"\`]`),
        `method: '${expectedMethod}'`
      );
      if (fixed !== content) { fs.writeFileSync(issue.file, fixed); return true; }
    }

  } catch { /* non-fatal */ }
  return false;
}
