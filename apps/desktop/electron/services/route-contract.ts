// route-contract.ts — Derives the canonical API route contract from the frozen
// instrumentation plan. Runs ONCE before any code generation so that both the
// frontend and backend LLM calls receive the same paths and methods — neither
// call derives them independently.

import fs from 'fs';
import path from 'path';
import { EngagementSpec, SpanDefinition } from '../../src/types/spec';

export interface RouteDefinition {
  spanName: string;        // exact span name, e.g. "signup.fetch_user"
  method: string;          // HTTP method, e.g. "GET"
  path: string;            // canonical path including /api prefix, e.g. "/api/signup/fetch-user"
  requestBodyKeys: string[]; // attribute keys the route must read from req.body / req.query
  layer: 'frontend' | 'backend';
}

export interface RouteContract {
  routes: RouteDefinition[];
  projectId: string;
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Path derivation — must match the existing frontend/backend convention exactly:
//   signup.fetch_user → /api/signup/fetch-user
//   payment.process_transaction → /api/payment/process-transaction
//   fraud.score_check → /api/fraud/score-check
// ---------------------------------------------------------------------------
export function spanToApiPath(spanName: string): string {
  const parts = spanName.split('.');
  if (parts.length === 1) {
    return `/api/${parts[0].replace(/_/g, '-').toLowerCase()}`;
  }
  const namespace = parts[0].toLowerCase();
  const action = parts.slice(1).join('/').replace(/_/g, '-').toLowerCase();
  return `/api/${namespace}/${action}`;
}

// ---------------------------------------------------------------------------
// Method derivation — checks spanIntent first, then falls back to span name
// ---------------------------------------------------------------------------
const GET_WORDS = ['fetch', 'load', 'get', 'list', 'retrieve', 'read', 'query', 'search', 'filter', 'view', 'show', 'detail'];
const PUT_WORDS = ['update', 'edit', 'modify', 'change', 'patch'];
const DELETE_WORDS = ['delete', 'remove', 'cancel', 'revoke', 'purge'];

export function deriveHttpMethod(span: SpanDefinition): string {
  const text = ((span as any).spanIntent || span.description || span.name).toLowerCase();
  if (GET_WORDS.some(w => text.includes(w))) return 'GET';
  if (DELETE_WORDS.some(w => text.includes(w))) return 'DELETE';
  if (PUT_WORDS.some(w => text.includes(w))) return 'PUT';
  return 'POST';
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------
export function deriveRouteContract(project: EngagementSpec, outputPath: string): RouteContract {
  const routes: RouteDefinition[] = project.instrumentation.spans.map(span => ({
    spanName: span.name,
    method: deriveHttpMethod(span),
    path: spanToApiPath(span.name),
    requestBodyKeys: [...Object.keys(span.attributes), 'se_copilot_run_id'],
    layer: span.layer as 'frontend' | 'backend',
  }));

  const contract: RouteContract = {
    routes,
    projectId: project.id,
    generatedAt: new Date().toISOString(),
  };

  try {
    fs.writeFileSync(
      path.join(outputPath, 'route-contract.json'),
      JSON.stringify(contract, null, 2),
    );
    console.log(`✅ Route contract written: ${routes.length} routes → route-contract.json`);
  } catch (err) {
    console.warn('⚠ Could not write route-contract.json:', err);
  }

  return contract;
}

// ---------------------------------------------------------------------------
// Format the contract as a readable table string for inclusion in LLM prompts
// ---------------------------------------------------------------------------
export function formatContractForPrompt(contract: RouteContract): string {
  const header = `spanName | method | path | requestBodyKeys`;
  const sep = `---------|--------|------|----------------`;
  const rows = contract.routes.map(r =>
    `${r.spanName} | ${r.method} | ${r.path} | ${r.requestBodyKeys.join(', ')}`
  );
  return [header, sep, ...rows].join('\n');
}

// ---------------------------------------------------------------------------
// Load a previously written contract from disk
// ---------------------------------------------------------------------------
export function loadRouteContract(outputPath: string): RouteContract | null {
  try {
    const raw = fs.readFileSync(path.join(outputPath, 'route-contract.json'), 'utf8');
    return JSON.parse(raw) as RouteContract;
  } catch {
    return null;
  }
}
