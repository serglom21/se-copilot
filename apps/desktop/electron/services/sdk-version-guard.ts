/**
 * sdk-version-guard.ts
 *
 * Reads the installed Sentry SDK version from node_modules and injects
 * version-specific API notes into LLM repair prompts. Prevents the repair
 * loop from rewriting instrumentation using the v7 API against a v8+ SDK.
 */

import fs from 'fs';
import path from 'path';

export interface SDKVersionInfo {
  package: string;
  version: string;
  majorVersion: number;
  /** Block of text to prepend to every repair prompt that touches Sentry code. */
  apiNotes: string;
}

/**
 * Read the installed @sentry/node version from node_modules.
 * Falls back to the declared version in package.json if not yet installed.
 */
export function readInstalledSDKVersion(projectDir: string): SDKVersionInfo {
  // Try installed version first
  const nmPkg = path.join(projectDir, 'node_modules', '@sentry', 'node', 'package.json');
  if (fs.existsSync(nmPkg)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(nmPkg, 'utf-8'));
      const version = String(pkg.version ?? '');
      const major = parseInt(version.split('.')[0], 10) || 10;
      return { package: '@sentry/node', version, majorVersion: major, apiNotes: apiNotesFor(major) };
    } catch { /* fall through */ }
  }

  // Fall back to package.json declared version
  const appPkg = path.join(projectDir, 'package.json');
  if (fs.existsSync(appPkg)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(appPkg, 'utf-8'));
      const declared = String(
        pkg.dependencies?.['@sentry/node'] ?? pkg.devDependencies?.['@sentry/node'] ?? ''
      ).replace(/^[^0-9]*/, '');
      const major = parseInt(declared.split('.')[0], 10) || 10;
      return { package: '@sentry/node', version: declared || 'unknown', majorVersion: major, apiNotes: apiNotesFor(major) };
    } catch { /* fall through */ }
  }

  // Safe default — assume v10
  return { package: '@sentry/node', version: 'unknown', majorVersion: 10, apiNotes: apiNotesFor(10) };
}

function apiNotesFor(major: number): string {
  if (major >= 8) {
    return `SENTRY SDK VERSION: @sentry/node v${major}.x is installed (NOT v7).

CORRECT v${major} API — use ONLY these patterns:
  Sentry.startSpan({ name: 'span-name', op: 'http.server' }, async (span) => {
    span.setAttribute('key', 'value');
    // your code here
  });

FORBIDDEN — v7 API (removed in v8, will NOT compile against v${major}):
  ✗ Sentry.startTransaction(...)       — removed in v8
  ✗ span.setHttpStatus(200)            — removed in v8
  ✗ span.setStatus('ok')              — signature changed (use SpanStatus enum or omit)
  ✗ span.description = '...'          — not a writable property in v${major}
  ✗ span.finish()                     — removed in v8
  ✗ new Sentry.Transaction(...)        — removed in v8
  ✗ hub.startTransaction(...)         — removed in v8

If you are unsure of the v${major} API, do NOT rewrite the instrumentation.
Fix only the specific error reported — leave all other Sentry calls untouched.`;
  }

  return `SENTRY SDK VERSION: @sentry/node v${major}.x is installed.`;
}

/**
 * Build the full repair preamble for a given project directory.
 * Returns an empty string if the project dir is not provided.
 */
export function buildRepairPreamble(projectDir?: string): string {
  if (!projectDir) return '';
  try {
    const info = readInstalledSDKVersion(projectDir);
    return `${info.apiNotes}\n\n---\n\n`;
  } catch {
    return '';
  }
}
