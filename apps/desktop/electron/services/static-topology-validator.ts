// static-topology-validator.ts
// Deterministic (no LLM) check of generated source files against the frozen
// TraceTopologyContract. Runs before Puppeteer, before the QA repair loop.
//
// Catches the majority of trace structure bugs at code-inspection time:
//   - Missing instrumentation markers
//   - continueTrace not present at distributed trace entry routes
//   - tracePropagationTargets not configured for cross-service calls
//   - Required attributes absent from span wrappers
//   - Transaction root path missing from frontend pages
//   - HTTP method mismatches between FE fetch() and BE route contract

import fs from 'fs';
import path from 'path';
import { TraceTopologyContract, ContractSpan } from './trace-topology-contract';

// ---------------------------------------------------------------------------
// Issue types
// ---------------------------------------------------------------------------

export type TopologyIssueType =
  | 'missing_marker'             // // INSTRUMENT: {spanName} not found in file
  | 'missing_continue_trace'     // continueTrace absent at a distributed trace entry route
  | 'missing_propagation_target' // tracePropagationTargets doesn't include the backend host
  | 'span_outside_start_span'    // fetch() to a distributedTo route is not inside Sentry.startSpan
  | 'missing_attribute'          // a requiredAttribute key is absent near the span marker
  | 'no_transaction_root'        // page file has frontend spans but no path to a root transaction
  | 'method_mismatch'            // fetch() uses wrong HTTP method vs contract
  | 'invented_span'              // // INSTRUMENT: marker for a span not in contract

export interface TopologyIssue {
  type: TopologyIssueType;
  spanName?: string;
  file: string;
  line?: number;
  expected: string;
  found: string;
  severity: 'error' | 'warning';
}

export interface StaticValidationResult {
  passed: boolean;           // true if zero error-severity issues
  issues: TopologyIssue[];
  errors: TopologyIssue[];
  warnings: TopologyIssue[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readFile(filePath: string): string {
  try { return fs.readFileSync(filePath, 'utf8'); } catch { return ''; }
}

function findLineNumber(content: string, searchStr: string): number | undefined {
  const idx = content.indexOf(searchStr);
  if (idx === -1) return undefined;
  return content.slice(0, idx).split('\n').length;
}

// ---------------------------------------------------------------------------
// Main validator
// ---------------------------------------------------------------------------

export function runStaticTopologyValidation(
  contract: TraceTopologyContract,
  appPath: string
): StaticValidationResult {
  const issues: TopologyIssue[] = [];
  const isBackendOnly = !contract.spans.some(s => s.layer === 'frontend');

  const frontendPath = path.join(appPath, 'frontend');
  const backendPath  = path.join(appPath, 'backend');

  // Collect all frontend source files
  const frontendFiles = collectSourceFiles(frontendPath, ['.tsx', '.ts', '.jsx', '.js'])
    .filter(f => !f.includes('node_modules') && !f.includes('.next'));

  // Collect backend source files
  const backendFiles = collectSourceFiles(backendPath, ['.ts', '.js', '.py'])
    .filter(f => !f.includes('node_modules'));

  // Build a quick index: spanName → span
  const spanIndex = new Map(contract.spans.map(s => [s.name, s]));

  // -------------------------------------------------------------------
  // Check 1: Every span must have an // INSTRUMENT: marker in some file
  // -------------------------------------------------------------------
  for (const span of contract.spans) {
    const marker = `// INSTRUMENT: ${span.name}`;
    const searchFiles = span.layer === 'frontend' ? frontendFiles : backendFiles;
    const foundFile = searchFiles.find(f => readFile(f).includes(marker));

    if (!foundFile) {
      issues.push({
        type: 'missing_marker',
        spanName: span.name,
        file: span.layer === 'frontend' ? frontendPath : backendPath,
        expected: marker,
        found: 'not found in any source file',
        severity: 'error',
      });
    }
  }

  // -------------------------------------------------------------------
  // Check 2: Invented markers (// INSTRUMENT: for a span not in contract)
  // -------------------------------------------------------------------
  const allSourceFiles = [...frontendFiles, ...backendFiles];
  for (const filePath of allSourceFiles) {
    const content = readFile(filePath);
    const markerRegex = /\/\/ INSTRUMENT: ([\w.]+)/g;
    let match: RegExpExecArray | null;
    while ((match = markerRegex.exec(content)) !== null) {
      const markerSpanName = match[1];
      if (!spanIndex.has(markerSpanName)) {
        issues.push({
          type: 'invented_span',
          spanName: markerSpanName,
          file: filePath,
          line: findLineNumber(content, match[0]),
          expected: 'span present in contract',
          found: `"${markerSpanName}" not found in contract`,
          severity: 'error',
        });
      }
    }
  }

  // NOTE: Check 3 (span_outside_start_span) removed.
  // The static validator now runs pre-injection on raw markers. The LLM never writes
  // Sentry.startSpan() directly (prompt forbids it), so the check would always fire —
  // a permanent false positive. After injection, trace_*() provides startSpan context.

  // -------------------------------------------------------------------
  // Check 4: Backend distributed-entry routes must have continueTrace
  // -------------------------------------------------------------------
  const distributedTargets = new Set(
    contract.spans.filter(s => s.distributedTo).map(s => s.distributedTo!)
  );

  for (const spanName of distributedTargets) {
    const span = spanIndex.get(spanName);
    if (!span || span.layer !== 'backend') continue;

    const marker = `// INSTRUMENT: ${spanName}`;
    const fileWithMarker = backendFiles.find(f => readFile(f).includes(marker));
    if (!fileWithMarker) continue;

    const content = readFile(fileWithMarker);
    // Check that continueTrace appears in the same route handler block
    // Heuristic: look for continueTrace anywhere within 200 chars before the marker
    const markerIdx = content.indexOf(marker);
    const surroundingCode = content.slice(Math.max(0, markerIdx - 500), markerIdx + 200);
    if (!surroundingCode.includes('continueTrace') && !surroundingCode.includes('Sentry.continueTrace')) {
      issues.push({
        type: 'missing_continue_trace',
        spanName,
        file: fileWithMarker,
        line: findLineNumber(content, marker),
        expected: `Sentry.continueTrace(req.headers['sentry-trace'], req.headers['baggage'], ...) at route handler for ${span.httpMethod} ${span.route}`,
        found: 'continueTrace not found near this route handler',
        severity: 'error',
      });
    }
  }

  // -------------------------------------------------------------------
  // Check 5: tracePropagationTargets must be configured if any distributedTo exists
  // -------------------------------------------------------------------
  if (distributedTargets.size > 0 && !isBackendOnly) {
    const sentryClientConfig = path.join(frontendPath, 'sentry.client.config.ts');
    const clientConfigContent = readFile(sentryClientConfig);
    if (clientConfigContent && !clientConfigContent.includes('tracePropagationTargets')) {
      issues.push({
        type: 'missing_propagation_target',
        file: sentryClientConfig,
        expected: `tracePropagationTargets: ['localhost', '127.0.0.1', /^\\//] in Sentry.init()`,
        found: 'tracePropagationTargets not found in sentry.client.config.ts',
        severity: 'error',
      });
    }
  }

  // -------------------------------------------------------------------
  // Check 6: Required attributes present near span markers
  // -------------------------------------------------------------------
  for (const span of contract.spans) {
    if (span.requiredAttributes.length === 0) continue;
    const marker = `// INSTRUMENT: ${span.name}`;
    const searchFiles = span.layer === 'frontend' ? frontendFiles : backendFiles;
    const fileWithMarker = searchFiles.find(f => readFile(f).includes(marker));
    if (!fileWithMarker) continue;

    const content = readFile(fileWithMarker);
    const markerIdx = content.indexOf(marker);
    // Check 500 chars after the marker for attribute keys
    const codeWindow = content.slice(markerIdx, markerIdx + 500);

    for (const attr of span.requiredAttributes) {
      // The attribute key should appear as a string (quoted) or object key near the span
      if (!codeWindow.includes(`'${attr}'`) && !codeWindow.includes(`"${attr}"`) && !codeWindow.includes(attr.replace(/\./g, '_'))) {
        issues.push({
          type: 'missing_attribute',
          spanName: span.name,
          file: fileWithMarker,
          line: findLineNumber(content, marker),
          expected: `attribute key "${attr}" set on span`,
          found: `"${attr}" not found within 500 chars of the marker`,
          severity: 'warning', // warning — attribute might be set programmatically
        });
      }
    }
  }

  // -------------------------------------------------------------------
  // Check 7: HTTP method match — fetch() calls use contract-defined method
  // -------------------------------------------------------------------
  for (const span of contract.spans.filter(s => s.layer === 'frontend' && s.distributedTo)) {
    const target = contract.spans.find(s => s.name === span.distributedTo);
    if (!target?.route || !target.httpMethod) continue;

    const marker = `// INSTRUMENT: ${span.name}`;
    const fileWithMarker = frontendFiles.find(f => readFile(f).includes(marker));
    if (!fileWithMarker) continue;

    const content = readFile(fileWithMarker);
    const markerIdx = content.indexOf(marker);
    const codeWindow = content.slice(markerIdx, markerIdx + 600);

    // Look for fetch(... with a method: 'XXX' that contradicts the contract
    const methodMatch = codeWindow.match(/method:\s*['"`]([A-Z]+)['"`]/);
    if (methodMatch) {
      const foundMethod = methodMatch[1];
      if (foundMethod !== target.httpMethod) {
        issues.push({
          type: 'method_mismatch',
          spanName: span.name,
          file: fileWithMarker,
          line: findLineNumber(content, marker),
          expected: `fetch() with method: '${target.httpMethod}' (matches contract route ${target.httpMethod} ${target.route})`,
          found: `fetch() with method: '${foundMethod}'`,
          severity: 'error',
        });
      }
    }
    // GET with an explicit method is fine — no body check needed
  }

  // -------------------------------------------------------------------
  // Check 8: Frontend pages with spans must have a path to a transaction root
  // The Sentry browser SDK auto-creates a pageload transaction, so we check
  // that the page file imports @sentry/nextjs or uses Sentry (indicating SDK loaded)
  // -------------------------------------------------------------------
  if (!isBackendOnly) {
    // Find all page files that have at least one INSTRUMENT marker
    const pageFiles = frontendFiles.filter(f => f.includes('/app/') && (f.endsWith('page.tsx') || f.endsWith('page.jsx')));
    for (const pageFile of pageFiles) {
      const content = readFile(pageFile);
      const hasMarker = /\/\/ INSTRUMENT:/.test(content);
      if (!hasMarker) continue;

      const hasSentryImport = content.includes('@sentry/nextjs') || content.includes('@/lib/instrumentation');
      if (!hasSentryImport) {
        issues.push({
          type: 'no_transaction_root',
          file: pageFile,
          expected: 'page imports @sentry/nextjs or @/lib/instrumentation to ensure spans attach to a pageload transaction',
          found: 'no Sentry import found — spans may be orphaned',
          severity: 'warning',
        });
      }
    }
  }

  const errors = issues.filter(i => i.severity === 'error');
  const warnings = issues.filter(i => i.severity === 'warning');

  return { passed: errors.length === 0, issues, errors, warnings };
}

// ---------------------------------------------------------------------------
// File collection helper
// ---------------------------------------------------------------------------

function collectSourceFiles(dir: string, extensions: string[]): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!['node_modules', '.next', 'dist', '__pycache__'].includes(entry.name)) walk(full);
      } else if (extensions.some(ext => entry.name.endsWith(ext))) {
        results.push(full);
      }
    }
  };
  walk(dir);
  return results;
}

// ---------------------------------------------------------------------------
// Format issues for LLM repair prompt
// ---------------------------------------------------------------------------

export function formatTopologyIssuesForRepair(issues: TopologyIssue[]): string {
  return issues.map(i =>
    `[${i.type}]${i.spanName ? ` (${i.spanName})` : ''} in ${path.basename(i.file)}${i.line ? `:${i.line}` : ''}:\n  expected: ${i.expected}\n  found:    ${i.found}`
  ).join('\n\n');
}
