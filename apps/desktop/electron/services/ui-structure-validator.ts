/**
 * ui-structure-validator.ts
 *
 * After each frontend page is written to disk, checks that the source
 * contains the HTML form elements implied by the contract spans associated
 * with that page (via INSTRUMENT markers).
 *
 * If required elements are missing (e.g. a signup page has a submit_form span
 * but no <button> or <input type="submit">), the LLM is asked to add them.
 * This runs BEFORE instrumentation injection so the injector always has a
 * structurally complete page to work with.
 */

import fs from 'fs';
import path from 'path';
import { ContractSpan } from './trace-topology-contract';

export interface UIStructureIssue {
  file: string;
  missing: string[];   // human-readable descriptions of missing elements
}

export interface UIStructureCheckResult {
  issues: UIStructureIssue[];
  clean: boolean;
}

// ---------------------------------------------------------------------------
// Classify what UI elements a span's name/description implies
// ---------------------------------------------------------------------------

interface UIRequirements {
  needsTextInput: boolean;    // at least one <input type="text/email/password/...">
  needsSubmitAction: boolean; // <button type="submit"> or <input type="submit">
  needsForm: boolean;         // wrapping <form> element
}

const INPUT_KEYWORDS   = ['input', 'validate', 'validation', 'field', 'form', 'enter', 'type', 'fill', 'search', 'filter', 'register', 'signup', 'login', 'email', 'password', 'username'];
const SUBMIT_KEYWORDS  = ['submit', 'send', 'create', 'post', 'save', 'confirm', 'checkout', 'purchase', 'complete', 'finish', 'register'];

function requirementsFromSpans(spans: ContractSpan[]): UIRequirements {
  const combined = spans.map(s => `${s.name} ${s.description ?? ''}`.toLowerCase()).join(' ');

  const needsTextInput   = INPUT_KEYWORDS.some(kw => combined.includes(kw));
  const needsSubmitAction = SUBMIT_KEYWORDS.some(kw => combined.includes(kw));
  const needsForm        = needsTextInput && needsSubmitAction;

  return { needsTextInput, needsSubmitAction, needsForm };
}

// ---------------------------------------------------------------------------
// Static checks on source text
// ---------------------------------------------------------------------------

function hasTextInput(source: string): boolean {
  // <input (no type OR type="text/email/password/number/tel/search")
  return /<input[\s\S]{0,200}type\s*=\s*["'](text|email|password|number|tel|search|date|url)["']/i.test(source)
    || /<input(?!\s[^>]*type\s*=\s*["'](checkbox|radio|submit|button|hidden|file|range)["'])[^>]*>/i.test(source)
    || /<textarea[\s\S]{0,50}>/i.test(source);
}

function hasSubmitAction(source: string): boolean {
  return /<button[^>]*type\s*=\s*["']submit["'][^>]*>/i.test(source)
    || /<input[^>]*type\s*=\s*["']submit["'][^>]*>/i.test(source)
    // Also accept a plain <button> inside a <form> — it submits by default
    || (/<form[\s\S]{0,2000}<button(?!\s[^>]*type\s*=\s*["'](button|reset)["'])[^>]*>/i.test(source));
}

function hasFormElement(source: string): boolean {
  return /<form[\s\s]{0,10}[\s>]/i.test(source) || /<form>/i.test(source);
}

// ---------------------------------------------------------------------------
// Per-page check
// ---------------------------------------------------------------------------

/**
 * Read the markers in a page file and return the span names referenced.
 */
function extractMarkerSpanNames(source: string): string[] {
  const re = /\/\/\s*INSTRUMENT:\s*([^\s—–\-][^\n—–]*)/g;
  const names: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const name = m[1].trim().replace(/\s*[—–\-\s].*$/, '').trim();
    if (name) names.push(name);
  }
  return names;
}

/**
 * Check a single page file against the spans it references.
 * Returns a list of human-readable missing-element descriptions.
 */
export function checkPageUIStructure(
  filePath: string,
  allContractSpans: ContractSpan[]
): string[] {
  if (!fs.existsSync(filePath)) return [];

  const source = fs.readFileSync(filePath, 'utf-8');
  const markerNames = extractMarkerSpanNames(source);

  // Find the contract spans referenced by this page's markers
  const relevantSpans = allContractSpans.filter(s => markerNames.includes(s.name));
  if (relevantSpans.length === 0) return []; // no contract spans → no requirements

  const req = requirementsFromSpans(relevantSpans);
  const missing: string[] = [];

  if (req.needsTextInput && !hasTextInput(source)) {
    missing.push('text input field (<input type="text/email/password"> or <textarea>)');
  }
  if (req.needsSubmitAction && !hasSubmitAction(source)) {
    missing.push('submit action (<button type="submit"> or <input type="submit">)');
  }
  if (req.needsForm && !hasFormElement(source)) {
    missing.push('form wrapper (<form> element)');
  }

  return missing;
}

/**
 * Check all page files in the array. Returns a structured result.
 */
export function checkAllPagesUIStructure(
  pagePaths: string[],
  allContractSpans: ContractSpan[]
): UIStructureCheckResult {
  const issues: UIStructureIssue[] = [];

  for (const filePath of pagePaths) {
    const missing = checkPageUIStructure(filePath, allContractSpans);
    if (missing.length > 0) {
      issues.push({ file: filePath, missing });
    }
  }

  return { issues, clean: issues.length === 0 };
}

// ---------------------------------------------------------------------------
// LLM repair prompt builder
// ---------------------------------------------------------------------------

/**
 * Build the repair prompt for a page that is missing required UI elements.
 */
export function buildUIRepairPrompt(
  source: string,
  filename: string,
  missing: string[],
  relevantSpans: ContractSpan[]
): string {
  const spanSummary = relevantSpans.map(s => `  - ${s.name}: ${s.description ?? ''}`).join('\n');

  return `This Next.js page is missing required HTML form elements. Add the missing elements so the page is functional.

FILE: ${filename}

MISSING ELEMENTS (add these):
${missing.map(m => `  - ${m}`).join('\n')}

SPANS THIS PAGE INSTRUMENTS (use these to understand what the form should do):
${spanSummary}

RULES:
- Add the missing elements at an appropriate position in the JSX
- Use Tailwind CSS classes matching the existing style of the page
- Add data-testid attributes to all new inputs, buttons, and forms
  Examples: data-testid="email-input", data-testid="submit-button", data-testid="signup-form"
- Wire inputs to React state (useState) — add state if not already present
- The form should call the existing fetch() or handler function on submit — do not add new fetch calls
- Do NOT change span markers (// INSTRUMENT:), instrumentation imports, or Sentry calls
- Do NOT remove any existing elements
- Return ONLY the complete updated file — no explanation, no markdown fences

CURRENT FILE:
${source}`;
}
