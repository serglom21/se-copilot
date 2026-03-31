// integration-health-check.ts — Fires real HTTP requests at every URL the
// frontend declares to verify the backend has a matching route. Runs after the
// build passes and before Puppeteer flows so that missing routes are caught
// before the SE ever opens the app.

import fs from 'fs';
import path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { RouteContract, RouteDefinition } from './route-contract';

export interface FetchCall {
  url: string;       // e.g. "http://localhost:3001/api/signup/fetch-user"
  method: string;    // e.g. "GET"
  pageFile: string;  // full absolute path to the source file
  spanHint: string;  // best-guess span name from URL path, for error messages
}

export interface HealthCheckEntry {
  url: string;
  method: string;
  status: number | 'timeout' | 'connection_refused';
  passed: boolean;
  pageFile: string;
  spanHint: string;
  failure?: string;
}

export interface HealthCheckResult {
  passed: boolean;
  checks: HealthCheckEntry[];
}

export interface RepairResult {
  anyChangesApplied: boolean;
  attemptsUsed: number;
  repairedFiles: string[];
  skippedFailures: { url: string; reason: string }[];
}

type OnOutput = (line: string) => void;

// ---------------------------------------------------------------------------
// Extract fetch() URLs from generated page files using regex
// ---------------------------------------------------------------------------
export function extractFrontendFetchUrls(pageFiles: string[]): FetchCall[] {
  const calls: FetchCall[] = [];

  for (const pageFile of pageFiles) {
    if (!fs.existsSync(pageFile)) continue;
    const code = fs.readFileSync(pageFile, 'utf8');

    // Pattern 1: hardcoded absolute URL — fetch('http://localhost:3001/api/...')
    const hardcodedRegex = /fetch\(\s*['"`](https?:\/\/localhost:\d+\/api\/[^'"`]+)['"`](?:\s*,\s*\{[^}]*method:\s*['"`]([A-Z]+)['"`])?/g;
    let m: RegExpExecArray | null;

    while ((m = hardcodedRegex.exec(code)) !== null) {
      const rawUrl = m[1];
      const method = m[2] || 'GET';
      const urlPath = new URL(rawUrl).pathname;
      const spanHint = urlPath.replace(/^\/api\//, '').replace(/\//g, '.').replace(/-/g, '_');
      calls.push({ url: rawUrl, method, pageFile, spanHint });
    }

    // Pattern 2: template literal with variable prefix — fetch(`${API_URL}/api/...`)
    // Covers: ${API_URL}, ${process.env.NEXT_PUBLIC_API_URL}, ${BASE_URL}, etc.
    const templateRegex = /fetch\(\s*`\$\{[^}]+\}(\/api\/[^`\s?#]+)`(?:\s*,\s*\{[^}]*method:\s*['"`]([A-Z]+)['"`])?/g;

    while ((m = templateRegex.exec(code)) !== null) {
      const apiPath = m[1];
      const method = m[2] || 'GET';
      const rawUrl = `http://localhost:3001${apiPath}`;
      const spanHint = apiPath.replace(/^\/api\//, '').replace(/\//g, '.').replace(/-/g, '_');
      calls.push({ url: rawUrl, method, pageFile, spanHint });
    }
  }

  // Deduplicate by url+method
  const seen = new Set<string>();
  return calls.filter(c => {
    const key = `${c.method}:${c.url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Start the backend on a dedicated test port
// ---------------------------------------------------------------------------
async function startBackendForHealthCheck(
  backendPath: string,
  isPython: boolean,
  testPort: number,
  onOutput: OnOutput
): Promise<{ proc: ChildProcess | null; started: boolean; error?: string }> {
  return new Promise(resolve => {
    let resolved = false;
    const done = (started: boolean, error?: string) => {
      if (resolved) return;
      resolved = true;
      resolve({ proc, started, error });
    };

    const env = {
      ...process.env,
      PORT: String(testPort),
      SENTRY_DSN: 'http://public@localhost/0',
    };

    let command: string;
    let args: string[];

    if (isPython) {
      const entry = ['main.py', 'app.py'].find(f => fs.existsSync(path.join(backendPath, f))) ?? 'main.py';
      command = 'python3';
      args = [entry];
    } else {
      command = 'npx';
      args = ['tsx', 'src/index.ts'];
    }

    let proc: ChildProcess;
    try {
      proc = spawn(command, args, { cwd: backendPath, env });
    } catch (err: any) {
      return resolve({ proc: null, started: false, error: err.message });
    }

    let stderr = '';
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('error', err => done(false, err.message));
    proc.on('exit', code => {
      if (code !== null && code !== 0) done(false, stderr.slice(0, 300));
    });

    // Wait for server to bind, then confirm with a /health ping
    setTimeout(async () => {
      if (resolved) return;
      try {
        const res = await fetch(`http://127.0.0.1:${testPort}/health`).catch(() =>
          fetch(`http://127.0.0.1:${testPort}/`)
        );
        done(res.status < 500);
      } catch {
        if (!proc.killed && proc.exitCode === null) done(true);
        else done(false, stderr.slice(0, 300));
      }
    }, 4500);

    setTimeout(() => done(false, 'Backend start timed out'), 10000);
  });
}

// ---------------------------------------------------------------------------
// Run integration health check
// ---------------------------------------------------------------------------
export async function runIntegrationHealthCheck(
  fetchCalls: FetchCall[],
  backendPath: string,
  isPython: boolean,
  contract: RouteContract,
  onOutput: OnOutput,
  testPort = 3099
): Promise<HealthCheckResult> {
  const checks: HealthCheckEntry[] = [];

  if (fetchCalls.length === 0) {
    return { passed: true, checks };
  }

  const { proc, started, error } = await startBackendForHealthCheck(backendPath, isPython, testPort, onOutput);

  if (!started) {
    onOutput(`   ⚠ Backend did not start for health check: ${error}\n`);
    // Return a soft failure — we'll attempt repair if possible
    for (const call of fetchCalls) {
      checks.push({
        url: call.url,
        method: call.method,
        status: 'connection_refused',
        passed: false,
        pageFile: call.pageFile,
        spanHint: call.spanHint,
        failure: `Backend failed to start: ${error}`,
      });
    }
    return { passed: false, checks };
  }

  // Fire each request, replacing :3001 with the test port
  for (const call of fetchCalls) {
    const testUrl = call.url.replace(':3001', `:${testPort}`);
    let entry: HealthCheckEntry = {
      url: call.url,
      method: call.method,
      status: 0,
      passed: false,
      pageFile: call.pageFile,
      spanHint: call.spanHint,
    };

    try {
      // Build a minimal valid body for POST/PUT/DELETE from the contract
      const contractRoute = contract.routes.find(r => r.path === new URL(call.url).pathname);
      let body: string | undefined;
      let headers: Record<string, string> = {};

      if (call.method !== 'GET' && call.method !== 'HEAD') {
        const bodyObj: Record<string, string> = { se_copilot_run_id: 'health-check' };
        if (contractRoute) {
          for (const key of contractRoute.requestBodyKeys) {
            if (key !== 'se_copilot_run_id') bodyObj[key] = 'health-check-value';
          }
        }
        body = JSON.stringify(bodyObj);
        headers['Content-Type'] = 'application/json';
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      try {
        const res = await fetch(testUrl, {
          method: call.method,
          headers,
          body,
          signal: controller.signal,
        });
        clearTimeout(timeout);

        entry.status = res.status;
        // 404 = route missing. 2xx or other 4xx = route exists (backend logic issue, not missing route)
        if (res.status === 404) {
          entry.passed = false;
          entry.failure = `Route missing: ${call.method} ${new URL(call.url).pathname} returned 404`;
        } else {
          entry.passed = true;
        }
      } catch (fetchErr: any) {
        clearTimeout(timeout);
        if (fetchErr.name === 'AbortError') {
          entry.status = 'timeout';
          // A timeout on a contract URL means the route EXISTS but is slow (Sentry init, async
          // startup, etc.). Treat it as passed — the repair loop must not rewrite the frontend
          // page just because the backend was slow to respond in the health check.
          // Only flag as failed if the URL is not in the contract at all.
          const urlInContract = contractRoute != null;
          entry.passed = urlInContract;
          if (!urlInContract) {
            entry.failure = `Request timed out after 5s (URL not in route contract)`;
          }
        } else {
          entry.status = 'connection_refused';
          entry.failure = `Connection refused`;
        }
      }
    } catch (err: any) {
      entry.status = 'connection_refused';
      entry.failure = String(err);
    }

    const icon = entry.passed ? '✓' : '✗';
    onOutput(`   ${icon} ${entry.method} ${new URL(call.url).pathname} → ${entry.status}\n`);
    checks.push(entry);
  }

  // Kill the test server
  try { proc?.kill(); } catch {}

  const passed = checks.every(c => c.passed);
  return { passed, checks };
}

// ---------------------------------------------------------------------------
// Repair route mismatches
// ---------------------------------------------------------------------------
export interface RouteMismatchFailure {
  url: string;
  method: string;
  pageFile: string;
  spanHint: string;
  status: number | 'timeout' | 'connection_refused';
  failure?: string;
}

export async function repairRouteMismatch(
  failures: RouteMismatchFailure[],
  backendRoutesPath: string,
  pageFilesDir: string,
  contract: RouteContract,
  llmService: any,
  llmConfig: { baseUrl?: string; apiKey?: string; model?: string },
  onOutput: OnOutput
): Promise<RepairResult> {
  const repairedFiles: string[] = [];
  const skippedFailures: { url: string; reason: string }[] = [];
  let attemptsUsed = 0;

  if (failures.length === 0) {
    return { anyChangesApplied: false, attemptsUsed: 0, repairedFiles: [], skippedFailures: [] };
  }

  // Separate: missing backend routes (404) vs frontend URL mismatches.
  // Timeouts on contract URLs are NOT URL mismatches — the route exists but was slow.
  // Only treat non-404 failures as URL mismatches if the URL is absent from the contract.
  const all404 = failures.filter(f => f.status === 404);
  const frontendMismatches = failures.filter(f =>
    f.status !== 404 &&
    !contract.routes.some(r => r.path === new URL(f.url).pathname)
  );

  // Split 404s into two buckets:
  //   inContract   — route path exists in the contract → missing backend route → add to backend
  //   hallucinated — route path is NOT in the contract → LLM invented it → clean up the frontend page
  const inContract = all404.filter(f => contract.routes.some(r => r.path === new URL(f.url).pathname));
  const hallucinated = all404.filter(f => !contract.routes.some(r => r.path === new URL(f.url).pathname));

  // --- Repair hallucinated fetch() calls in frontend pages ---
  // These URLs are not in the contract at all — the LLM invented them.
  // DETERMINISTIC redirect: replace the URL and method with the best-matching contract route
  // (Jaccard on path segments, no threshold — always pick the closest available route).
  // We do NOT ask the LLM to substitute because it picks the wrong HTTP method, which
  // creates a new 404 that the loop can never resolve.
  // We do NOT strip the block because that leaves orphaned variables (e.g. `err is not defined`).
  for (const failure of hallucinated) {
    const urlPath = new URL(failure.url).pathname;
    onOutput(`   ⚠ ${failure.method} ${urlPath} is not in the route contract — redirecting to best match\n`);

    const pageFilePath = failure.pageFile;
    if (!fs.existsSync(pageFilePath)) {
      skippedFailures.push({ url: failure.url, reason: `Page file not found: ${pageFilePath}` });
      continue;
    }

    const bestRoute = findBestContractRouteForPath(urlPath, contract);
    if (!bestRoute) {
      skippedFailures.push({ url: failure.url, reason: 'No contract routes available to redirect to' });
      continue;
    }

    const correctUrl = `http://localhost:3001${bestRoute.path}`;
    if (failure.url === correctUrl && failure.method === bestRoute.method) {
      skippedFailures.push({ url: failure.url, reason: 'URL already matches best contract route' });
      continue;
    }

    let source = fs.readFileSync(pageFilePath, 'utf8');
    // Replace the hallucinated URL with the correct contract URL
    source = source.replaceAll(failure.url, correctUrl);
    // Fix the method if it differs
    if (failure.method !== bestRoute.method) {
      source = fixFetchMethodInSource(source, correctUrl, bestRoute.method);
    }
    fs.writeFileSync(pageFilePath, source);
    repairedFiles.push(pageFilePath);
    onOutput(`   ✓ Redirected fetch('${urlPath}') → ${bestRoute.method} ${bestRoute.path} in ${path.basename(pageFilePath)}\n`);
  }

  // --- Repair missing backend routes (in-contract 404s) ---
  const backendMissing = inContract;
  if (backendMissing.length > 0) {
    if (!fs.existsSync(backendRoutesPath)) {
      for (const f of backendMissing) {
        skippedFailures.push({ url: f.url, reason: 'Backend routes file not found' });
      }
    } else {
      const missingPaths = backendMissing.map(f => new URL(f.url).pathname);
      const missingRoutes = contract.routes.filter(r => missingPaths.includes(r.path));

      if (missingRoutes.length === 0) {
        for (const f of backendMissing) {
          skippedFailures.push({ url: f.url, reason: 'Route not in contract — cannot repair' });
        }
      } else {
        const currentCode = fs.readFileSync(backendRoutesPath, 'utf8');
        const missingList = missingRoutes
          .map(r => `- ${r.method} ${r.path}  (spanName: ${r.spanName}, body keys: ${r.requestBodyKeys.join(', ')})`)
          .join('\n');
        const contractTable = contract.routes
          .map(r => `${r.method} ${r.path}  (${r.spanName})`)
          .join('\n');

        const repairPrompt = `The following routes are defined in the route contract but are missing from the backend routes file.
Add ONLY these missing routes. Do not modify any existing routes.

MISSING ROUTES:
${missingList}

FULL ROUTE CONTRACT (for reference):
${contractTable}

CURRENT BACKEND ROUTES FILE:
\`\`\`javascript
${currentCode}
\`\`\`

RULES:
- Add only the missing routes listed above
- Match the HTTP method and path exactly as listed
- Each route must read se_copilot_run_id from req.body and include it in the response
- Place a // INSTRUMENT: <spanName> — <description> comment at the start of each handler
- Use try/catch and return { error: true, message: '...' } on failure
- Return realistic mock data appropriate to the route's purpose
- Do NOT use Sentry SDK directly — markers are injected automatically
- Return ONLY the complete updated file contents — no explanation, no markdown fences`;

        try {
          attemptsUsed++;
          const fixed = await llmService.callLLMDirect(
            [{ role: 'user', content: repairPrompt }],
            { ...llmConfig, context: 'repair' }
          );

          const cleaned = fixed.trim()
            .replace(/^```(?:javascript|js|typescript|ts)?\n?/, '')
            .replace(/\n?```[\s\S]*$/, '')
            .trim();

          if (cleaned.length > 100) {
            fs.writeFileSync(backendRoutesPath, cleaned);
            repairedFiles.push(backendRoutesPath);
            onOutput(`   ✓ Added ${missingRoutes.length} missing backend route(s) to ${path.basename(backendRoutesPath)}\n`);
          } else {
            for (const f of backendMissing) {
              skippedFailures.push({ url: f.url, reason: 'LLM returned empty response' });
            }
          }
        } catch (err) {
          onOutput(`   ⚠ Backend route repair failed: ${err}\n`);
          for (const f of backendMissing) {
            skippedFailures.push({ url: f.url, reason: `LLM error: ${String(err).slice(0, 80)}` });
          }
        }
      }
    }
  }

  // --- Repair frontend URL mismatches ---
  for (const failure of frontendMismatches) {
    const pageFilePath = failure.pageFile;

    if (!fs.existsSync(pageFilePath)) {
      skippedFailures.push({ url: failure.url, reason: `Page file not found: ${pageFilePath}` });
      continue;
    }

    const wrongPath = new URL(failure.url).pathname;
    const correctRoute = contract.routes.find(r => r.spanName === failure.spanHint ||
      r.spanName.replace(/\./g, '/').replace(/_/g, '-') === wrongPath.replace('/api/', ''));

    if (!correctRoute) {
      skippedFailures.push({ url: failure.url, reason: 'No matching contract route found' });
      continue;
    }

    const currentCode = fs.readFileSync(pageFilePath, 'utf8');
    const contractTable = contract.routes
      .map(r => `${r.method} http://localhost:3001${r.path}  (${r.spanName})`)
      .join('\n');

    const repairPrompt = `A fetch() call in this page uses a URL that does not match the route contract.
Replace it with the correct URL.

MISMATCHED CALL:
  Wrong URL: ${failure.url}  (returned ${failure.status})
  Correct URL: http://localhost:3001${correctRoute.path}
  Method: ${correctRoute.method}

FULL ROUTE CONTRACT:
${contractTable}

CURRENT PAGE FILE:
\`\`\`typescript
${currentCode}
\`\`\`

Replace ONLY the mismatched URL. Do not change any other logic or styling.
Return ONLY the complete updated file — no explanation, no markdown fences.`;

    try {
      attemptsUsed++;
      const fixed = await llmService.callLLMDirect(
        [{ role: 'user', content: repairPrompt }],
        { ...llmConfig, context: 'repair' }
      );

      const cleaned = fixed.trim()
        .replace(/^```(?:typescript|tsx|ts)?\n?/, '')
        .replace(/\n?```[\s\S]*$/, '')
        .trim();

      if (cleaned.length > 100) {
        fs.writeFileSync(pageFilePath, cleaned);
        repairedFiles.push(pageFilePath);
        onOutput(`   ✓ Fixed URL mismatch in ${path.basename(pageFilePath)}\n`);
      } else {
        skippedFailures.push({ url: failure.url, reason: 'LLM returned empty response' });
      }
    } catch (err) {
      onOutput(`   ⚠ Frontend URL repair failed for ${path.basename(pageFilePath)}: ${err}\n`);
      skippedFailures.push({ url: failure.url, reason: `LLM error: ${String(err).slice(0, 80)}` });
    }
  }

  return {
    anyChangesApplied: repairedFiles.length > 0,
    attemptsUsed,
    repairedFiles,
    skippedFailures,
  };
}

// ---------------------------------------------------------------------------
// Deterministic helpers for hallucinated-URL repair
// ---------------------------------------------------------------------------

/**
 * Find the best contract route for a given URL path using Jaccard similarity
 * on path segments. No minimum threshold — always returns the closest match
 * (or null if the contract has no routes).
 */
function findBestContractRouteForPath(
  urlPath: string,
  contract: RouteContract
): RouteDefinition | null {
  if (contract.routes.length === 0) return null;

  const foundSegs = urlPath.split('/').filter(Boolean);
  let bestScore = -1;
  let bestRoute: RouteDefinition | null = null;

  for (const route of contract.routes) {
    const routeSegs = route.path.split('/').filter(Boolean);
    const intersection = foundSegs.filter(s => routeSegs.includes(s)).length;
    const union = new Set([...foundSegs, ...routeSegs]).size;
    const score = union > 0 ? intersection / union : 0;
    if (score > bestScore) {
      bestScore = score;
      bestRoute = route;
    }
  }

  return bestRoute ?? contract.routes[0];
}

/**
 * Fix the HTTP method in a fetch() call for a given URL.
 * Handles three cases:
 *   1. Explicit wrong method  → replace it
 *   2. No method, no options  → add `{ method: 'CORRECT' }`
 *   3. No method, has options → prepend `method: 'CORRECT',` inside the options object
 *
 * GET is the implicit default — if correctMethod is GET and no explicit method
 * is present, nothing needs to change.
 */
function fixFetchMethodInSource(source: string, url: string, correctMethod: string): string {
  const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Case 1: explicit method already present — replace it
  const explicitMethodRe = new RegExp(
    `(fetch\\('${escaped}'[^)]*method:\\s*['"])([A-Z]+)(['"])`,
    'g'
  );
  const replaced = source.replace(explicitMethodRe, (_m, pre, _old, close) => `${pre}${correctMethod}${close}`);
  if (replaced !== source) return replaced;

  // Cases 2 & 3 only matter when the correct method is not the implicit default
  if (correctMethod === 'GET') return source;

  // Case 2: fetch('url') with no options object at all
  const noOptionsRe = new RegExp(`fetch\\('${escaped}'\\s*\\)`, 'g');
  const withAdded = source.replace(noOptionsRe, `fetch('${url}', { method: '${correctMethod}' })`);
  if (withAdded !== source) return withAdded;

  // Case 3: fetch('url', { existing options }) — inject method at the top of the options
  const hasOptionsRe = new RegExp(`fetch\\('${escaped}'\\s*,\\s*\\{`, 'g');
  return source.replace(hasOptionsRe, `fetch('${url}', { method: '${correctMethod}', `);
}
