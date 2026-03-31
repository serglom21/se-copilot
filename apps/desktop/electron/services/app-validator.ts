import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { EngagementSpec } from '../../src/types/spec';
import type { LLMService } from './llm';
import { ValidationLogger } from './validation-logger';
import type { RouteContract } from './route-contract';
import { extractFrontendFetchUrls, runIntegrationHealthCheck, repairRouteMismatch } from './integration-health-check';
import { buildRepairPreamble } from './sdk-version-guard';
import { buildRepairContext, TSError } from './repair-context-builder';
import type { FetchCall, HealthCheckResult } from './integration-health-check';

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
  onOutput: OnOutput,
  llmService?: LLMService,
  routeContract?: RouteContract
): Promise<AppValidationResult> {
  const warnings: string[] = [];
  const errors: string[] = [];
  let buildRepaired = false;

  const isPython = project.stack.backend === 'flask' || project.stack.backend === 'fastapi';
  const isBackendOnly = project.stack.type === 'backend-only';
  const frontendPath = path.join(appPath, 'frontend');
  const backendPath = isPython ? appPath : path.join(appPath, 'backend');

  const logger = new ValidationLogger(onOutput);

  // ── Layer 1: Static structure check ──────────────────────────────────────
  onProgress(86, 'Checking app structure…');
  logger.startStep('Layer 1', 'Static structure check');
  try {
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
    const fatalCount = structureIssues.filter(i => i.fatal).length;
    if (fatalCount > 0) {
      logger.completeStep('failed', `${fatalCount} fatal structure issue(s)`);
    } else if (structureIssues.length > 0) {
      logger.completeStep('warned', `${structureIssues.length} non-fatal issue(s) found`);
    } else {
      logger.completeStep('passed', 'All required files present');
    }
  } catch (err: any) {
    logger.failStep(err);
    errors.push(`Structure check threw: ${err.message}`);
  }

  // ── Layer 2a: Install dependencies ───────────────────────────────────────
  onProgress(87, 'Installing dependencies…');
  logger.startStep('Layer 2a', 'Install dependencies');
  try {
    let installFailed = false;
    let packagesInstalled = 0;

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
          installFailed = true;
        }
      }
      const feNm = path.join(frontendPath, 'node_modules');
      if (fs.existsSync(feNm)) {
        try { packagesInstalled += fs.readdirSync(feNm).length; } catch {}
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
          installFailed = true;
        }
      }
      const beNm = path.join(backendPath, 'node_modules');
      if (fs.existsSync(beNm)) {
        try { packagesInstalled += fs.readdirSync(beNm).length; } catch {}
      }
    }

    if (installFailed) {
      logger.completeStep('warned', 'Install had failures — build may fail');
    } else {
      logger.completeStep('passed', `~${packagesInstalled} packages installed`);
    }
  } catch (err: any) {
    logger.failStep(err);
  }

  // ── Layer 2b: Build check + LLM repair loop ───────────────────────────────
  onProgress(88, 'Building frontend…');
  logger.startStep('Layer 2b', 'Build check');
  try {
    const MAX_BUILD_ATTEMPTS = 3;
    let buildRepairs = 0;
    let buildAllPassed = true;

    if (!isBackendOnly) {
      // Frontend: next build
      let feBuildPassed = false;
      let fePrevErrorSig = '';
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
          buildAllPassed = false;
          break;
        }

        // Fix 3: Convergence check — stop if same errors persist after repair
        const errSig = buildErrors.map(e => `${path.basename(e.file)}:${e.message}`).sort().join('|');
        if (attempt > 1 && errSig === fePrevErrorSig) {
          onOutput(`   ✗ Repair not converging — same ${buildErrors.length} error(s) after attempt ${attempt - 1}. Stopping.\n`);
          errors.push(`Frontend build failed: repair loop stalled after ${attempt - 1} attempt(s)`);
          buildAllPassed = false;
          break;
        }
        fePrevErrorSig = errSig;

        onOutput(`   Found ${buildErrors.length} error(s) in ${new Set(buildErrors.map(e => e.file)).size} file(s) — attempting LLM repair…\n`);
        const repaired = await repairBuildErrors(buildErrors, llmConfig, onOutput, llmService, frontendPath);
        if (repaired > 0) {
          buildRepaired = true;
          buildRepairs += repaired;
          onOutput(`   🔧 Repaired ${repaired} file(s)\n`);
        }
      }
      if (!feBuildPassed && buildAllPassed) {
        buildAllPassed = false;
        onOutput('   ✗ Frontend build could not be fixed automatically\n');
      }
    }

    // Backend: tsc --noEmit (TypeScript only; Python gets a syntax check)
    onProgress(93, 'Building backend…');
    if (!isPython) {
      let beBuildPassed = false;
      let bePrevErrorSig = '';
      for (let attempt = 1; attempt <= MAX_BUILD_ATTEMPTS; attempt++) {
        onOutput(`\n   Backend type-check (attempt ${attempt}/${MAX_BUILD_ATTEMPTS})…\n`);
        const { exitCode, output } = await runCommand('npx', ['tsc', '--noEmit'], backendPath, onOutput);

        if (exitCode === 0) {
          onOutput('   ✓ Backend type-check passed\n');
          beBuildPassed = true;
          break;
        }

        const buildErrors = parseBuildErrors(output, backendPath);
        if (buildErrors.length === 0 || attempt === MAX_BUILD_ATTEMPTS) {
          errors.push(`Backend type-check failed after ${attempt} attempt(s)`);
          buildAllPassed = false;
          break;
        }

        // Fix 3: Convergence check — stop if same errors persist after repair
        const errSig = buildErrors.map(e => `${path.basename(e.file)}:${e.message}`).sort().join('|');
        if (attempt > 1 && errSig === bePrevErrorSig) {
          onOutput(`   ✗ Repair not converging — same ${buildErrors.length} error(s) after attempt ${attempt - 1}. Stopping.\n`);
          errors.push(`Backend type-check failed: repair loop stalled after ${attempt - 1} attempt(s)`);
          buildAllPassed = false;
          break;
        }
        bePrevErrorSig = errSig;

        onOutput(`   Found ${buildErrors.length} error(s) — attempting LLM repair…\n`);
        const repaired = await repairBuildErrors(buildErrors, llmConfig, onOutput, llmService, backendPath);
        if (repaired > 0) {
          buildRepaired = true;
          buildRepairs += repaired;
          onOutput(`   🔧 Repaired ${repaired} file(s)\n`);
        }
      }
      if (!beBuildPassed && buildAllPassed) {
        buildAllPassed = false;
        onOutput('   ✗ Backend build could not be fixed automatically\n');
      }
    } else {
      // Python syntax check — fast, no dependencies needed
      onOutput('\n   Python syntax check…\n');
      const pyFiles = findPythonEntryFile(backendPath);
      const pyEntry = pyFiles[0];

      if (pyEntry) {
        const pyEntryName = path.basename(pyEntry);
        const { exitCode, output } = await runCommand('python3', ['-m', 'py_compile', pyEntryName], backendPath, onOutput);
        if (exitCode === 0) {
          onOutput('   ✓ Python syntax OK\n');
          onOutput('   Running pylint check…\n');
          const pylintResult = await runPylintCheck(backendPath, pyEntryName, onOutput);
          if (pylintResult.errors.length > 0) {
            onOutput(`   Found ${pylintResult.errors.length} pylint error(s) — attempting repair…\n`);
            const pyRepaired = await repairPythonErrors(pyEntry, pylintResult.errors, project, llmConfig, onOutput, llmService);
            if (pyRepaired) {
              buildRepaired = true;
              buildRepairs++;
              onOutput('   ✓ Python errors repaired\n');
            }
          } else {
            onOutput('   ✓ Pylint check passed\n');
          }
        } else {
          errors.push(`Python syntax error in ${pyEntryName}`);
          buildAllPassed = false;
          onOutput(`   ✗ ${output.trim()}\n`);
        }
      }
    }

    if (!buildAllPassed) {
      logger.completeStep('failed', 'Build failed — could not auto-repair');
    } else if (buildRepairs > 0) {
      logger.completeStep('warned', `Build passed after ${buildRepairs} repair(s)`);
    } else {
      logger.completeStep('passed', 'Build passed clean');
    }
  } catch (err: any) {
    logger.failStep(err);
    errors.push(`Build check threw: ${err.message}`);
  }

  // ── Layers 2c / 2e / 2f: Integration health check ────────────────────────
  // Only runs when a routeContract was derived (non-mobile, non-backend-only stacks)
  if (routeContract && !isBackendOnly) {
    let fetchCalls: FetchCall[] = [];

    // Layer 2c: Extract fetch() URLs from generated page files
    logger.startStep('Layer 2c', 'Extract frontend fetch() URLs');
    try {
      const appDir = fs.existsSync(path.join(frontendPath, 'app'))
        ? path.join(frontendPath, 'app')
        : path.join(frontendPath, 'src', 'app');
      const pageFiles: string[] = [];
      const walkDir = (dir: string) => {
        if (!fs.existsSync(dir)) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walkDir(full);
          else if (/\.(tsx|ts|jsx|js)$/.test(entry.name) && /^page\.|^route\./.test(entry.name)) pageFiles.push(full);
        }
      };
      walkDir(appDir);

      fetchCalls = extractFrontendFetchUrls(pageFiles);

      if (fetchCalls.length === 0) {
        logger.completeStep('skipped', 'No fetch() calls found in page files');
      } else {
        for (const c of fetchCalls) {
          onOutput(`   ${c.method} ${new URL(c.url).pathname}  (${path.basename(c.pageFile)})\n`);
        }
        logger.completeStep('passed', `Found ${fetchCalls.length} fetch() call(s)`);
      }
    } catch (err: any) {
      logger.failStep(err);
      fetchCalls = [];
    }

    if (fetchCalls.length > 0) {
      // Layer 2e: Integration health check — fire real HTTP requests
      onProgress(95, 'Integration health check…');
      logger.startStep('Layer 2e', `Health check (${fetchCalls.length} endpoints)`);
      let healthResult: HealthCheckResult | null = null;
      try {
        healthResult = await runIntegrationHealthCheck(
          fetchCalls,
          backendPath,
          isPython,
          routeContract,
          onOutput
        );

        const failCount = healthResult.checks.filter(c => !c.passed).length;
        if (healthResult.passed) {
          logger.completeStep('passed', `All ${healthResult.checks.length} routes verified`);
        } else {
          logger.completeStep('warned', `${failCount}/${healthResult.checks.length} routes failed — repair needed`);
        }
      } catch (err: any) {
        logger.failStep(err);
        healthResult = null;
      }

      // Layer 2f: Repair + re-verify loop
      if (healthResult && !healthResult.passed) {
        const MAX_REPAIR_ROUNDS = 3;
        const backendRoutesPath = path.join(backendPath, 'src', 'routes', 'api.ts');
        const appDir = fs.existsSync(path.join(frontendPath, 'app'))
          ? path.join(frontendPath, 'app')
          : path.join(frontendPath, 'src', 'app');

        logger.startStep('Layer 2f', `Route repair (up to ${MAX_REPAIR_ROUNDS} rounds)`);
        try {
          let currentResult = healthResult;
          let totalRepairedFiles = 0;
          let prevFailureSig = '';

          for (let round = 1; round <= MAX_REPAIR_ROUNDS; round++) {
            if (currentResult.passed) break;

            // Convergence check: stop if the same URLs are failing again after repair
            const failureSig = currentResult.checks
              .filter(c => !c.passed)
              .map(c => `${c.method}:${c.url}`)
              .sort()
              .join('|');
            if (round > 1 && failureSig === prevFailureSig) {
              onOutput(`   ✗ Route repair not converging — same ${currentResult.checks.filter(c => !c.passed).length} failure(s) after round ${round - 1}. Stopping.\n`);
              break;
            }
            prevFailureSig = failureSig;

            const failures = currentResult.checks
              .filter(c => !c.passed)
              .map(c => ({
                url: c.url,
                method: c.method,
                pageFile: c.pageFile,
                spanHint: c.spanHint,
                status: c.status,
                failure: c.failure,
              }));

            onOutput(`\n   Round ${round}/${MAX_REPAIR_ROUNDS}: repairing ${failures.length} failure(s)…\n`);

            const repairResult = await repairRouteMismatch(
              failures,
              backendRoutesPath,
              appDir,
              routeContract,
              llmService,
              llmConfig,
              onOutput
            );

            if (repairResult.anyChangesApplied) {
              buildRepaired = true;
              totalRepairedFiles += repairResult.repairedFiles.length;
              onOutput(`   ✓ Round ${round}: changed ${repairResult.repairedFiles.map(f => path.basename(f)).join(', ')}\n`);

              // Re-extract fetch URLs from the now-modified source files before re-verifying.
              // The old fetchCalls may contain URLs that were just removed from the page —
              // if we reuse the stale list, the health check would keep testing URLs that
              // no longer exist in the source, looping forever.
              const pageFilesAfterRepair: string[] = [];
              const walkForRefresh = (dir: string) => {
                if (!fs.existsSync(dir)) return;
                for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                  const full = path.join(dir, entry.name);
                  if (entry.isDirectory()) walkForRefresh(full);
                  else if (/\.(tsx|ts|jsx|js)$/.test(entry.name) && /^page\.|^route\./.test(entry.name)) pageFilesAfterRepair.push(full);
                }
              };
              walkForRefresh(appDir);
              const freshFetchCalls = extractFrontendFetchUrls(pageFilesAfterRepair);
              onOutput(`   ${freshFetchCalls.length} fetch() call(s) in source after repair\n`);

              if (freshFetchCalls.length === 0) {
                // All fetch calls were removed — nothing left to fail
                currentResult = { passed: true, checks: [] };
                break;
              }

              // Re-verify after repair
              onOutput('   Re-running health check…\n');
              currentResult = await runIntegrationHealthCheck(
                freshFetchCalls,
                backendPath,
                isPython,
                routeContract,
                onOutput
              );
            } else {
              // No changes applied — further rounds won't help
              onOutput(`   ⚠ Round ${round}: no changes applied — stopping\n`);
              for (const sf of repairResult.skippedFailures) {
                onOutput(`     – ${sf.url}: ${sf.reason}\n`);
              }
              break;
            }
          }

          const remainingFails = currentResult.checks.filter(c => !c.passed).length;
          if (currentResult.passed) {
            logger.completeStep('passed', `All routes healthy after ${totalRepairedFiles} file repair(s)`);
          } else {
            logger.completeStep('warned', `${remainingFails} route(s) still failing after ${MAX_REPAIR_ROUNDS} round(s)`);
            warnings.push(`${remainingFails} integration health check failure(s) remain after repair`);
          }
        } catch (err: any) {
          logger.failStep(err);
          warnings.push(`Route repair threw: ${err.message}`);
        }
      }
    }
  }

  // ── Layer 3: Smoke test — quick backend start ─────────────────────────────
  onProgress(96, 'Running smoke test…');
  logger.startStep('Layer 3', 'Backend smoke test');
  try {
    const smokeResult = await smokeTestBackend(backendPath, isPython, onOutput);
    if (!smokeResult.started) {
      warnings.push('Backend failed to start during smoke test — check server initialization');
      onOutput(`   ⚠ Backend did not start cleanly: ${smokeResult.error}\n`);
      logger.completeStep('warned', `Did not start: ${smokeResult.error?.slice(0, 60) ?? 'unknown error'}`);
    } else {
      logger.completeStep('passed', 'Backend started successfully');
    }
  } catch (err: any) {
    logger.failStep(err);
    warnings.push(`Smoke test threw: ${err.message}`);
  }

  onProgress(98, 'Validation complete');
  const summary = logger.printSummary();

  return {
    success: summary.passed,
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
// Known Next.js / React symbols → import line (Fix 2)
const KNOWN_IMPORT_MAP: Record<string, string> = {
  'Link':            "import Link from 'next/link'",
  'Image':           "import Image from 'next/image'",
  'useRouter':       "import { useRouter } from 'next/navigation'",
  'usePathname':     "import { usePathname } from 'next/navigation'",
  'useSearchParams': "import { useSearchParams } from 'next/navigation'",
  'useState':        "import { useState } from 'react'",
  'useEffect':       "import { useEffect } from 'react'",
  'useCallback':     "import { useCallback } from 'react'",
  'useRef':          "import { useRef } from 'react'",
  'useMemo':         "import { useMemo } from 'react'",
  'useContext':      "import { useContext } from 'react'",
  'Suspense':        "import { Suspense } from 'react'",
  'Metadata':        "import type { Metadata } from 'next'",
};

function deterministicRepair(errors: BuildError[], onOutput: OnOutput, projectDir?: string): Set<string> {
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
      if (e.message.includes('Cannot redeclare block-scoped variable')) {
        if (!/\bexport\b/.test(updated)) {
          updated = updated + '\nexport {};\n';
        }
      }

      // SWC syntax error — forgot closing `)` on trace_* call
      if (e.message.includes("Expected ','") || e.message.includes("Syntax error")) {
        updated = updated.replace(
          /(},\s*\{(?:[^{}]|\{[^}]*\})*\})\s*;/g,
          (_, group) => group + ');'
        );
      }

      // TS18046: 'err' is of type 'unknown' — cast catch variable
      if (e.message.includes("is of type 'unknown'")) {
        updated = updated
          .replace(/\bcatch\s*\(\s*(\w+)\s*\)/g, 'catch ($1: unknown)')
          .replace(/\b(\w+)\.message\b/g, '($1 as Error).message')
          .replace(/\b(\w+)\.stack\b/g, '($1 as Error).stack');
      }

      // Fix 2A: TS2304 Cannot find name 'trace_*' — normalise against instrumentation exports
      const traceMissingMatch = e.message.match(/Cannot find name '(trace_\w+)'/);
      if (traceMissingMatch && projectDir) {
        const { normaliseTraceFunctionNames } = require('./instrumentation-injector');
        const instrCandidates = [
          path.join(projectDir, 'src', 'instrumentation.ts'),
          path.join(projectDir, 'lib', 'instrumentation.ts'),
          path.join(projectDir, 'instrumentation.ts'),
        ];
        const instrFile = instrCandidates.find(p => fs.existsSync(p));
        if (instrFile) {
          const renames = normaliseTraceFunctionNames(file, instrFile);
          if (renames.length > 0) {
            // Re-read after normalisation (file was written by normaliseTraceFunctionNames)
            try { updated = fs.readFileSync(file, 'utf8'); } catch {}
            onOutput(`   ✓ Normalised ${renames.length} trace function name(s) in ${path.basename(file)}\n`);
          }
        }
      }

      // Fix 2B: TS2304 Cannot find name 'Link'/'useRouter'/etc. — add missing import
      const symbolMissingMatch = e.message.match(/Cannot find name '(\w+)'/);
      if (symbolMissingMatch && !e.message.includes('trace_')) {
        const sym = symbolMissingMatch[1];
        const importLine = KNOWN_IMPORT_MAP[sym];
        if (importLine && !updated.includes(importLine)) {
          // Insert after 'use client' if present, otherwise at the top
          if (updated.startsWith("'use client'")) {
            updated = updated.replace("'use client'\n", `'use client'\n${importLine}\n`);
          } else if (updated.startsWith('"use client"')) {
            updated = updated.replace('"use client"\n', `"use client"\n${importLine}\n`);
          } else {
            updated = `${importLine}\n${updated}`;
          }
          onOutput(`   ✓ Added missing import: ${importLine}\n`);
        }
      }

      // Fix 2C: TS6133 'X' declared but never read — prefix with _ to suppress
      const unusedMatch = e.message.match(/'(\w+)' is declared but its value is never read/);
      if (unusedMatch) {
        const varName = unusedMatch[1];
        if (!varName.startsWith('_')) {
          updated = updated.replace(
            new RegExp(`\\b(const|let|var)\\s+${varName}\\b`),
            `$1 _${varName}`
          );
        }
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
  onOutput: OnOutput,
  llmService?: LLMService,
  projectDir?: string
): Promise<number> {
  // Step 1: Apply deterministic fixes for known patterns (no LLM needed)
  const detPatched = deterministicRepair(errors, onOutput, projectDir);
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

    // Collect original imports before LLM repair so we can restore any dropped ones
    const originalImports = extractImportLines(code);

    const sdkPreamble = buildRepairPreamble(projectDir);

    // Build cross-file context (Fix 1 / Fix B): TS error codes → instrumentation exports,
    // SDK version notes, missing import hints, etc.
    const tsErrors: TSError[] = fileErrors.map(e => {
      const codeMatch = e.raw?.match(/error\s+(TS\d+):/);
      return {
        code: codeMatch ? codeMatch[1] : 'TS0000',
        message: e.message,
        line: e.line,
        file: e.file,
      };
    });
    const crossFileContext = projectDir
      ? buildRepairContext(tsErrors, file, projectDir)
      : '';
    const contextSection = crossFileContext
      ? `\nCROSS-FILE CONTEXT (ground truth — do not deviate from this):\n${crossFileContext}\n`
      : '';

    const prompt = `${sdkPreamble}${contextSection}Fix the following TypeScript/JavaScript build errors in this file.
Return ONLY the complete corrected file contents — no explanation, no markdown fences.

CRITICAL: Preserve EVERY import statement that exists in the original file.
Do NOT remove any import, even if you think it is unused — the build will fail without it.
Only ADD imports if they are needed to fix the errors below.${nextjsRules}

ERRORS:
${errorSummary}

FILE (${path.basename(file)}):
${code}`;

    try {
      let fixed = llmService
        ? await llmService.callLLMDirect([{ role: 'user', content: prompt }], {
            baseUrl: llmConfig.baseUrl,
            apiKey: llmConfig.apiKey,
            model: llmConfig.model ?? 'gpt-4-turbo-preview',
          } as any).then((raw: string) => raw.replace(/^```(?:typescript|tsx|javascript|js|python)?\n?/, '').replace(/\n?```[\s\S]*$/, '').trim())
        : await callLlm(prompt, llmConfig);
      if (fixed && fixed.trim() !== code.trim()) {
        // Deterministic post-repair: restore any imports the LLM silently dropped
        fixed = restoreDroppedImports(fixed, originalImports);
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

// ── Import preservation helpers ───────────────────────────────────────────────

/**
 * Extract every `import` statement from a TypeScript/JavaScript source string.
 * Returns each import as a trimmed string (may span multiple lines joined to one).
 */
function extractImportLines(code: string): string[] {
  const imports: string[] = [];
  // Match single-line and simple multi-line imports
  const importRe = /^import\s+[^;]+;/gm;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(code)) !== null) {
    imports.push(m[0].trim());
  }
  return imports;
}

/**
 * Compare `originalImports` against what appears in `repairedCode`.
 * Re-insert any import that was present in the original but is missing from the repair.
 * Inserts missing imports after the last existing import block to preserve grouping.
 */
function restoreDroppedImports(repairedCode: string, originalImports: string[]): string {
  const missing = originalImports.filter(imp => {
    // Check by the imported symbol(s) / module path — not byte-exact match,
    // because the LLM may reformat spacing.
    // Extract the module path from the import (last quoted string).
    const moduleMatch = /from\s+['"]([^'"]+)['"]/g.exec(imp) ?? /import\s+['"]([^'"]+)['"]/g.exec(imp);
    if (!moduleMatch) return false;
    const modulePath = moduleMatch[1];
    return !repairedCode.includes(modulePath);
  });

  if (missing.length === 0) return repairedCode;

  // Find the position after the last import line in the repaired code
  const lines = repairedCode.split('\n');
  let lastImportIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trimStart().startsWith('import ')) lastImportIdx = i;
  }

  const insertAt = lastImportIdx >= 0 ? lastImportIdx + 1 : 0;
  lines.splice(insertAt, 0, ...missing);
  return lines.join('\n');
}

// ── Python helpers ────────────────────────────────────────────────────────────

interface PylintError {
  line: number;
  column: number;
  message: string;
  messageId: string;
  symbol: string;
}

interface PylintResult {
  errors: PylintError[];
}

async function runPylintCheck(
  backendPath: string,
  pyFile: string,
  onOutput: OnOutput
): Promise<PylintResult> {
  try {
    const { output } = await runCommand(
      'python3', ['-m', 'pylint', '--errors-only', '--output-format=json', pyFile],
      backendPath, () => {} // suppress per-line output for pylint
    );
    try {
      const parsed = JSON.parse(output);
      if (!Array.isArray(parsed)) return { errors: [] };
      return {
        errors: parsed.map((item: any) => ({
          line: item.line ?? 0,
          column: item.column ?? 0,
          message: item.message ?? '',
          messageId: item['message-id'] ?? '',
          symbol: item.symbol ?? '',
        }))
      };
    } catch {
      // pylint not installed or JSON parse failed — non-fatal
      return { errors: [] };
    }
  } catch {
    return { errors: [] };
  }
}

async function repairPythonErrors(
  filePath: string,
  pylintErrors: PylintError[],
  project: EngagementSpec,
  llmConfig: LLMConfig,
  onOutput: OnOutput,
  llmService?: LLMService
): Promise<boolean> {
  let code: string;
  try { code = fs.readFileSync(filePath, 'utf8'); } catch { return false; }

  const isFlask = code.includes('from flask import') || code.includes('import flask');
  const isFastAPI = code.includes('from fastapi import') || code.includes('import fastapi');

  const frameworkNote = isFlask
    ? '\nThis is a Flask application. Use Flask route decorators and patterns.'
    : isFastAPI
    ? '\nThis is a FastAPI application. Use FastAPI route decorators and async patterns.'
    : '';

  const errorSummary = pylintErrors
    .map(e => `Line ${e.line}: [${e.symbol}] ${e.message}`)
    .join('\n');

  const prompt = `Fix the following pylint errors in this Python file.
Return ONLY the complete corrected file contents — no explanation, no markdown fences.${frameworkNote}

PYLINT ERRORS:
${errorSummary}

FILE:
${code}`;

  try {
    const fixed = llmService
      ? await llmService.callLLMDirect([{ role: 'user', content: prompt }], {
          baseUrl: llmConfig.baseUrl,
          apiKey: llmConfig.apiKey,
          model: llmConfig.model ?? 'gpt-4-turbo-preview',
        } as any).then((raw: string) => raw.replace(/^```(?:python)?\n?/, '').replace(/\n?```[\s\S]*$/, '').trim())
      : await callLlm(prompt, llmConfig);

    if (fixed && fixed.trim() !== code.trim()) {
      fs.writeFileSync(filePath, fixed, 'utf8');
      return true;
    }
    return false;
  } catch (err: any) {
    onOutput(`   ✗ Python repair failed: ${err?.message ?? err}\n`);
    return false;
  }
}

function findPythonEntryFile(backendPath: string): string[] {
  // First: scan for Flask/FastAPI imports
  const candidates = ['main.py', 'app.py', 'routes.py', 'server.py'];
  const found: string[] = [];

  for (const candidate of candidates) {
    const full = path.join(backendPath, candidate);
    if (!fs.existsSync(full)) continue;
    try {
      const content = fs.readFileSync(full, 'utf8');
      // Prioritize files that define routes
      if (content.includes('from flask import') || content.includes('from fastapi import') ||
          content.includes('@app.route') || content.includes('@router.')) {
        found.unshift(full); // put Flask/FastAPI files first
      } else {
        found.push(full);
      }
    } catch {
      found.push(full);
    }
  }

  return found;
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
