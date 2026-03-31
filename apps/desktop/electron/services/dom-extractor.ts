import fs from 'fs';
import path from 'path';

export interface Selector {
  testId: string;
  elementType: 'button' | 'input' | 'select' | 'textarea' | 'a' | 'form' | 'other';
  inferredAction: 'click' | 'type' | 'select' | 'submit' | 'navigate';
  pageFile: string;
}

export interface Endpoint {
  method: string;
  path: string;
  pageFile: string;
}

export interface DOMManifest {
  pages: Array<{
    pageFile: string;
    selectors: Selector[];
    apiEndpoints: Endpoint[];
  }>;
}

// ---------------------------------------------------------------------------
// Selector extraction helpers
// ---------------------------------------------------------------------------

type ElementType = Selector['elementType'];
type InferredAction = Selector['inferredAction'];

/**
 * Look backwards from `charIndex` in `content` to find the nearest opening
 * JSX tag name (e.g. "button", "input", "a", etc.).
 */
function inferElementTypeFromContext(content: string, charIndex: number): ElementType {
  // Walk backwards from the attribute position to find the nearest '<tagName'
  const before = content.slice(0, charIndex);

  // Find the last '<' that starts a tag (not a closing tag '</')
  const tagMatch = /<([a-zA-Z][a-zA-Z0-9]*)(?:\s[^>]*)?$/.exec(before);
  if (!tagMatch) return 'other';

  const tag = tagMatch[1].toLowerCase();
  switch (tag) {
    case 'button': return 'button';
    case 'input':  return 'input';
    case 'select': return 'select';
    case 'textarea': return 'textarea';
    case 'a':      return 'a';
    case 'form':   return 'form';
    default:       return 'other';
  }
}

/**
 * For `<input>` elements, look at the `type` attribute in the surrounding tag
 * to decide whether the action is "type" or "click".
 */
function inferInputAction(content: string, charIndex: number): InferredAction {
  // Find the surrounding tag text
  const before = content.slice(0, charIndex);
  const tagStart = before.lastIndexOf('<');
  if (tagStart === -1) return 'type';

  // Find the end of the tag (could be on following lines)
  const tagContent = content.slice(tagStart, charIndex + 300);
  const typeMatch = /\btype\s*=\s*["']([^"']*)["']/.exec(tagContent);
  if (!typeMatch) return 'type'; // default

  switch (typeMatch[1].toLowerCase()) {
    case 'submit':
    case 'button':
    case 'checkbox':
    case 'radio':
      return 'click';
    default:
      return 'type';
  }
}

function inferAction(elementType: ElementType, content: string, charIndex: number): InferredAction {
  switch (elementType) {
    case 'button':   return 'click';
    case 'input':    return inferInputAction(content, charIndex);
    case 'select':   return 'select';
    case 'form':     return 'submit';
    case 'a':        return 'navigate';
    case 'textarea': return 'type';
    default:         return 'click';
  }
}

/**
 * Extract all data-testid selectors from a page file's source text.
 */
function extractSelectors(content: string, pageFile: string): Selector[] {
  const selectors: Selector[] = [];

  // Match data-testid="value" or data-testid={'value'} or data-testid={"value"}
  const testIdRe = /data-testid\s*=\s*(?:"([^"]+)"|'([^']+)'|\{['"]([^'"]+)['"]\})/g;
  let m: RegExpExecArray | null;

  while ((m = testIdRe.exec(content)) !== null) {
    const testId = m[1] ?? m[2] ?? m[3];
    if (!testId) continue;

    const charIndex = m.index;
    const elementType = inferElementTypeFromContext(content, charIndex);
    const inferredAction = inferAction(elementType, content, charIndex);

    selectors.push({ testId, elementType, inferredAction, pageFile });
  }

  return selectors;
}

// ---------------------------------------------------------------------------
// API endpoint extraction helpers
// ---------------------------------------------------------------------------

/**
 * Strip a localhost origin prefix so we are left with just the path.
 * e.g. "http://localhost:3001/api/users" → "/api/users"
 */
function stripOrigin(url: string): string {
  return url.replace(/^https?:\/\/[^/]+/, '');
}

/**
 * Extract the first string argument from a function call, starting right after
 * the opening parenthesis at `parenIndex`.
 */
function extractFirstStringArg(content: string, parenIndex: number): string | null {
  const window = content.slice(parenIndex, parenIndex + 512);
  const m = /^\s*["'`]([^"'`\n]+)["'`]/.exec(window);
  return m ? m[1] : null;
}

/**
 * Find the `method:` option inside a fetch() call's second argument.
 * Looks in a ~300-char window after the URL argument.
 */
function inferFetchMethod(content: string, callIndex: number): string {
  const window = content.slice(callIndex, callIndex + 600);
  const methodMatch = /method\s*:\s*["']([A-Z]+)["']/i.exec(window);
  return methodMatch ? methodMatch[1].toUpperCase() : 'GET';
}

/**
 * Extract all API endpoints from a page file's source text.
 * Only keeps paths that start with /api/ or are relative API paths.
 */
function extractEndpoints(content: string, pageFile: string): Endpoint[] {
  const endpoints: Endpoint[] = [];

  // ── fetch( calls ─────────────────────────────────────────────────────────
  const fetchRe = /\bfetch\s*\(/g;
  let m: RegExpExecArray | null;

  while ((m = fetchRe.exec(content)) !== null) {
    const afterParen = m.index + m[0].length;
    const url = extractFirstStringArg(content, afterParen);
    if (!url) continue;

    const cleanPath = stripOrigin(url);
    if (!cleanPath.startsWith('/')) continue; // skip non-path strings

    const method = inferFetchMethod(content, m.index);
    endpoints.push({ method, path: cleanPath, pageFile });
  }

  // ── axios.<method>( calls ─────────────────────────────────────────────────
  const axiosRe = /\baxios\.(get|post|put|delete|patch)\s*\(/gi;
  while ((m = axiosRe.exec(content)) !== null) {
    const httpMethod = m[1].toUpperCase();
    const afterParen = m.index + m[0].length;
    const url = extractFirstStringArg(content, afterParen);
    if (!url) continue;

    const cleanPath = stripOrigin(url);
    if (!cleanPath.startsWith('/')) continue;

    endpoints.push({ method: httpMethod, path: cleanPath, pageFile });
  }

  // Deduplicate by method + path
  const seen = new Set<string>();
  return endpoints.filter(ep => {
    const key = `${ep.method}:${ep.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scan an array of page file paths, extract selectors and API endpoints from
 * each, write `<projectDir>/dom-manifest.json` as a side effect, and return
 * the full DOMManifest.
 */
export function extractDOMManifest(pageFiles: string[], projectDir: string): DOMManifest {
  const pages: DOMManifest['pages'] = [];

  for (const pageFile of pageFiles) {
    if (!fs.existsSync(pageFile)) {
      console.warn(`[dom-extractor] File not found, skipping: ${pageFile}`);
      continue;
    }

    const content = fs.readFileSync(pageFile, 'utf-8');
    const selectors = extractSelectors(content, pageFile);
    const apiEndpoints = extractEndpoints(content, pageFile);

    pages.push({ pageFile, selectors, apiEndpoints });
  }

  const manifest: DOMManifest = { pages };

  const manifestPath = path.join(projectDir, 'dom-manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
  console.log(`[dom-extractor] Manifest written to ${manifestPath}`);

  return manifest;
}

/**
 * Read `<projectDir>/dom-manifest.json` if it exists; return null otherwise.
 */
export function loadDOMManifest(projectDir: string): DOMManifest | null {
  const manifestPath = path.join(projectDir, 'dom-manifest.json');
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const raw = fs.readFileSync(manifestPath, 'utf-8');
    return JSON.parse(raw) as DOMManifest;
  } catch (err) {
    console.error(`[dom-extractor] Failed to read manifest at ${manifestPath}:`, err);
    return null;
  }
}
