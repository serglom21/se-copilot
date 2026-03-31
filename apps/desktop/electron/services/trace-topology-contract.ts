// trace-topology-contract.ts
// The frozen source of truth produced by the Architect agent before any code
// generation begins. Every downstream agent (frontend, backend, flow, QA) reads
// this contract and executes against it — they do not derive facts independently.
//
// A ContractValidator runs immediately after the Architect produces a contract.
// If validation fails, the Architect is asked to re-reason (max 2 cycles).
// Only a validated contract is frozen and passed downstream.

import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { ConstraintRegistryService } from './constraint-registry';

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

export interface ContractSpan {
  name: string;              // e.g. "signup.validate_user_input"
  op: string;                // e.g. "function" — must be in ConstraintRegistry.knownOps
  layer: 'frontend' | 'backend';
  /** Name of the parent span, or one of: 'pageload' | 'navigation' | 'http.server' | 'root' */
  parentSpan: string;
  /** If set, this frontend span wraps a fetch() that starts a distributed trace on the backend.
   *  Value is the name of the backend span that receives the trace. */
  distributedTo?: string;
  /** HTTP route the backend span is served on — required for layer=backend */
  route?: string;
  /** HTTP method — required for layer=backend */
  httpMethod?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  requiredAttributes: string[];   // attribute keys that MUST appear in instrumentation
  description: string;
}

export interface ContractTransaction {
  name: string;              // e.g. "GET /" or "POST /api/signup/create-account"
  op: 'pageload' | 'navigation' | 'http.server';
  layer: 'frontend' | 'backend';
  /** Span names that are direct children of this transaction root */
  rootSpans: string[];
}

export interface TraceTopologyContract {
  projectId: string;
  generatedAt: string;
  /** Validated and frozen — safe to pass downstream */
  frozen: boolean;
  spans: ContractSpan[];
  transactions: ContractTransaction[];
  /**
   * SHA-256 hash of the brief fields that affect span design (vertical, notes, stack).
   * Used to detect stale contracts: if the brief changes, the contract is regenerated.
   */
  briefHash?: string;
}

/** Hash the brief fields that determine what spans should exist. */
export function hashBrief(brief: { vertical?: string; notes?: string; stackType?: string }): string {
  const canonical = JSON.stringify({
    vertical: brief.vertical ?? '',
    notes: brief.notes ?? '',
    stackType: brief.stackType ?? '',
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 12);
}

// ---------------------------------------------------------------------------
// Validation result types
// ---------------------------------------------------------------------------

export type ContractValidationErrorKind =
  | 'unknown_distributed_to_target'    // distributedTo names a span not in the contract
  | 'unknown_root_span'                // transaction.rootSpans names a span not in the contract
  | 'self_parent'                      // span has itself as parentSpan
  | 'backend_missing_route'            // backend span has no route
  | 'backend_missing_method'           // backend span has no httpMethod
  | 'distributed_target_missing_route' // distributedTo target span has no route
  | 'distributed_method_mismatch'      // distributedTo target's route method doesn't match fetch intent
  | 'duplicate_span_name'              // two spans share the same name
  | 'duplicate_route'                  // two backend spans share method+route
  | 'unresolvable_parent'              // parent chain cannot reach any transaction root
  | 'no_frontend_transaction'          // no pageload or navigation transaction exists
  | 'no_backend_transaction'           // no http.server transaction exists (for non-backend-only)
  | 'cycle_detected'                   // parent-child graph has a cycle
  | 'low_confidence_op';               // op not in ConstraintRegistry.knownOps (warning, not error)

export interface ContractValidationError {
  kind: ContractValidationErrorKind;
  spanName?: string;
  detail: string;
  severity: 'error' | 'warning';
}

export interface ContractValidationResult {
  valid: boolean;       // true only if zero error-severity issues
  errors: ContractValidationError[];
  warnings: ContractValidationError[];
}

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

/**
 * Deterministic (no LLM) validation of a TraceTopologyContract.
 * Returns a structured result. Does NOT throw — callers decide what to do.
 */
export function validateTopologyContract(
  contract: TraceTopologyContract,
  constraintRegistry?: ConstraintRegistryService
): ContractValidationResult {
  const errors: ContractValidationError[] = [];
  const warnings: ContractValidationError[] = [];

  const spanNames = new Set(contract.spans.map(s => s.name));
  const transactionRoots = new Set<string>(['pageload', 'navigation', 'http.server', 'root']);

  // 1. Duplicate span names
  const seen = new Map<string, number>();
  for (const span of contract.spans) {
    seen.set(span.name, (seen.get(span.name) ?? 0) + 1);
  }
  for (const [name, count] of seen) {
    if (count > 1) {
      errors.push({ kind: 'duplicate_span_name', spanName: name,
        detail: `Span name "${name}" appears ${count} times — all span names must be unique.`,
        severity: 'error' });
    }
  }

  // 2. Duplicate backend routes (method + path)
  const routeSig = new Map<string, string>();
  for (const span of contract.spans) {
    if (span.layer === 'backend' && span.route && span.httpMethod) {
      const sig = `${span.httpMethod} ${span.route}`;
      if (routeSig.has(sig)) {
        errors.push({ kind: 'duplicate_route', spanName: span.name,
          detail: `Route "${sig}" is claimed by both "${routeSig.get(sig)}" and "${span.name}".`,
          severity: 'error' });
      } else {
        routeSig.set(sig, span.name);
      }
    }
  }

  // 3. Per-span checks
  for (const span of contract.spans) {
    // self-parent
    if (span.parentSpan === span.name) {
      errors.push({ kind: 'self_parent', spanName: span.name,
        detail: `Span "${span.name}" lists itself as parentSpan.`, severity: 'error' });
    }

    // backend-specific requirements
    if (span.layer === 'backend') {
      if (!span.route) {
        errors.push({ kind: 'backend_missing_route', spanName: span.name,
          detail: `Backend span "${span.name}" is missing a route.`, severity: 'error' });
      }
      if (!span.httpMethod) {
        errors.push({ kind: 'backend_missing_method', spanName: span.name,
          detail: `Backend span "${span.name}" is missing an httpMethod.`, severity: 'error' });
      }
    }

    // distributedTo checks
    if (span.distributedTo) {
      // Auto-correct underscore→dot: LLM sometimes emits "backend_foo" instead of "backend.foo"
      if (!spanNames.has(span.distributedTo)) {
        const dotForm = span.distributedTo.replace(/_/g, '.');
        if (spanNames.has(dotForm)) span.distributedTo = dotForm;
      }
      if (!spanNames.has(span.distributedTo)) {
        errors.push({ kind: 'unknown_distributed_to_target', spanName: span.name,
          detail: `Span "${span.name}" has distributedTo="${span.distributedTo}" but that span does not exist in the contract.`,
          severity: 'error' });
      } else {
        const target = contract.spans.find(s => s.name === span.distributedTo)!;
        if (!target.route) {
          errors.push({ kind: 'distributed_target_missing_route', spanName: span.name,
            detail: `distributedTo target "${span.distributedTo}" has no route — backend span must have a route for distributed tracing to work.`,
            severity: 'error' });
        }
      }
    }

    // op registry check (warning only — op resolution may handle unknowns)
    if (constraintRegistry) {
      const knownOps = constraintRegistry.getKnownOps?.() ?? [];
      if (knownOps.length > 0 && !knownOps.includes(span.op)) {
        warnings.push({ kind: 'low_confidence_op', spanName: span.name,
          detail: `Op "${span.op}" for span "${span.name}" is not in the ConstraintRegistry known ops list. It may still be valid.`,
          severity: 'warning' });
      }
    }
  }

  // 4. Transaction rootSpans check
  for (const txn of contract.transactions) {
    for (const rootSpan of txn.rootSpans) {
      if (!spanNames.has(rootSpan)) {
        errors.push({ kind: 'unknown_root_span',
          detail: `Transaction "${txn.name}" references rootSpan "${rootSpan}" which does not exist in the contract.`,
          severity: 'error' });
      }
    }
  }

  // 5. Parent reachability — every span must eventually reach a transaction root
  //    using BFS on the parent-chain
  const reachableRoots = new Set<string>(['pageload', 'navigation', 'http.server', 'root']);
  // Also add all transaction names as valid roots
  for (const txn of contract.transactions) reachableRoots.add(txn.name);

  // Cycle detection: track visited nodes per DFS path
  function detectCycle(spanName: string, visited: Set<string>, path: Set<string>): boolean {
    if (path.has(spanName)) return true;
    if (visited.has(spanName)) return false;
    visited.add(spanName);
    path.add(spanName);
    const span = contract.spans.find(s => s.name === spanName);
    if (span && !reachableRoots.has(span.parentSpan)) {
      if (detectCycle(span.parentSpan, visited, path)) return true;
    }
    path.delete(spanName);
    return false;
  }

  const globalVisited = new Set<string>();
  for (const span of contract.spans) {
    if (detectCycle(span.name, globalVisited, new Set())) {
      errors.push({ kind: 'cycle_detected', spanName: span.name,
        detail: `Cycle detected in parent chain starting from "${span.name}".`,
        severity: 'error' });
    }
  }

  // Reachability: walk parent chain and check it terminates at a transaction root
  for (const span of contract.spans) {
    let current = span.parentSpan;
    let hops = 0;
    let reachable = false;
    while (hops < 20) {
      if (reachableRoots.has(current)) { reachable = true; break; }
      const parent = contract.spans.find(s => s.name === current);
      if (!parent) break;
      current = parent.parentSpan;
      hops++;
    }
    if (!reachable) {
      errors.push({ kind: 'unresolvable_parent', spanName: span.name,
        detail: `Span "${span.name}" cannot reach a transaction root through its parent chain (chain ends at "${current}").`,
        severity: 'error' });
    }
  }

  // 6. At least one frontend and one backend transaction (for full-stack apps)
  const hasFrontendTxn = contract.transactions.some(t => t.layer === 'frontend');
  const hasBackendTxn  = contract.transactions.some(t => t.layer === 'backend');
  const hasFrontendSpans = contract.spans.some(s => s.layer === 'frontend');
  const hasBackendSpans  = contract.spans.some(s => s.layer === 'backend');

  if (hasFrontendSpans && !hasFrontendTxn) {
    errors.push({ kind: 'no_frontend_transaction',
      detail: 'Contract has frontend spans but no frontend transaction (pageload/navigation). Browser spans will be orphaned.',
      severity: 'error' });
  }
  if (hasBackendSpans && !hasBackendTxn) {
    errors.push({ kind: 'no_backend_transaction',
      detail: 'Contract has backend spans but no backend transaction (http.server). Backend spans will be orphaned.',
      severity: 'error' });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Derive RouteContract from TraceTopologyContract
// (replaces the spec-based deriveRouteContract for the new pipeline)
// ---------------------------------------------------------------------------

import { RouteContract, RouteDefinition } from './route-contract';

export function deriveRouteContractFromTopology(
  contract: TraceTopologyContract,
  outputPath: string
): RouteContract {
  const routes: RouteDefinition[] = contract.spans
    .filter(s => s.layer === 'backend' && s.route && s.httpMethod)
    .map(s => ({
      spanName: s.name,
      method: s.httpMethod!,
      path: s.route!,
      requestBodyKeys: [...s.requiredAttributes, 'pawprint_run_id'],
      layer: 'backend' as const,
    }));

  // Also include frontend spans that have a route via distributedTo mapping
  for (const span of contract.spans.filter(s => s.layer === 'frontend' && s.distributedTo)) {
    const target = contract.spans.find(s => s.name === span.distributedTo);
    if (target?.route && target.httpMethod && !routes.find(r => r.path === target.route && r.method === target.httpMethod)) {
      routes.push({
        spanName: target.name,
        method: target.httpMethod,
        path: target.route,
        requestBodyKeys: [...target.requiredAttributes, 'pawprint_run_id'],
        layer: 'backend' as const,
      });
    }
  }

  const routeContract: RouteContract = {
    routes,
    projectId: contract.projectId,
    generatedAt: new Date().toISOString(),
  };

  try {
    fs.writeFileSync(
      path.join(outputPath, 'route-contract.json'),
      JSON.stringify(routeContract, null, 2)
    );
  } catch { /* non-fatal */ }

  return routeContract;
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

export function saveTopologyContract(contract: TraceTopologyContract, outputPath: string): void {
  fs.writeFileSync(
    path.join(outputPath, 'topology-contract.json'),
    JSON.stringify(contract, null, 2)
  );
}

export function loadTopologyContract(outputPath: string): TraceTopologyContract | null {
  try {
    const raw = fs.readFileSync(path.join(outputPath, 'topology-contract.json'), 'utf8');
    return JSON.parse(raw) as TraceTopologyContract;
  } catch {
    return null;
  }
}

/**
 * Load the cached contract only if it was generated for the current brief.
 * Returns null (forcing regeneration) when the brief has changed since the
 * contract was saved — eliminates stale-contract reuse across different runs.
 */
export function loadFreshTopologyContract(
  outputPath: string,
  currentBriefHash: string
): TraceTopologyContract | null {
  const contract = loadTopologyContract(outputPath);
  if (!contract) return null;

  if (contract.briefHash && contract.briefHash !== currentBriefHash) {
    console.log(
      `[contract] Brief changed since last run — discarding stale contract ` +
      `(saved: ${contract.briefHash}, current: ${currentBriefHash})`
    );
    return null;
  }

  return contract;
}

// ---------------------------------------------------------------------------
// Format helpers for LLM prompts
// ---------------------------------------------------------------------------

export function formatContractForPrompt(contract: TraceTopologyContract): string {
  const lines: string[] = ['=== TRACE TOPOLOGY CONTRACT (frozen — do not deviate) ===', ''];

  lines.push('TRANSACTIONS:');
  for (const txn of contract.transactions) {
    lines.push(`  [${txn.layer}] ${txn.op} "${txn.name}"`);
    lines.push(`    rootSpans: ${txn.rootSpans.join(', ')}`);
  }

  lines.push('', 'SPANS:');
  for (const span of contract.spans) {
    lines.push(`  [${span.layer}] ${span.name} (op: ${span.op})`);
    lines.push(`    parent: ${span.parentSpan}`);
    if (span.distributedTo) lines.push(`    distributedTo: ${span.distributedTo}`);
    if (span.route) lines.push(`    route: ${span.httpMethod} ${span.route}`);
    if (span.requiredAttributes.length > 0)
      lines.push(`    requiredAttributes: ${span.requiredAttributes.join(', ')}`);
  }

  return lines.join('\n');
}

export function formatValidationErrorsForArchitect(result: ContractValidationResult): string {
  const lines = ['CONTRACT VALIDATION FAILED — re-reason and correct the following:'];
  for (const err of result.errors) {
    lines.push(`  [${err.kind}]${err.spanName ? ` (${err.spanName})` : ''}: ${err.detail}`);
  }
  return lines.join('\n');
}
