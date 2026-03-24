import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { EngagementSpec } from '../../src/types/spec';

export interface AppValidationResult {
  success: boolean;
  /** Non-fatal issues that were logged but didn't block generation */
  warnings: string[];
  /** Fatal issues that prevented a clean build (may have been auto-repaired) */
  errors: string[];
  buildRepaired: boolean;
}

interface BuildError {
  file: string;       // absolute path
  line: number;
  col: number;
  message: string;
  raw: string;
}

type OnOutput = (line: string) => void;
type OnProgress = (pct: number, label: string) => void;

interface LLMConfig {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function validateGeneratedApp(
  appPath: string,
  project: EngagementSpec,
  llmConfig: LLMConfig,
  onProgress: OnProgress,
  onOutput: OnOutput
): Promise<AppValidationResult> {
  const warnings: string[] = [];
  const errors: string[] = [];
  let buildRepaired = false;

  const isPython = project.stack.backend === 'flask' || project.stack.backend === 'fastapi';
  const isBackendOnly = project.stack.type === 'backend-only';
  const frontendPath = path.join(appPath, 'frontend');
  const backendPath = isPython ? appPath : path.join(appPath, 'backend');

  // ── Layer 1: Static structure check (~2s, no server) ─────────────────────
  onProgress(86, 'Checking app structure…');
  onOutput('🔍 Layer 1: Static structure check\n');

  const structureIssues = checkStructure(appPath, frontendPath, project, isBackendOnly);
  for (const issue of structureIssues) {
    if (issue.fatal) {
      errors.push(issue.message);
      onOutput(`   ✗ ${issue.message}\n`);
    } else {
      warnings.push(issue.message);
      onOutput(`   ⚠ ${issue.message}\n`);
    }
  }
  if (structureIssues.filter(i => i.fatal).length === 0) {
    onOutput('   ✓ Structure looks good\n');
  }

  // ── Layer 2: Install dependencies ────────────────────────────────────────
  onProgress(87, 'Installing dependencies…');
  onOutput('\n📦 Layer 2a: Installing dependencies\n');

  if (!isBackendOnly && fs.existsSync(frontendPath)) {
    onOutput('   Installing frontend dependencies…\n');
    const { exitCode: feInstall } = await runCommand('npm', ['install', '--prefer-offline'], frontendPath, onOutput);
    if (feInstall !== 0) {
      // ENOTEMPTY or other corruption — wipe node_modules and retry without --prefer-offline
      onOutput('   ⚠ Frontend npm install failed — cleaning node_modules and retrying…\n');
      const nmPath = path.join(frontendPath, 'node_modules');
      if (fs.existsSync(nmPath)) {
        try { fs.rmSync(nmPath, { recursive: true, force: true }); } catch {}
      }
      const { exitCode: feRetry } = await runCommand('npm', ['install'], frontendPath, onOutput);
      if (feRetry !== 0) {
        onOutput('   ⚠ Frontend npm install failed after retry — build check may fail\n');
      } else {
        onOutput('   ✓ Frontend dependencies installed\n');
      }
    } else {
      onOutput('   ✓ Frontend dependencies installed\n');
    }
  }

  if (!isPython && fs.existsSync(backendPath)) {
    onOutput('   Installing backend dependencies…\n');
    const { exitCode: beInstall } = await runCommand('npm', ['install', '--prefer-offline'], backendPath, onOutput);
    if (beInstall !== 0) {
      onOutput('   ⚠ Backend npm install failed — cleaning node_modules and retrying…\n');
      const nmPath = path.join(backendPath, 'node_modules');
      if (fs.existsSync(nmPath)) {
        try { fs.rmSync(nmPath, { recursive: true, force: true }); } catch {}
      }
      const { exitCode: beRetry } = await runCommand('npm', ['install'], backendPath, onOutput);
      if (beRetry !== 0) {
        onOutput('   ⚠ Backend npm install failed after retry — build check may fail\n');
      } else {
        onOutput('   ✓ Backend dependencies installed\n');
      }
    } else {
      onOutput('   ✓ Backend dependencies installed\n');
    }
  }

  // ── Layer 2: Build check + LLM repair loop ────────────────────────────────
  onProgress(88, 'Building frontend…');
  onOutput('\n🔨 Layer 2b: Build check\n');

  const MAX_BUILD_ATTEMPTS = 3;

  if (!isBackendOnly) {
    // Frontend: next build
    let feBuildPassed = false;
    for (let attempt = 1; attempt <= MAX_BUILD_ATTEMPTS; attempt++) {
      onOutput(`\n   Frontend build (attempt ${attempt}/${MAX_BUILD_ATTEMPTS})…\n`);
      // Force NODE_ENV=production so Next.js and React initialize their SSR context
      // correctly. Electron's process may have a non-standard NODE_ENV which causes
      // useContext to return null during static page generation.
      const { exitCode, output } = await runCommand('npm', ['run', 'build'], frontendPath, onOutput, { NODE_ENV: 'production' });

      if (exitCode === 0) {
        onOutput('   ✓ Frontend build passed\n');
        feBuildPassed = true;
        break;
      }

      const buildErrors = parseBuildErrors(output, frontendPath);
      if (buildErrors.length === 0 || attempt === MAX_BUILD_ATTEMPTS) {
        errors.push(`Frontend build failed after ${attempt} attempt(s)`);
        break;
      }

      onOutput(`   Found ${buildErrors.length} error(s) in ${new Set(buildErrors.map(e => e.file)).size} file(s) — attempting LLM repair…\n`);
      const repaired = await repairBuildErrors(buildErrors, llmConfig, onOutput);
      if (repaired > 0) {
        buildRepaired = true;
        onOutput(`   🔧 Repaired ${repaired} file(s)\n`);
      }
    }
    if (!feBuildPassed) {
      onOutput('   ✗ Frontend build could not be fixed automatically\n');
    }
  }

  // Backend: tsc --noEmit (TypeScript only; Python gets a syntax check)
  onProgress(93, 'Building backend…');
  if (!isPython) {
    let beBuildPassed = false;
    for (let attempt = 1; attempt <= MAX_BUILD_ATTEMPTS; attempt++) {
      onOutput(`\n   Backend type-check (attempt ${attempt}/${MAX_BUILD_ATTEMPTS})…\n`);
      const { exitCode, output } = await runCommand(
        'npx', ['tsc', '--noEmit'], backendPath, onOutput
      );

      if (exitCode === 0) {
        onOutput('   ✓ Backend type-check passed\n');
        beBuildPassed = true;
        break;
      }

      const buildErrors = parseBuildErrors(output, backendPath);
      if (buildErrors.length === 0 || attempt === MAX_BUILD_ATTEMPTS) {
        errors.push(`Backend type-check failed after ${attempt} attempt(s)`);
        break;
      }

      onOutput(`   Found ${buildErrors.length} error(s) — attempting LLM repair…\n`);
      const repaired = await repairBuildErrors(buildErrors, llmConfig, onOutput);
      if (repaired > 0) {
        buildRepaired = true;
        onOutput(`   🔧 Repaired ${repaired} file(s)\n`);
      }
    }
    if (!beBuildPassed) {
      onOutput('   ✗ Backend build could not be fixed automatically\n');
    }
  } else {
    // Python syntax check — fast, no dependencies needed
    onOutput('\n   Python syntax check…\n');
    const pyEntry = ['main.py', 'app.py'].find(f => fs.existsSync(path.join(backendPath, f)));
    if (pyEntry) {
      const { exitCode, output } = await runCommand(
        'python3', ['-m', 'py_compile', pyEntry], backendPath, onOutput
      );
      if (exitCode === 0) {
        onOutput('   ✓ Python syntax OK\n');
      } else {
        errors.push(`Python syntax error in ${pyEntry}`);
        onOutput(`   ✗ ${output.trim()}\n`);
      }
    }
  }

  // ── Layer 3: Smoke test — quick backend start ─────────────────────────────
  onProgress(96, 'Running smoke test…');
  onOutput('\n🚀 Layer 3: Smoke test\n');

  const smokeResult = await smokeTestBackend(backendPath, isPython, onOutput);
  if (!smokeResult.started) {
    warnings.push('Backend failed to start during smoke test — check server initialization');
    onOutput(`   ⚠ Backend did not start cleanly: ${smokeResult.error}\n`);
  } else {
    onOutput('   ✓ Backend started successfully\n');
  }

  onProgress(98, 'Validation complete');
  onOutput(`\n${errors.length === 0 ? '✅' : '⚠'} Validation complete — ${errors.length} error(s), ${warnings.length} warning(s)\n`);

  return {
    success: errors.length === 0,
    warnings,
    errors,
    buildRepaired,
  };
}

// ── Layer 1: Static structure ─────────────────────────────────────────────────

interface StructureIssue { fatal: boolean; message: string }

function checkStructure(
  appPath: string,
  frontendPath: string,
  project: EngagementSpec,
  isBackendOnly: boolean
): StructureIssue[] {
  const issues: StructureIssue[] = [];

  if (!isBackendOnly) {
    if (!fs.existsSync(frontendPath)) {
      issues.push({ fatal: true, message: 'frontend/ directory is missing' });
      return issues; // nothing more to check
    }

    // Each spec transaction should have a page file
    for (const tx of project.instrumentation.transactions) {
      const route = tx.replace(/^GET\s+/, '').replace(/^POST\s+/, '');
      // Normalise: /api/users → skip (backend only), /checkout → check
      if (route.startsWith('/api/')) continue;
      const segments = route.replace(/^\//, '').split('/').filter(Boolean);
      if (segments.length === 0) continue; // root — page.tsx at app/page.tsx
      const pagePath = path.join(frontendPath, 'app', ...segments, 'page.tsx');
      if (!fs.existsSync(pagePath)) {
        issues.push({ fatal: false, message: `Page missing for transaction "${tx}" (expected ${pagePath.replace(appPath, '')})` });
      }
    }

    // Instrumentation file should export a trace_ function per spec span
    const instrPath = path.join(frontendPath, 'lib', 'instrumentation.ts');
    if (!fs.existsSync(instrPath)) {
      issues.push({ fatal: true, message: 'frontend/lib/instrumentation.ts is missing' });
    } else {
      const instrCode = fs.readFileSync(instrPath, 'utf8');
      const exportedFns = new Set(
        Array.from(instrCode.matchAll(/export\s+(?:async\s+)?function\s+(trace_\w+)/g), m => m[1])
      );
      for (const span of project.instrumentation.spans.filter(s => s.layer === 'frontend')) {
        const expectedFn = `trace_${span.name.replace(/\./g, '_')}`;
        if (!exportedFns.has(expectedFn)) {
          issues.push({ fatal: false, message: `instrumentation.ts missing function ${expectedFn} for span "${span.name}"` });
        }
      }
    }

    // Check page files for placeholder content
    const appDir = path.join(frontendPath, 'app');
    if (fs.existsSync(appDir)) {
      const placeholders = findPlaceholders(appDir);
      for (const p of placeholders) {
        issues.push({ fatal: false, message: `Placeholder content in ${p.file}: "${p.match}"` });
      }
    }
  }

  return issues;
}

const PLACEHOLDER_PATTERNS = [
  /\bTODO\b/,
  /\blorem ipsum\b/i,
  /\[placeholder\]/i,
  /Coming Soon/i,
  /Insert .* here/i,
  // Generic template placeholder text produced by LLMs
  /\bItem (?:One|Two|Three|Four|Five)\b/,
  /\b(?:First|Second|Third) sample item\b/i,
  /Your application dashboard/i,
  /Failed to load data \(showing demo data\)/i,
  /Sample (?:item|product|entry|record) \d/i,
];

function findPlaceholders(dir: string): Array<{ file: string; match: string }> {
  const results: Array<{ file: string; match: string }> = [];
  if (!fs.existsSync(dir)) return results;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules') {
      results.push(...findPlaceholders(full));
    } else if (entry.isFile() && (entry.name.endsWith('.tsx') || entry.name.endsWith('.ts'))) {
      const code = fs.readFileSync(full, 'utf8');
      for (const pat of PLACEHOLDER_PATTERNS) {
        const m = code.match(pat);
        if (m) {
          results.push({ file: full, match: m[0] });
          break; // one warning per file
        }
      }
    }
  }
  return results;
}

// ── Layer 2: Build error parsing + LLM repair ─────────────────────────────────

function parseBuildErrors(output: string, basePath: string): BuildError[] {
  const errors: BuildError[] = [];
  const seen = new Set<string>();

  // TypeScript: path/to/file.tsx(10,5): error TS2345: message
  const tsPattern = /^(.+\.(?:ts|tsx|js|jsx))\((\d+),(\d+)\):\s+error\s+TS\d+:\s+(.+)$/gm;
  for (const m of output.matchAll(tsPattern)) {
    const [raw, relFile, line, col, message] = m;
    const absFile = path.isAbsolute(relFile) ? relFile : path.join(basePath, relFile);
    const key = absFile;
    if (!seen.has(key) && fs.existsSync(absFile)) {
      seen.add(key);
      errors.push({ file: absFile, line: parseInt(line), col: parseInt(col), message, raw });
    }
  }

  // Next.js build errors: ./app/foo/page.tsx\nType error: ...
  // The format varies — sometimes the path has :line:col appended before the newline.
  const nextPattern = /^\.\/([\w/.\[\]-]+\.(?:ts|tsx|js|jsx))(?::\d+:\d+)?\s*\nType error:\s*(.+)$/gm;
  for (const m of output.matchAll(nextPattern)) {
    const [raw, relFile, message] = m;
    const absFile = path.join(basePath, relFile);
    if (!seen.has(absFile) && fs.existsSync(absFile)) {
      seen.add(absFile);
      errors.push({ file: absFile, line: 0, col: 0, message, raw });
    }
  }

  // SWC/webpack syntax errors (Next.js Rust compiler):
  //   ./app/signup/page.tsx
  //   Error:
  //    x Expected ',', got ';'
  //   ,-[ /abs/path/file.tsx:30:1]
  // parseBuildErrors previously returned 0 for these, causing the repair loop
  // to bail immediately instead of sending the file to the LLM for fixing.
  const swcFilePattern = /^\.\/([\w/.\[\]-]+\.(?:ts|tsx|js|jsx))\s*\nError:\s*\n\s+x\s+(.+)/gm;
  for (const m of output.matchAll(swcFilePattern)) {
    const [raw, relFile, message] = m;
    const absFile = path.join(basePath, relFile);
    if (seen.has(absFile) || !fs.existsSync(absFile)) continue;
    // Try to extract line number from the caret block: ,-[ /path/file.tsx:30:1]
    const lineMatch = raw.match(/,\-\[\s*[^\]]+:(\d+):(\d+)\]/);
    const line = lineMatch ? parseInt(lineMatch[1]) : 0;
    const col  = lineMatch ? parseInt(lineMatch[2]) : 0;
    seen.add(absFile);
    errors.push({ file: absFile, line, col, message: `Syntax error: ${message}`, raw });
  }

  // Next.js prerender errors: "Error occurred prerendering page "/checkout""
  // These crash in minified server bundles so there's no file+line in the output.
  // Map the route path back to its source page file so the LLM repair loop can act on it.
  const prerenderPattern = /Error occurred prerendering page "([^"]+)"/gm;
  for (const m of output.matchAll(prerenderPattern)) {
    const route = m[1]; // e.g. "/" or "/checkout" or "/_not-found"
    if (route.startsWith('/_')) continue; // skip Next.js internals (_not-found, _error)
    const relFile = route === '/' ? 'app/page.tsx' : `app${route}/page.tsx`;
    const absFile = path.join(basePath, relFile);
    if (!seen.has(absFile) && fs.existsSync(absFile)) {
      seen.add(absFile);
      errors.push({
        file: absFile,
        line: 0,
        col: 0,
        message: `Prerender error on page "${route}": page crashed during static generation. Common causes: React hook used without 'use client', useSearchParams() without Suspense, import from 'next/router' instead of 'next/navigation'.`,
        raw: m[0],
      });
    }
  }

  return errors;
}

/**
 * Deterministic fixes for known recurring TypeScript error patterns.
 * Applied before LLM repair to avoid wasting tokens on predictable issues.
 * Returns the set of absolute file paths that were successfully patched.
 */
function deterministicRepair(errors: BuildError[], onOutput: OnOutput): Set<string> {
  const byFile = new Map<string, BuildError[]>();
  for (const e of errors) {
    const existing = byFile.get(e.file) ?? [];
    existing.push(e);
    byFile.set(e.file, existing);
  }

  const patched = new Set<string>();
  for (const [file, fileErrors] of byFile) {
    let code: string;
    try { code = fs.readFileSync(file, 'utf8'); } catch { continue; }
    let updated = code;

    for (const e of fileErrors) {
      // TS2451: Cannot redeclare block-scoped variable — file is being treated as a script.
      // Fix: ensure the file is a module by adding `export {}` if it has no exports already.
      if (e.message.includes('Cannot redeclare block-scoped variable')) {
        if (!/\bexport\b/.test(updated)) {
          updated = updated + '\nexport {};\n';
        }
      }

      // SWC "Expected ',', got ';'" — LLM emitted `}, { ... };` instead of `}, { ... });`
      // i.e. forgot the closing `)` before `;` on a trace_* call with an object arg.
      if (e.message.includes("Expected ','") || e.message.includes("Syntax error")) {
        updated = updated.replace(
          /(},\s*\{(?:[^{}]|\{[^}]*\})*\})\s*;/g,
          (_, group) => group + ');'
        );
      }

      // TS18046: 'err' is of type 'unknown' — catch clause err access.
      // Fix: cast to Error before accessing .message / .stack
      if (e.message.includes("is of type 'unknown'")) {
        updated = updated
          .replace(/\bcatch\s*\(\s*(\w+)\s*\)/g, 'catch ($1: unknown)')
          .replace(/\b(\w+)\.message\b/g, '($1 as Error).message')
          .replace(/\b(\w+)\.stack\b/g, '($1 as Error).stack');
      }
    }

    if (updated !== code) {
      try {
        fs.writeFileSync(file, updated, 'utf8');
        onOutput(`   ✓ Deterministic fix applied to ${path.basename(file)}\n`);
        patched.add(file);
      } catch {}
    }
  }
  return patched;
}

async function repairBuildErrors(
  errors: BuildError[],
  llmConfig: LLMConfig,
  onOutput: OnOutput
): Promise<number> {
  // Step 1: Apply deterministic fixes for known patterns (no LLM needed)
  const detPatched = deterministicRepair(errors, onOutput);
  let repairedCount = detPatched.size;

  // Step 2: LLM repair for remaining errors — group by file, skip already-patched files
  const byFile = new Map<string, BuildError[]>();
  for (const e of errors) {
    if (detPatched.has(e.file)) continue; // already fixed deterministically
    const existing = byFile.get(e.file) ?? [];
    existing.push(e);
    byFile.set(e.file, existing);
  }

  for (const [file, fileErrors] of byFile) {
    let code: string;
    try { code = fs.readFileSync(file, 'utf8'); } catch { continue; }

    const errorSummary = fileErrors
      .map(e => e.line > 0 ? `Line ${e.line}: ${e.message}` : e.message)
      .join('\n');

    onOutput(`   Fixing ${path.basename(file)}…\n`);

    const isPrerenderError = fileErrors.some(e => e.message.startsWith('Prerender error'));
    const nextjsRules = isPrerenderError ? `

NEXT.JS 14 APP ROUTER RULES (this is the root cause — apply all of these):
- Every component that calls ANY React hook (useState, useEffect, useContext, useCallback, useMemo, useRef, useReducer, useSearchParams, useRouter, usePathname, useParams) MUST have 'use client'; as the very first line of the file.
- If the component uses useSearchParams(), wrap the exported default function in a <Suspense> boundary from 'react'.
- Always import router hooks from 'next/navigation' — NEVER from 'next/router'.
- NEVER import Html, Head, Main, or NextScript from 'next/document' in a page component.
- Pages with NO hooks and NO browser APIs can omit 'use client' (they are Server Components).` : '';

    const prompt = `Fix the following TypeScript/JavaScript build errors in this file.
Return ONLY the complete corrected file contents — no explanation, no markdown fences.${nextjsRules}

ERRORS:
${errorSummary}

FILE (${path.basename(file)}):
${code}`;

    try {
      const fixed = await callLlm(prompt, llmConfig);
      if (fixed && fixed.trim() !== code.trim()) {
        fs.writeFileSync(file, fixed, 'utf8');
        repairedCount++;
        onOutput(`   ✓ Fixed ${path.basename(file)}\n`);
      }
    } catch (err: any) {
      onOutput(`   ✗ Could not fix ${path.basename(file)}: ${err?.message ?? err}\n`);
    }
  }

  return repairedCount;
}

// ── Layer 3: Smoke test ───────────────────────────────────────────────────────

async function smokeTestBackend(
  backendPath: string,
  isPython: boolean,
  onOutput: OnOutput
): Promise<{ started: boolean; error?: string }> {
  const SMOKE_TIMEOUT_MS = 8000;
  const HEALTH_CHECK_DELAY_MS = 4000;
  const PORT = 3099; // use a different port to avoid conflicts

  return new Promise(resolve => {
    let resolved = false;
    const done = (result: { started: boolean; error?: string }) => {
      if (resolved) return;
      resolved = true;
      try { proc?.kill(); } catch {}
      resolve(result);
    };

    let command: string;
    let args: string[];
    let env: NodeJS.ProcessEnv;

    if (isPython) {
      const entry = ['main.py', 'app.py'].find(f =>
        fs.existsSync(path.join(backendPath, f))
      ) ?? 'main.py';
      command = 'python3';
      args = [entry];
      env = { ...process.env, PORT: String(PORT), SENTRY_DSN: 'http://dummy@localhost/0' };
    } else {
      command = 'npx';
      args = ['tsx', 'src/index.ts'];
      env = { ...process.env, PORT: String(PORT), SENTRY_DSN: 'http://dummy@localhost/0' };
    }

    let stderr = '';
    const proc = spawn(command, args, { cwd: backendPath, env });

    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('error', err => done({ started: false, error: err.message }));
    proc.on('exit', code => {
      if (code !== null && code !== 0) {
        done({ started: false, error: stderr.slice(0, 300) });
      }
    });

    // Give the server time to start, then check if it's still running
    setTimeout(async () => {
      if (resolved) return;
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}/health`).catch(() =>
          fetch(`http://127.0.0.1:${PORT}/`)
        );
        done({ started: res.status < 500 });
      } catch {
        // If fetch fails but process is still alive, it's probably started
        if (!proc.killed && proc.exitCode === null) {
          done({ started: true });
        } else {
          done({ started: false, error: stderr.slice(0, 300) });
        }
      }
    }, HEALTH_CHECK_DELAY_MS);

    setTimeout(() => done({ started: false, error: 'Timed out waiting for backend to start' }), SMOKE_TIMEOUT_MS);
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function runCommand(
  cmd: string,
  args: string[],
  cwd: string,
  onOutput: OnOutput,
  extraEnv?: NodeJS.ProcessEnv
): Promise<{ exitCode: number; output: string }> {
  return new Promise(resolve => {
    let output = '';
    const env = extraEnv ? { ...process.env, ...extraEnv } : undefined;
    const proc = spawn(cmd, args, { cwd, shell: false, env });

    const handleData = (data: Buffer) => {
      const text = data.toString();
      output += text;
      // Stream condensed output — skip blank lines and node_modules noise
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.includes('node_modules') && !trimmed.startsWith('info')) {
          onOutput(`     ${trimmed}\n`);
        }
      }
    };

    proc.stdout?.on('data', handleData);
    proc.stderr?.on('data', handleData);
    proc.on('close', code => resolve({ exitCode: code ?? 1, output }));
    proc.on('error', err => resolve({ exitCode: 1, output: err.message }));
  });
}

async function callLlm(prompt: string, config: LLMConfig): Promise<string> {
  const { baseUrl, apiKey, model = 'gpt-4-turbo-preview' } = config;
  if (!baseUrl || !apiKey) throw new Error('LLM not configured');

  const TIMEOUT_MS = 60_000; // 60s — local models can be slow but shouldn't hang forever
  const MAX_ATTEMPTS = 2;

  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
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
          temperature: 0.2,
          max_tokens: 4000,
        }),
      });

      if (!response.ok) {
        const err = await response.text().catch(() => '');
        throw new Error(`LLM error ${response.status}: ${err.slice(0, 200)}`);
      }

      const data = await response.json() as any;
      const raw = data.choices?.[0]?.message?.content ?? '';
      return raw
        .replace(/^```(?:typescript|tsx|javascript|js|python)?\n?/, '')
        .replace(/\n?```[\s\S]*$/, '')
        .trim();
    } catch (err: any) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < MAX_ATTEMPTS) {
        // brief pause before retry
        await new Promise(r => setTimeout(r, 1000));
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError ?? new Error('LLM call failed');
}
