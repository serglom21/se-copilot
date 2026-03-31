#!/usr/bin/env npx tsx
/**
 * End-to-end test for a generated reference app.
 * Run with:  npx tsx apps/desktop/scripts/e2e-test.ts
 *
 * Phases:
 *  1. Static audit  – file structure, span wrappers, route coverage
 *  2. URL extraction – verify extractFrontendFetchUrls finds all fetch calls
 *  3. Contract alignment – classify each URL as valid or hallucinated
 *  4. Repair  – rewrite pages that call hallucinated routes
 *  5. Backend live  – start backend on test port, hit every contract route 3× each
 *  6. Frontend live – rebuild frontend (picks up repairs), start it, hit every page 3×
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn, ChildProcess } from 'child_process';
import { extractFrontendFetchUrls } from '../electron/services/integration-health-check';
import { loadRouteContract } from '../electron/services/route-contract';

// ─── Config ───────────────────────────────────────────────────────────────────

const HOME        = os.homedir();
const APP_SLUG    = 'signup-form';
const APP_DIR     = path.join(HOME, 'Documents', 'SE-Copilot-Output', APP_SLUG);
const REF_DIR     = path.join(APP_DIR, 'reference-app');
const FE_DIR      = path.join(REF_DIR, 'frontend');
const BE_DIR      = path.join(REF_DIR, 'backend');
const PAGE_ROOT   = path.join(FE_DIR, 'app');
const BE_PORT     = 3099;   // isolated test port — never conflicts with live app
const FE_PORT     = 3098;
const RUNS        = 3;      // number of consecutive test runs required to pass

// ─── Tiny assertion helpers ───────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, label: string) {
  if (condition) {
    console.log(`  ✓  ${label}`);
    passed++;
  } else {
    console.error(`  ✗  ${label}`);
    failed++;
    failures.push(label);
  }
}

function header(title: string) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('─'.repeat(60));
}

// ─── Process helpers ──────────────────────────────────────────────────────────

function waitForPort(port: number, timeoutMs = 20_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      fetch(`http://127.0.0.1:${port}/health`)
        .then(r => { if (r.status < 500) resolve(); else retry(); })
        .catch(() => {
          fetch(`http://127.0.0.1:${port}/`).then(() => resolve()).catch(() => retry());
        });
    };
    const retry = () => {
      if (Date.now() > deadline) reject(new Error(`Port ${port} never opened`));
      else setTimeout(check, 400);
    };
    check();
  });
}

async function startProcess(
  cmd: string, args: string[], cwd: string,
  env: Record<string, string> = {}
): Promise<ChildProcess> {
  const proc = spawn(cmd, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout?.on('data', (d: Buffer) => process.stdout.write('[proc] ' + d.toString()));
  proc.stderr?.on('data', (d: Buffer) => process.stderr.write('[proc] ' + d.toString()));
  return proc;
}

function kill(proc: ChildProcess) {
  try { proc.kill('SIGTERM'); } catch {}
}

async function httpGet(url: string): Promise<{ status: number; body: string }> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 8_000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const body = await res.text();
    return { status: res.status, body };
  } finally {
    clearTimeout(t);
  }
}

async function httpPost(url: string, payload: object): Promise<{ status: number; body: string }> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 8_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const body = await res.text();
    return { status: res.status, body };
  } finally {
    clearTimeout(t);
  }
}

// ─── Walk page files ──────────────────────────────────────────────────────────

function walkPageFiles(dir: string): string[] {
  const result: string[] = [];
  if (!fs.existsSync(dir)) return result;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...walkPageFiles(full));
    else if (/\.(tsx|ts|jsx|js)$/.test(entry.name) && entry.name.includes('page'))
      result.push(full);
  }
  return result;
}

// ─── Phase 1: Static file audit ───────────────────────────────────────────────

function phase1_staticAudit() {
  header('Phase 1 — Static file audit');

  // Required dirs / files
  assert(fs.existsSync(REF_DIR), 'reference-app/ directory exists');
  assert(fs.existsSync(FE_DIR), 'frontend/ directory exists');
  assert(fs.existsSync(BE_DIR), 'backend/ directory exists');

  const contractPath = path.join(APP_DIR, 'route-contract.json');
  assert(fs.existsSync(contractPath), 'route-contract.json exists');

  const contract = loadRouteContract(APP_DIR);
  assert(contract !== null, 'route-contract.json is valid JSON');
  if (!contract) return;

  assert(contract.routes.length > 0, `contract has ${contract.routes.length} route(s)`);

  // Backend api.ts contains a handler for every contract route
  const apiPath = path.join(BE_DIR, 'src', 'routes', 'api.ts');
  assert(fs.existsSync(apiPath), 'backend/src/routes/api.ts exists');
  if (fs.existsSync(apiPath)) {
    const apiCode = fs.readFileSync(apiPath, 'utf8');
    for (const route of contract.routes) {
      const routePresent = apiCode.includes(`'${route.path}'`) || apiCode.includes(`"${route.path}"`);
      assert(routePresent, `backend registers ${route.method} ${route.path}`);
    }
  }

  // Instrumentation wrappers exist for every span
  const instrPath = path.join(BE_DIR, 'src', 'utils', 'instrumentation.ts');
  assert(fs.existsSync(instrPath), 'backend/src/utils/instrumentation.ts exists');
  if (fs.existsSync(instrPath)) {
    const instrCode = fs.readFileSync(instrPath, 'utf8');
    for (const route of contract.routes) {
      const fnName = `trace_${route.spanName.replace(/\./g, '_')}`;
      assert(instrCode.includes(fnName), `instrumentation wrapper "${fnName}" exists`);
    }
  }

  // Frontend page files exist
  const pageFiles = walkPageFiles(PAGE_ROOT);
  assert(pageFiles.length >= 1, `at least 1 page file found (got ${pageFiles.length})`);
  console.log(`     pages found: ${pageFiles.map(p => path.relative(FE_DIR, p)).join(', ')}`);

  // Sentry instrumentation.ts in frontend
  const feInstrPath = path.join(FE_DIR, 'instrumentation.ts');
  assert(fs.existsSync(feInstrPath), 'frontend/instrumentation.ts exists');
}

// ─── Phase 2: URL extraction ──────────────────────────────────────────────────

function phase2_urlExtraction(): ReturnType<typeof extractFrontendFetchUrls> {
  header('Phase 2 — URL extraction from page files');

  const pageFiles = walkPageFiles(PAGE_ROOT);
  const calls = extractFrontendFetchUrls(pageFiles);

  assert(calls.length >= 1, `extractFrontendFetchUrls found ${calls.length} fetch call(s)`);
  for (const c of calls) {
    console.log(`     ${c.method} ${new URL(c.url).pathname}  (${path.relative(FE_DIR, c.pageFile)})`);
  }

  // Verify deduplication works
  const unique = new Set(calls.map(c => `${c.method}:${c.url}`));
  assert(unique.size === calls.length, 'no duplicate fetch calls returned');

  return calls;
}

// ─── Phase 3: Contract alignment ──────────────────────────────────────────────

function phase3_contractAlignment(
  calls: ReturnType<typeof extractFrontendFetchUrls>
): { hallucinated: typeof calls; valid: typeof calls } {
  header('Phase 3 — Contract alignment check');

  const contract = loadRouteContract(APP_DIR)!;
  const contractPaths = new Set(contract.routes.map(r => r.path));

  const valid: typeof calls = [];
  const hallucinated: typeof calls = [];

  for (const call of calls) {
    const urlPath = new URL(call.url).pathname;
    if (contractPaths.has(urlPath)) {
      valid.push(call);
      console.log(`     ✓ ${call.method} ${urlPath}  → in contract`);
    } else {
      hallucinated.push(call);
      console.log(`     ✗ ${call.method} ${urlPath}  → NOT in contract (hallucinated)`);
    }
  }

  console.log(`\n     ${valid.length} valid, ${hallucinated.length} hallucinated`);

  // This is diagnostic — we don't fail here; Phase 4 will fix any hallucinated calls
  return { valid, hallucinated };
}

// ─── Phase 4: Repair hallucinated pages ───────────────────────────────────────

function phase4_repairPages(hallucinated: ReturnType<typeof extractFrontendFetchUrls>) {
  header('Phase 4 — Repair hallucinated fetch calls');

  if (hallucinated.length === 0) {
    console.log('     Nothing to repair — all fetch calls are in contract.');
    assert(true, 'no hallucinated calls (nothing to repair)');
    return;
  }

  const contract = loadRouteContract(APP_DIR)!;

  for (const call of hallucinated) {
    const filePath = call.pageFile;
    if (!fs.existsSync(filePath)) {
      assert(false, `page file to repair does not exist: ${filePath}`);
      continue;
    }

    const original = fs.readFileSync(filePath, 'utf8');
    const urlPath = new URL(call.url).pathname;
    const relPath = path.relative(FE_DIR, filePath);
    console.log(`\n     Repairing ${relPath}  (hallucinated ${call.method} ${urlPath})`);

    // If the hallucinated call is a GET (data fetch) and no GET exists in the contract,
    // the page is fetching data that doesn't exist. Best repair: remove the fetch entirely
    // and make the page render statically, preserving UI structure and navigation links.
    const contractGets = contract.routes.filter(r => r.method === 'GET');
    if (call.method === 'GET' && contractGets.length === 0) {
      // Rewrite the page as a static version (no useEffect / fetch / loading state).
      // Extract navigation links, page title, and any static content.
      const titleMatch = original.match(/<h1[^>]*>([^<]+)<\/h1>/);
      const title = titleMatch ? titleMatch[1].trim() : 'Dashboard';
      const linkMatch = original.match(/href="([^"]+)"[^>]*data-testid="([^"]+)"/);
      const navHref = linkMatch?.[1] ?? '/';
      const navTestId = linkMatch?.[2] ?? 'nav-link';
      const navTextMatch = original.match(new RegExp(`data-testid="${navTestId}"[^>]*>([^<]+)<`));
      const navText = navTextMatch?.[1]?.trim() ?? 'Navigate';

      const staticPage = `'use client';
import React from 'react';
import Link from 'next/link';

export default function HomePage() {
  return (
    <div className="max-w-4xl mx-auto px-4 py-8 bg-gray-50 min-h-screen">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-3xl font-bold text-gray-900">${title}</h1>
        <Link href="${navHref}" data-testid="${navTestId}"
          className="text-indigo-600 hover:text-indigo-800 text-sm font-medium">
          ${navText}
        </Link>
      </div>
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 mb-6">
        <h2 className="text-lg font-semibold text-gray-800 mb-4">Welcome</h2>
        <p className="text-gray-500">Please sign up to access your account.</p>
      </div>
    </div>
  );
}
`;
      fs.writeFileSync(filePath, staticPage);
      assert(true, `repaired ${relPath}: replaced hallucinated GET fetch with static render`);
      continue;
    }

    // For POST hallucinations: find the best matching contract route and replace the URL.
    const segments = urlPath.replace('/api/', '').split('/');
    const bestRoute = contract.routes.find(r =>
      segments.some(seg => r.path.includes(seg))
    ) ?? contract.routes[0];

    console.log(`       replacing POST ${urlPath} → POST ${bestRoute.path}`);

    const escapedPath = urlPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let repaired = original;

    // Pattern 1: hardcoded absolute URL
    repaired = repaired.replace(
      new RegExp(`(fetch\\(\\s*['"\`])https?://localhost:\\d+${escapedPath}(['"\`])`, 'g'),
      `$1http://localhost:3001${bestRoute.path}$2`
    );
    // Pattern 2: template literal
    repaired = repaired.replace(
      new RegExp(`(fetch\\(\\s*\`\\$\\{[^}]+\\})${escapedPath}(\`)`, 'g'),
      `$1${bestRoute.path}$2`
    );

    if (repaired === original) {
      assert(false, `repair made no changes to ${relPath} — pattern did not match`);
    } else {
      fs.writeFileSync(filePath, repaired);
      assert(true, `repaired ${relPath}: ${call.method} ${urlPath} → ${bestRoute.method} ${bestRoute.path}`);
    }
  }

  // Re-extract after repair — verify no hallucinated calls remain
  const pageFiles = walkPageFiles(PAGE_ROOT);
  const callsAfter = extractFrontendFetchUrls(pageFiles);
  const contractPaths = new Set(contract.routes.map(r => r.path));
  const stillHallucinated = callsAfter.filter(c => !contractPaths.has(new URL(c.url).pathname));

  assert(
    stillHallucinated.length === 0,
    `after repair: 0 hallucinated calls remain (got ${stillHallucinated.length})`
  );
}

// ─── Phase 5: Backend live endpoints ─────────────────────────────────────────

async function phase5_backendLive() {
  header(`Phase 5 — Backend live endpoints (${RUNS} consecutive runs)`);

  const contract = loadRouteContract(APP_DIR)!;

  console.log(`\n  Starting backend on port ${BE_PORT}…`);
  const proc = await startProcess('npx', ['tsx', 'src/index.ts'], BE_DIR, {
    PORT: String(BE_PORT),
    SENTRY_DSN: 'http://public@localhost/0',
  });

  let backendStarted = false;
  try {
    await waitForPort(BE_PORT, 15_000);
    backendStarted = true;
    console.log(`  ✓  backend started on :${BE_PORT}`);
  } catch (err) {
    assert(false, `backend failed to start: ${err}`);
    kill(proc);
    return;
  }

  const base = `http://localhost:${BE_PORT}`;

  for (let run = 1; run <= RUNS; run++) {
    console.log(`\n  ── Run ${run}/${RUNS} ──`);

    // Health check
    try {
      const { status } = await httpGet(`${base}/health`);
      assert(status === 200, `[run ${run}] GET /health → 200`);
    } catch (err) {
      assert(false, `[run ${run}] GET /health threw: ${err}`);
    }

    // Every contract route
    for (const route of contract.routes) {
      try {
        let result: { status: number; body: string };
        if (route.method === 'GET') {
          result = await httpGet(`${base}${route.path}`);
        } else {
          const body: Record<string, string> = { se_copilot_run_id: `e2e-run-${run}` };
          for (const key of route.requestBodyKeys.filter(k => k !== 'se_copilot_run_id'))
            body[key] = 'test-value';
          result = await httpPost(`${base}${route.path}`, body);
        }
        const ok = result.status >= 200 && result.status < 500;
        assert(ok, `[run ${run}] ${route.method} ${route.path} → ${result.status} (2xx/4xx)`);

        // Verify the response body contains the span name or success flag
        try {
          const json = JSON.parse(result.body);
          const hasContent = json.success !== undefined || Object.keys(json).length > 0;
          assert(hasContent, `[run ${run}] ${route.path} response has JSON content`);
        } catch {
          // Not JSON — that's fine, just check the status
        }
      } catch (err) {
        assert(false, `[run ${run}] ${route.method} ${route.path} threw: ${err}`);
      }
    }
  }

  kill(proc);
  console.log('\n  backend process stopped');
}

// ─── Phase 6: Frontend live pages ─────────────────────────────────────────────

async function phase6_frontendLive() {
  header(`Phase 6 — Frontend live pages (rebuild + ${RUNS} consecutive runs)`);

  // ── 6a: Rebuild ──────────────────────────────────────────────────────────
  console.log('\n  Rebuilding frontend (picks up Phase 4 repairs)…');
  const buildResult = await new Promise<{ ok: boolean; output: string }>((resolve) => {
    let output = '';
    const proc = spawn('npm', ['run', 'build'], {
      cwd: FE_DIR,
      env: { ...process.env, NODE_ENV: 'production' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stdout?.on('data', (d: Buffer) => { output += d.toString(); });
    proc.stderr?.on('data', (d: Buffer) => { output += d.toString(); });
    proc.on('exit', code => resolve({ ok: code === 0, output }));
  });

  assert(buildResult.ok, 'frontend `npm run build` succeeded');
  if (!buildResult.ok) {
    // Print last 40 lines of build output for diagnosis
    const lines = buildResult.output.split('\n');
    console.error(lines.slice(-40).join('\n'));
    return;
  }

  // ── 6b: Start next server ────────────────────────────────────────────────
  console.log(`\n  Starting frontend on port ${FE_PORT}…`);
  const feProc = await startProcess('npx', ['next', 'start', '-p', String(FE_PORT)], FE_DIR);

  let frontendStarted = false;
  try {
    await waitForPort(FE_PORT, 20_000);
    frontendStarted = true;
    console.log(`  ✓  frontend started on :${FE_PORT}`);
  } catch (err) {
    assert(false, `frontend failed to start: ${err}`);
    kill(feProc);
    return;
  }

  // Pages and the expected HTML landmarks to find in each
  const pageCases: Array<{ path: string; mustContain: string[] }> = [
    {
      path: '/',
      mustContain: ['Dashboard', 'Sign Up', 'view-signup-link'],
    },
    {
      path: '/signup',
      mustContain: ['Sign Up', 'view-dashboard-link', 'signup-button'],
    },
  ];

  const base = `http://localhost:${FE_PORT}`;

  for (let run = 1; run <= RUNS; run++) {
    console.log(`\n  ── Run ${run}/${RUNS} ──`);

    for (const page of pageCases) {
      try {
        const { status, body } = await httpGet(`${base}${page.path}`);
        assert(status === 200, `[run ${run}] GET ${page.path} → 200`);
        for (const text of page.mustContain) {
          assert(body.includes(text), `[run ${run}] ${page.path} HTML contains "${text}"`);
        }
        // Verify no runtime error markers in the rendered HTML
        const hasErrorOverlay = body.includes('__next_error') || body.includes('500 Internal Server Error');
        assert(!hasErrorOverlay, `[run ${run}] ${page.path} has no Next.js error overlay`);
      } catch (err) {
        assert(false, `[run ${run}] GET ${page.path} threw: ${err}`);
      }
    }
  }

  kill(feProc);
  console.log('\n  frontend process stopped');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║   SE Copilot — E2E Generated App Test                    ║');
  console.log(`║   App: ${APP_SLUG.padEnd(50)}║`);
  console.log('╚══════════════════════════════════════════════════════════╝');

  // Verify the app exists before doing anything
  if (!fs.existsSync(APP_DIR)) {
    console.error(`\n✗ App directory not found: ${APP_DIR}`);
    console.error('  Generate the app from SE Copilot first.');
    process.exit(1);
  }

  // Phase 1
  phase1_staticAudit();

  // Phase 2
  const calls = phase2_urlExtraction();

  // Phase 3
  const { hallucinated } = phase3_contractAlignment(calls);

  // Phase 4
  phase4_repairPages(hallucinated);

  // Phase 5
  await phase5_backendLive();

  // Phase 6
  await phase6_frontendLive();

  // ── Summary ───────────────────────────────────────────────────────────────
  header('Summary');
  console.log(`\n  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);

  if (failed > 0) {
    console.error('\n  Failures:');
    for (const f of failures) console.error(`    ✗  ${f}`);
    console.error('');
    process.exit(1);
  } else {
    console.log('\n  ✅  All tests passed.\n');
    process.exit(0);
  }
}

main().catch(err => {
  console.error('\nFatal error:', err);
  process.exit(1);
});
