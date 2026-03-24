import fs from 'fs';
import path from 'path';
import { TraceIssue } from './trace-validator';
import { UserFlow } from './live-data-generator';
import { EngagementSpec } from '../../src/types/spec';
import type { LLMService } from './llm';

interface LLMConfig {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}

export interface SurgicalRepairResult {
  patched: string[];   // files that were modified
  skipped: string[];   // issues that couldn't be resolved
}

/**
 * Attempt a targeted code fix for a group of non-fixable issues that share the
 * same repairTarget. Batching all issues for a file into one LLM call avoids
 * the "LLM returned no changes" problem that occurs when the same file is
 * patched multiple times in sequence (each subsequent call sees the already-
 * patched file and finds nothing left to do).
 *
 * Each attempt gets progressively more context (escalation strategy).
 * Returns the list of files that were changed.
 */
export async function surgicalRepair(
  issues: TraceIssue[],
  attempt: number,
  appPath: string,
  spec: EngagementSpec,
  flows: UserFlow[],
  llmConfig: LLMConfig,
  onOutput: (msg: string) => void,
  llmService?: LLMService
): Promise<string[]> {
  if (issues.length === 0) return [];

  // All issues in the batch share the same repairTarget
  const repairTarget = issues[0].repairTarget;
  const isPython = spec.stack.backend === 'flask' || spec.stack.backend === 'fastapi';
  const patched: string[] = [];

  switch (repairTarget) {
    case 'backend_routes': {
      const file = resolveBackendRoutesFile(appPath, isPython);
      if (!file) { onOutput(`   ✗ Backend routes file not found\n`); break; }
      const fixed = await patchFile(file, issues, attempt, spec, llmConfig, onOutput, llmService);
      if (fixed) patched.push(file);
      break;
    }

    case 'frontend_instrumentation': {
      const instrFile = resolveFile(appPath, [
        'frontend/lib/instrumentation.ts',
        'frontend/src/lib/instrumentation.ts',
        'frontend/lib/tracing.ts',
      ]);
      if (!instrFile) { onOutput(`   ✗ Frontend instrumentation file not found\n`); break; }

      // On attempt 3+, also patch each page that calls the missing functions
      if (attempt >= 3) {
        const pageFiles = new Set<string>();
        for (const issue of issues) {
          const pageFile = findPageForSpan(issue.spanName ?? '', appPath);
          if (pageFile) pageFiles.add(pageFile);
        }
        for (const pageFile of pageFiles) {
          const pageFixed = await patchFile(pageFile, issues, attempt, spec, llmConfig, onOutput, llmService);
          if (pageFixed) patched.push(pageFile);
        }
      }

      const fixed = await patchFile(instrFile, issues, attempt, spec, llmConfig, onOutput, llmService);
      if (fixed) patched.push(instrFile);
      break;
    }

    case 'frontend_sentry_config': {
      const configFile = resolveFile(appPath, [
        'frontend/sentry.client.config.ts',
        'frontend/sentry.client.config.js',
        'frontend/src/sentry.client.config.ts',
      ]);
      if (!configFile) { onOutput(`   ✗ Frontend Sentry config file not found\n`); break; }
      const fixed = await patchFile(configFile, issues, attempt, spec, llmConfig, onOutput, llmService);
      if (fixed) patched.push(configFile);
      break;
    }

    case 'flows': {
      // Flows are patched separately via patchFlows — not via LLM file patch
      break;
    }
  }

  return patched;
}

/**
 * Re-generate flows to cover missing spans.
 * Respects dependsOn ordering (topological sort).
 */
export function resolveFlowRunOrder(
  targetFlowNames: string[],
  allFlows: UserFlow[]
): UserFlow[] {
  const flowMap = new Map(allFlows.map(f => [f.name, f]));
  const ordered: UserFlow[] = [];
  const visited = new Set<string>();

  function visit(name: string) {
    if (visited.has(name)) return;
    visited.add(name);
    const flow = flowMap.get(name);
    if (!flow) return;
    for (const dep of flow.dependsOn ?? []) {
      visit(dep);
    }
    ordered.push(flow);
  }

  for (const name of targetFlowNames) {
    visit(name);
  }

  return ordered;
}

/**
 * For each non-fixable issue, determine which flows need to re-run.
 * Falls back to ALL flows if coversSpans mapping is empty.
 */
export function getFlowsToRerun(
  issues: TraceIssue[],
  allFlows: UserFlow[]
): UserFlow[] {
  const nonFixable = issues.filter(i => !i.fixable && i.severity !== 'warning');
  if (nonFixable.length === 0) return [];

  const flowNamesToRun = new Set<string>();
  for (const issue of nonFixable) {
    if (issue.affectedFlows.length > 0) {
      issue.affectedFlows.forEach(f => flowNamesToRun.add(f));
    } else {
      // No coverage map — run all flows as fallback
      allFlows.forEach(f => flowNamesToRun.add(f.name));
    }
  }

  return resolveFlowRunOrder([...flowNamesToRun], allFlows);
}

// ── LLM file patching ─────────────────────────────────────────────────────────

async function patchFile(
  filePath: string,
  issues: TraceIssue[],
  attempt: number,
  spec: EngagementSpec,
  llmConfig: LLMConfig,
  onOutput: (msg: string) => void,
  llmService?: LLMService
): Promise<boolean> {
  let currentCode: string;
  try {
    currentCode = fs.readFileSync(filePath, 'utf8');
  } catch {
    onOutput(`   ✗ Cannot read ${filePath}\n`);
    return false;
  }

  const label = issues.length === 1
    ? `${issues[0].kind}`
    : `${issues.length} issues`;
  onOutput(`   🔧 Patching ${path.basename(filePath)} (${label}, attempt ${attempt})...\n`);

  const prompt = buildRepairPrompt(issues, currentCode, spec, attempt);

  try {
    const fixed = await callLlm(prompt, llmConfig, llmService);
    if (!fixed || fixed.trim() === currentCode.trim()) {
      onOutput(`   ⚠ LLM returned no changes\n`);
      return false;
    }
    fs.writeFileSync(filePath, fixed, 'utf8');
    onOutput(`   ✓ Patched ${path.basename(filePath)}\n`);
    return true;
  } catch (err: any) {
    onOutput(`   ✗ LLM patch failed: ${err?.message ?? err}\n`);
    return false;
  }
}

function buildRepairPrompt(
  issues: TraceIssue[],
  currentCode: string,
  spec: EngagementSpec,
  attempt: number
): string {
  const issueBlock = issues.map((issue, i) => {
    const specSpan = spec.instrumentation.spans.find(s => s.name === issue.spanName);
    const spanContext = specSpan
      ? `  Span spec: name=${specSpan.name}, op=${specSpan.op}, layer=${specSpan.layer}, attrs=${JSON.stringify(specSpan.attributes)}`
      : '';
    return `Issue ${i + 1} (${issue.kind}):\n${issue.detail}${spanContext ? '\n' + spanContext : ''}`;
  }).join('\n\n');

  const attemptNote = attempt === 1
    ? 'Fix only the specific issues described. Do not change anything else.'
    : attempt === 2
    ? 'The previous attempt did not resolve all issues. Make a more comprehensive fix — you may rewrite the relevant sections.'
    : 'Previous attempts failed. Rewrite the entire file if needed to resolve all issues correctly.';

  return `You are fixing Sentry instrumentation issues in a generated reference application.

${issues.length > 1 ? `${issues.length} ISSUES TO FIX:\n` : 'ISSUE TO FIX:\n'}${issueBlock}

INSTRUCTION:
${attemptNote}

Rules:
- Use Sentry semantic op conventions (http.client, http.server, db.query, etc.)
- All custom spans must be nested inside Sentry.startSpan() callbacks
- HTTP spans must include http.status_code, http.method attributes
- DB spans must include db.system, db.name, db.statement or db.operation
- Never use ambient context — always pass parent span explicitly or use Sentry.startSpan callback nesting
- Return ONLY the complete corrected file contents — no markdown fences, no explanation

CURRENT FILE:
${currentCode}`;
}

// ── File resolution helpers ───────────────────────────────────────────────────

function resolveFile(appPath: string, candidates: string[]): string | null {
  for (const rel of candidates) {
    const full = path.join(appPath, rel);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

function resolveBackendRoutesFile(appPath: string, isPython: boolean): string | null {
  const candidates = isPython
    ? ['main.py', 'app.py', 'routes.py']
    : [
        'backend/src/routes/api.ts',
        'backend/src/routes/index.ts',
        'backend/src/index.ts',
        'backend/routes/api.js',
        'backend/index.js',
      ];
  return resolveFile(appPath, candidates);
}

function findPageForSpan(spanName: string, appPath: string): string | null {
  // Try to find a frontend page that likely calls this span
  // Use the span name prefix to guess the page (e.g. "checkout.*" → checkout/page.tsx)
  const prefix = spanName.split('.')[0];
  const candidates = [
    `frontend/app/${prefix}/page.tsx`,
    `frontend/src/app/${prefix}/page.tsx`,
    `frontend/pages/${prefix}.tsx`,
  ];
  return resolveFile(appPath, candidates);
}

// ── LLM caller — prefers LLMService (streaming + serial queue) over raw fetch ─

async function callLlm(
  prompt: string,
  config: LLMConfig,
  llmService?: LLMService
): Promise<string> {
  // Use LLMService when available — it handles streaming for local models,
  // serial queuing for single-threaded servers (MLX/Ollama), and timeouts.
  if (llmService) {
    const raw = await llmService.callLLMDirect(
      [{ role: 'user', content: prompt }],
      { baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.model ?? 'gpt-4-turbo-preview' }
    );
    return raw
      .replace(/^```(?:typescript|ts|javascript|js|python)?\n?/, '')
      .replace(/\n?```[\s\S]*$/, '')
      .trim();
  }

  // Fallback: direct fetch (used only when no LLMService is passed)
  const { baseUrl, apiKey, model = 'gpt-4-turbo-preview' } = config;
  if (!baseUrl || !apiKey) throw new Error('LLM not configured');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 4000,
      }),
    });

    if (!response.ok) {
      const err = await response.text().catch(() => '');
      throw new Error(`LLM API error ${response.status}: ${err.slice(0, 200)}`);
    }

    const data = await response.json() as any;
    const raw = data.choices?.[0]?.message?.content ?? '';

    return raw
      .replace(/^```(?:typescript|ts|javascript|js|python)?\n?/, '')
      .replace(/\n?```[\s\S]*$/, '')
      .trim();
  } finally {
    clearTimeout(timer);
  }
}
