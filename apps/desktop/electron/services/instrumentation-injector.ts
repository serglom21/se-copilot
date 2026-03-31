import fs from 'fs';
import path from 'path';

export interface FunctionSignature {
  name: string;
  callbackParamType?: string;
  attrsParamType?: string;
}

export interface InjectionResult {
  injected: string[];    // span names successfully injected
  unmatched: string[];   // markers that couldn't be resolved
  file: string;
}

export interface AssertionResult {
  passed: boolean;
  violations: { line: number; callSite: string }[];
}

// ---------------------------------------------------------------------------
// extractExports
// ---------------------------------------------------------------------------

/**
 * Read an instrumentation file and return a map of functionName → FunctionSignature
 * for every exported trace_* function (regular or arrow).
 */
export function extractExports(instrumentationFilePath: string): Map<string, FunctionSignature> {
  const content = fs.readFileSync(instrumentationFilePath, 'utf-8');
  const result = new Map<string, FunctionSignature>();

  // Match: export (async )? function trace_<name>
  const functionPattern = /export\s+(?:async\s+)?function\s+(trace_\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = functionPattern.exec(content)) !== null) {
    const name = m[1];
    result.set(name, { name });
  }

  // Match: export const trace_<name>
  const arrowPattern = /export\s+const\s+(trace_\w+)/g;
  while ((m = arrowPattern.exec(content)) !== null) {
    const name = m[1];
    if (!result.has(name)) {
      result.set(name, { name });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// resolveMarker
// ---------------------------------------------------------------------------

/**
 * Given a span name from a // INSTRUMENT: marker, try to find the matching
 * exported trace_ function.
 *
 * Resolution order:
 *   1. Exact: trace_<markerSpanName>
 *   2. Normalised: replace hyphens and dots with underscores, try again
 *   3. Stem: any exported name that contains the normalised span name as a prefix
 */
export function resolveMarker(
  markerSpanName: string,
  exports: Map<string, FunctionSignature>
): string | null {
  // 1. Exact match
  const exact = `trace_${markerSpanName}`;
  if (exports.has(exact)) return exact;

  // 2. Normalised match (hyphens and dots → underscores)
  const normalised = `trace_${markerSpanName.replace(/[-\.]/g, '_')}`;
  if (exports.has(normalised)) return normalised;

  // 3. Stem / prefix match
  for (const exportedName of exports.keys()) {
    if (exportedName.includes(normalised.slice('trace_'.length))) {
      return exportedName;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// injectInstrumentation
// ---------------------------------------------------------------------------

/**
 * Attempt to find the balanced end of a block that starts at `startLine`.
 * Returns the 0-based index of the last line of the block.
 */
function findBlockEnd(lines: string[], startLine: number): number {
  let depth = 0;
  let inBlock = false;

  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i];
    for (const ch of line) {
      if (ch === '{') { depth++; inBlock = true; }
      if (ch === '}') { depth--; }
    }
    if (inBlock && depth === 0) return i;
    // Single-statement (no braces yet) — ends with semicolon
    if (!inBlock && line.trimEnd().endsWith(';')) return i;
  }

  // Fall back: just the start line
  return startLine;
}

/**
 * Return the index of the first non-blank line at or after `from`.
 */
function nextSignificantLine(lines: string[], from: number): number {
  for (let i = from; i < lines.length; i++) {
    if (lines[i].trim().length > 0) return i;
  }
  return from;
}

/**
 * Add `funcName` to the named imports from the instrumentation module.
 * Mutates the `lines` array in-place and returns it.
 */
function addImport(lines: string[], funcName: string): string[] {
  // Patterns we recognise as the instrumentation import
  const importPatterns = [
    /@\/lib\/instrumentation/,
    /\.\.\/lib\/instrumentation/,
    /\.\/instrumentation/,
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim().startsWith('import')) continue;
    const isInstrLine = importPatterns.some(p => p.test(line));
    if (!isInstrLine) continue;

    // Already imported?
    if (line.includes(funcName)) return lines;

    // Add to named imports: import { foo, bar } from ...
    const namedMatch = /import\s*\{([^}]+)\}/.exec(line);
    if (namedMatch) {
      const names = namedMatch[1].split(',').map(s => s.trim()).filter(Boolean);
      names.push(funcName);
      lines[i] = line.replace(/import\s*\{[^}]+\}/, `import { ${names.join(', ')} }`);
    } else {
      // import * as X from ... or similar — append a new import
      lines.splice(i + 1, 0, `import { ${funcName} } from '@/lib/instrumentation';`);
    }
    return lines;
  }

  // No existing instrumentation import — add at the top (after any leading comments/shebang)
  let insertAt = 0;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.startsWith('import') || t.startsWith('//') || t.startsWith('*') || t === '') {
      if (t.startsWith('import')) { insertAt = i; break; }
    }
  }
  lines.splice(insertAt, 0, `import { ${funcName} } from '@/lib/instrumentation';`);
  return lines;
}

/**
 * Detect the base indentation of a line (leading whitespace).
 */
function getIndent(line: string): string {
  const m = /^(\s*)/.exec(line);
  return m ? m[1] : '';
}

/**
 * Read `filePath`, find every `// INSTRUMENT: <span_name>` marker, inject the
 * appropriate trace_ call, update imports, write the result back to disk, and
 * return an InjectionResult.
 */
export function injectInstrumentation(
  filePath: string,
  instrumentationFilePath: string
): InjectionResult {
  let content = fs.readFileSync(filePath, 'utf-8');
  const exports = extractExports(instrumentationFilePath);

  const injected: string[] = [];
  const unmatched: string[] = [];

  // We process the file line by line, rebuilding it as we go.
  // Because injecting changes line numbers we do a single-pass replacement
  // on the raw string using a regex that captures each marker and its context.

  // Split into lines for manipulation
  let lines = content.split('\n');

  // Marker regex — captures span name and optional description
  const markerRe = /^(\s*)\/\/\s*INSTRUMENT:\s*([^\s—–-][^—–\n]*)(?:\s*[—–-].*)?$/;

  let i = 0;
  while (i < lines.length) {
    const match = markerRe.exec(lines[i]);
    if (!match) { i++; continue; }

    const markerIndent = match[1];
    const spanName = match[2].trim();
    const resolvedName = resolveMarker(spanName, exports);

    if (!resolvedName) {
      unmatched.push(spanName);
      i++;
      continue;
    }

    // Find the next significant line after the marker
    const codeStart = nextSignificantLine(lines, i + 1);
    if (codeStart >= lines.length) {
      // Nothing to wrap
      unmatched.push(spanName);
      i++;
      continue;
    }

    const codeLine = lines[codeStart];
    const codeIndent = getIndent(codeLine);
    const trimmedCode = codeLine.trim();

    let blockEnd: number;

    // Determine whether we're wrapping a single statement or a multi-line block
    const startsBlock =
      trimmedCode.startsWith('try') ||
      trimmedCode.startsWith('if') ||
      trimmedCode.startsWith('switch') ||
      trimmedCode.startsWith('{');

    if (startsBlock) {
      blockEnd = findBlockEnd(lines, codeStart);
    } else {
      // Single statement — ends at the first line that has a semicolon
      // or, if it's a one-liner expression, just use that line
      blockEnd = codeStart;
      for (let j = codeStart; j < lines.length; j++) {
        blockEnd = j;
        if (lines[j].trimEnd().endsWith(';') || lines[j].trimEnd().endsWith('}')) break;
      }
    }

    // Extract the original code block lines and build the wrapped version
    const originalLines = lines.slice(codeStart, blockEnd + 1);
    // Indent the original code block by one extra level inside the callback
    const innerIndent = codeIndent + '  ';
    const indentedBlock = originalLines
      .map(l => (l.trim() === '' ? '' : innerIndent + l.trimStart()))
      .join('\n');

    const wrappedLines = [
      `${codeIndent}void ${resolvedName}(async () => {`,
      indentedBlock,
      `${codeIndent}}, {});`,
    ];

    // Replace lines[codeStart..blockEnd] with wrapped version
    lines.splice(codeStart, blockEnd - codeStart + 1, ...wrappedLines);

    // Add import for the resolved function
    lines = addImport(lines, resolvedName);

    injected.push(spanName);

    // Advance past the newly inserted block (+1 for the marker line itself)
    i = codeStart + wrappedLines.length;
  }

  const result = lines.join('\n');
  fs.writeFileSync(filePath, result, 'utf-8');

  return { injected, unmatched, file: filePath };
}

// ---------------------------------------------------------------------------
// Deterministic marker management
// (runs AFTER code generation, BEFORE injectInstrumentation)
// ---------------------------------------------------------------------------

/**
 * Remove every `// INSTRUMENT: X` comment line where X is not in
 * contractSpanNames. Prevents LLM-hallucinated span names from reaching
 * the injector, which would create trace_* wrappers for spans that don't
 * exist in instrumentation.ts.
 *
 * Returns the list of removed span names.
 */
export function removeForeignMarkers(filePath: string, contractSpanNames: string[]): string[] {
  if (!fs.existsSync(filePath)) return [];
  const code = fs.readFileSync(filePath, 'utf-8');
  const removed: string[] = [];

  const filtered = code.split('\n').filter(line => {
    const m = /\/\/\s*INSTRUMENT:\s*([^\s—–\-][^\n—–]*)/.exec(line);
    if (!m) return true;
    const raw = m[1].trim();
    // Strip trailing description after — or -
    const spanName = raw.replace(/\s*[—–\-\s].*$/, '').trim();
    const norm = (s: string) => s.replace(/[.\-]/g, '_').toLowerCase();
    const valid = contractSpanNames.some(n => norm(n) === norm(spanName));
    if (!valid) { removed.push(spanName); return false; }
    return true;
  });

  if (removed.length > 0) fs.writeFileSync(filePath, filtered.join('\n'), 'utf-8');
  return removed;
}

/**
 * For each span in `contractSpans` that has a known API route, check whether
 * the file already has a `// INSTRUMENT: span.name` marker. If not, find the
 * `try {` block that contains a `fetch(...)` call to that route's path and
 * insert the marker on the line immediately before `try {`.
 *
 * This fills gaps left by the LLM without inventing new spans or misplacing
 * markers (scope is always correct because the marker precedes `try {`).
 *
 * Returns the list of span names that were injected.
 */
export function fillMissingMarkersFromRoutes(
  filePath: string,
  contractSpans: Array<{ name: string }>,
  routeContract: { routes: Array<{ spanName: string; path: string; method: string }> }
): string[] {
  if (!fs.existsSync(filePath)) return [];
  const code = fs.readFileSync(filePath, 'utf-8');
  const lines = code.split('\n');

  // Collect which spans already have markers
  const markerRe = /\/\/\s*INSTRUMENT:\s*([^\s—–\-][^\n—–]*)/;
  const presentSpans = new Set<string>();
  const norm = (s: string) => s.replace(/[.\-]/g, '_').toLowerCase();
  for (const line of lines) {
    const m = markerRe.exec(line);
    if (m) presentSpans.add(norm(m[1].replace(/\s*[—–\-\s].*$/, '').trim()));
  }

  const added: string[] = [];

  for (const span of contractSpans) {
    if (presentSpans.has(norm(span.name))) continue;

    const route = routeContract.routes.find(r => r.spanName === span.name);
    if (!route) continue; // no route → can't place deterministically

    const tryIdx = findTryBlockForFetch(lines, route.path);
    if (tryIdx < 0) continue;

    const indent = /^(\s*)/.exec(lines[tryIdx])?.[1] ?? '';
    lines.splice(tryIdx, 0, `${indent}// INSTRUMENT: ${span.name} — ${route.method} ${route.path}`);
    presentSpans.add(norm(span.name));
    added.push(span.name);
  }

  if (added.length > 0) fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
  return added;
}

/** Find the line index of the `try {` that encloses a `fetch(routePath, ...)` call. */
function findTryBlockForFetch(lines: string[], routePath: string): number {
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes('fetch(') || !lines[i].includes(routePath)) continue;
    // Walk backward up to 15 lines to find the enclosing try {
    for (let j = i; j >= Math.max(0, i - 15); j--) {
      if (/^\s*try\s*\{/.test(lines[j])) {
        // Already marked — don't double-mark
        if (j > 0 && /\/\/\s*INSTRUMENT:/.test(lines[j - 1])) return -1;
        return j;
      }
      // Hit a hard boundary (function or arrow fn body open) — stop looking
      if (j < i && /^\s*(async\s+)?(?:function\s|\w+\s*=\s*async|\w+\s*\(.*\)\s*=>)/.test(lines[j])) break;
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Fix 5: assertNoInventedTraceFunctions
// ---------------------------------------------------------------------------

/**
 * Scan `filePath` for every `trace_<name>(...)` call site and verify that
 * the function exists as an export in the instrumentation file.
 *
 * This catches the LLM hallucination pattern where backend routes contain
 * direct calls like `trace_invoice_create_validate_input()` for functions
 * that were never generated in the instrumentation module.
 *
 * Returns a list of invented function names found in the file.
 */
export function assertNoInventedTraceFunctions(
  filePath: string,
  instrumentationFilePath: string
): string[] {
  if (!fs.existsSync(filePath) || !fs.existsSync(instrumentationFilePath)) return [];

  const content = fs.readFileSync(filePath, 'utf-8');
  const knownExports = extractExports(instrumentationFilePath);

  const invented: string[] = [];
  const callRe = /\btrace_\w+(?=\s*\()/g;
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(content)) !== null) {
    const fn = m[0];
    if (!knownExports.has(fn) && !invented.includes(fn)) {
      invented.push(fn);
    }
  }
  return invented;
}

// ---------------------------------------------------------------------------
// normaliseTraceFunctionNames
// ---------------------------------------------------------------------------

/**
 * Scan `filePath` for every `trace_<name>(...)` call and require statement.
 * For each name that doesn't exist in the instrumentation exports, find the
 * closest match by Jaccard token similarity on underscore-separated tokens.
 * Replace all occurrences (calls + destructuring) in the file.
 *
 * This fixes the LLM pattern of using frontend span naming conventions in
 * backend route files (e.g. `trace_signup_submit_form` when the instrumentation
 * exports `trace_backend_submit_form`).
 *
 * Returns the list of renames applied.
 */
export function normaliseTraceFunctionNames(
  filePath: string,
  instrumentationFilePath: string
): Array<{ wrong: string; correct: string }> {
  if (!fs.existsSync(filePath) || !fs.existsSync(instrumentationFilePath)) return [];

  const knownExports = extractExports(instrumentationFilePath);
  if (knownExports.size === 0) return [];

  let source = fs.readFileSync(filePath, 'utf-8');
  const callRe = /\btrace_\w+(?=\s*[,()\s])/g;

  const toRename = new Map<string, string>(); // wrong → correct
  const seen = new Set<string>();
  let m: RegExpExecArray | null;

  while ((m = callRe.exec(source)) !== null) {
    const fn = m[0];
    if (knownExports.has(fn) || seen.has(fn)) continue;
    seen.add(fn);

    const best = findClosestExport(fn, knownExports);
    if (best && best !== fn) {
      toRename.set(fn, best);
    }
  }

  if (toRename.size === 0) return [];

  const renames: Array<{ wrong: string; correct: string }> = [];
  for (const [wrong, correct] of toRename) {
    // Replace all occurrences (calls, destructuring, require)
    source = source.replaceAll(wrong, correct);
    renames.push({ wrong, correct });
    console.log(`[trace-normaliser] ${path.basename(filePath)}: '${wrong}' → '${correct}'`);
  }

  fs.writeFileSync(filePath, source, 'utf-8');
  return renames;
}

function findClosestExport(name: string, exports: Map<string, FunctionSignature>): string | null {
  const tokensA = new Set(name.toLowerCase().split('_').filter(Boolean));
  let bestScore = 0;
  let bestName: string | null = null;

  for (const exportName of exports.keys()) {
    const tokensB = new Set(exportName.toLowerCase().split('_').filter(Boolean));
    const intersection = [...tokensA].filter(t => tokensB.has(t)).length;
    const union = new Set([...tokensA, ...tokensB]).size;
    const score = union > 0 ? intersection / union : 0;
    if (score > bestScore) {
      bestScore = score;
      bestName = exportName;
    }
  }

  return bestScore >= 0.4 ? bestName : null;
}

// ---------------------------------------------------------------------------
// assertInjectionCorrectness
// ---------------------------------------------------------------------------

/**
 * Scan a file for every call to a trace_* function and verify that the first
 * argument is an async callback (starts with `async`).
 */
export function assertInjectionCorrectness(filePath: string): AssertionResult {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');

  const violations: { line: number; callSite: string }[] = [];

  // Find every trace_<name>( occurrence
  const callRe = /\btrace_\w+\s*\(/g;
  let m: RegExpExecArray | null;

  while ((m = callRe.exec(content)) !== null) {
    const callStart = m.index;
    // Get the character position right after the opening paren
    const afterParen = callStart + m[0].length;

    // Extract a small window of text after the paren to inspect the first arg
    const window = content.slice(afterParen, afterParen + 200);

    // Strip leading whitespace/newlines
    const trimmedWindow = window.trimStart();

    // The first argument must start with `async`
    if (!trimmedWindow.startsWith('async')) {
      // Determine line number
      const upToMatch = content.slice(0, callStart);
      const lineNumber = upToMatch.split('\n').length;
      const lineContent = lines[lineNumber - 1] ?? '';
      violations.push({ line: lineNumber, callSite: lineContent.trim() });
    }
  }

  return { passed: violations.length === 0, violations };
}
