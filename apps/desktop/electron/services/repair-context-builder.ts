/**
 * repair-context-builder.ts — Fix 1
 *
 * For each TypeScript error code, defines what cross-file context is needed to
 * fix it. Injected into every LLM repair prompt so the model has ground truth
 * instead of guessing.
 */

import fs from 'fs';
import path from 'path';
import { extractExports } from './instrumentation-injector';
import { buildRepairPreamble } from './sdk-version-guard';

export interface TSError {
  code: string;      // e.g. "TS2304"
  message: string;   // e.g. "Cannot find name 'trace_signup_submit_form'"
  line: number;
  file: string;
}

// Known Next.js / React symbols and their correct import lines
const KNOWN_IMPORTS: Record<string, string> = {
  'Link':             "import Link from 'next/link'",
  'Image':            "import Image from 'next/image'",
  'useRouter':        "import { useRouter } from 'next/navigation'",
  'usePathname':      "import { usePathname } from 'next/navigation'",
  'useSearchParams':  "import { useSearchParams } from 'next/navigation'",
  'useState':         "import { useState } from 'react'",
  'useEffect':        "import { useEffect } from 'react'",
  'useCallback':      "import { useCallback } from 'react'",
  'useRef':           "import { useRef } from 'react'",
  'useMemo':          "import { useMemo } from 'react'",
  'useContext':       "import { useContext } from 'react'",
  'Suspense':         "import { Suspense } from 'react'",
  'Metadata':         "import type { Metadata } from 'next'",
  'NextRequest':      "import type { NextRequest } from 'next/server'",
  'NextResponse':     "import { NextResponse } from 'next/server'",
};

function jaccardTokens(a: string, b: string): number {
  const ta = new Set(a.toLowerCase().split('_').filter(Boolean));
  const tb = new Set(b.toLowerCase().split('_').filter(Boolean));
  const intersection = [...ta].filter(t => tb.has(t)).length;
  const union = new Set([...ta, ...tb]).size;
  return union > 0 ? intersection / union : 0;
}

function findClosestExport(wrongName: string, exports: Map<string, unknown>): string | null {
  let bestScore = 0;
  let bestName: string | null = null;
  for (const name of exports.keys()) {
    const score = jaccardTokens(wrongName, name);
    if (score > bestScore) { bestScore = score; bestName = name; }
  }
  return bestScore >= 0.35 ? bestName : null;
}

function findInstrumentationFile(projectDir: string): string | null {
  const candidates = [
    path.join(projectDir, 'src', 'instrumentation.ts'),
    path.join(projectDir, 'instrumentation.ts'),
    path.join(projectDir, 'lib', 'instrumentation.ts'),
    path.join(projectDir, 'frontend', 'lib', 'instrumentation.ts'),
    path.join(projectDir, 'frontend', 'src', 'lib', 'instrumentation.ts'),
    path.join(projectDir, 'backend', 'src', 'instrumentation.ts'),
  ];
  return candidates.find(p => fs.existsSync(p)) ?? null;
}

/**
 * Build cross-file context for a batch of errors from the same file.
 * Returns a string to prepend to the repair prompt.
 */
export function buildRepairContext(
  errors: TSError[],
  brokenFile: string,
  projectDir?: string
): string {
  if (!projectDir) return '';

  const sections: string[] = [];

  // ── TS2304: Cannot find name ──────────────────────────────────────────────
  const ts2304 = errors.filter(e => e.code === 'TS2304' || e.message.includes('Cannot find name'));

  // Sub-case A: trace_* functions — inject instrumentation exports
  const traceMissing = ts2304
    .map(e => e.message.match(/Cannot find name '(trace_\w+)'/)?.[1])
    .filter((n): n is string => !!n);

  if (traceMissing.length > 0) {
    const instrFile = findInstrumentationFile(projectDir);
    if (instrFile) {
      const exports = extractExports(instrFile);
      const exportList = [...exports.keys()].join('\n  - ');
      const corrections = traceMissing
        .map(wrong => {
          const correct = findClosestExport(wrong, exports);
          return correct
            ? `  '${wrong}' → use '${correct}' instead`
            : `  '${wrong}' → no close match found; check the contract for the correct span name`;
        })
        .join('\n');

      sections.push(`INSTRUMENTATION EXPORTS (all valid trace_* function names):
  - ${exportList}

REQUIRED CORRECTIONS:
${corrections}

RULE: Do not invent function names. Only use names from the list above.
Replace every wrong name with its correct counterpart. Do not change anything else.`);
    }
  }

  // Sub-case B: known Next.js / React symbols
  const symbolMissing = ts2304
    .map(e => e.message.match(/Cannot find name '(\w+)'/)?.[1])
    .filter((n): n is string => !!n && !n.startsWith('trace_'));

  const missingImports = symbolMissing
    .map(sym => KNOWN_IMPORTS[sym])
    .filter((imp): imp is string => !!imp);

  if (missingImports.length > 0) {
    sections.push(`MISSING IMPORTS (add these at the top of the file):
${missingImports.map(i => `  ${i}`).join('\n')}

RULE: Add the import lines above. Do not remove any existing imports.`);
  }

  // ── TS2322 / TS2769: Type mismatch / overload mismatch ───────────────────
  const typeMismatch = errors.some(e =>
    e.code === 'TS2322' || e.code === 'TS2769' ||
    e.message.includes('is not assignable') || e.message.includes('No overload')
  );
  const sentryRelated = errors.some(e =>
    e.message.includes('SpanStatus') || e.message.includes('setHttpStatus') ||
    e.message.includes('startSpan') || e.message.includes('startTransaction')
  );

  if ((typeMismatch || sentryRelated) && projectDir) {
    const sdkNotes = buildRepairPreamble(projectDir);
    if (sdkNotes) sections.push(sdkNotes.trim());
  }

  // ── TS2339: Property does not exist ──────────────────────────────────────
  if (errors.some(e => e.code === 'TS2339' || e.message.includes('does not exist on type'))) {
    sections.push(`PROPERTY DOES NOT EXIST:
Do not add a type assertion (as any) — that hides the error without fixing it.
Options:
  1. Use optional chaining: obj?.property
  2. Remove the property access if it is not needed
  3. Add the property to the object literal being constructed`);
  }

  // ── TS2454: Variable used before being assigned ───────────────────────────
  const unassigned = errors
    .map(e => e.message.match(/Variable '(\w+)' is used before being assigned/)?.[1])
    .filter((n): n is string => !!n);

  if (unassigned.length > 0) {
    sections.push(`VARIABLE USED BEFORE ASSIGNMENT (${unassigned.join(', ')}):
Fix by initialising at declaration: let ${unassigned[0]}: Type = defaultValue
Or use definite assignment if you are certain: let ${unassigned[0]}!: Type
Do not restructure surrounding logic.`);
  }

  return sections.join('\n\n---\n\n');
}
