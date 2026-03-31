/**
 * route-url-injector.ts
 *
 * Runs immediately after generateWebPages() returns, before any syntax gate.
 * Replaces every fetch() URL in generated frontend source with the exact URL
 * from the route contract. The LLM never needs to get URLs right — they are
 * always overwritten deterministically.
 */

import { RouteContract, RouteDefinition } from './route-contract';

export interface UrlReplacement {
  wrong: string;
  correct: string;
  method: string;
}

export interface InjectionReport {
  filename: string;
  replacements: UrlReplacement[];
}

/**
 * For each file in `generatedFiles`, scan every fetch() call and replace its
 * URL with the canonical URL from the route contract. Also fixes the HTTP
 * method in the fetch options object when it doesn't match the contract.
 *
 * Returns the patched map and a report of what changed.
 */
export function injectContractUrls(
  generatedFiles: Map<string, string>,
  routeContract: RouteContract
): { files: Map<string, string>; reports: InjectionReport[] } {
  const result = new Map<string, string>();
  const reports: InjectionReport[] = [];

  for (const [filename, source] of generatedFiles) {
    const { patched, replacements } = patchFile(source, routeContract);
    result.set(filename, patched);
    if (replacements.length > 0) {
      reports.push({ filename, replacements });
      console.log(`[route-injector] ${filename}: replaced ${replacements.length} URL(s)`);
      for (const r of replacements) {
        console.log(`  ${r.wrong} → ${r.correct} [${r.method}]`);
      }
    }
  }

  return { files: result, reports };
}

function patchFile(
  source: string,
  routeContract: RouteContract
): { patched: string; replacements: UrlReplacement[] } {
  let patched = source;
  const replacements: UrlReplacement[] = [];

  // Match fetch('url'), fetch("url"), fetch(`url`)
  // Captures: quote char, full URL (may have http://host prefix)
  const fetchRe = /fetch\(\s*(['"`])((?:https?:\/\/[^'"`]*)?\/api\/[^'"`]+)\1/g;
  let m: RegExpExecArray | null;

  while ((m = fetchRe.exec(source)) !== null) {
    const quote = m[1];
    const foundUrl = m[2];
    const foundPath = foundUrl.replace(/^https?:\/\/[^/]+/, '');

    const contractRoute = findBestRouteMatch(foundPath, routeContract);
    if (!contractRoute) {
      console.warn(`[route-injector] fetch('${foundPath}') has no match in route contract — leaving as-is`);
      continue;
    }

    const correctUrl = `http://localhost:3001${contractRoute.path}`;
    if (foundUrl === correctUrl) continue;

    // Replace this specific fetch() call — use single quotes for the replacement
    patched = patched.replace(
      `fetch(${quote}${foundUrl}${quote}`,
      `fetch('${correctUrl}'`
    );
    replacements.push({ wrong: foundUrl, correct: correctUrl, method: contractRoute.method });
  }

  // Fix HTTP methods for any URLs we replaced
  for (const { correct, method } of replacements) {
    patched = fixFetchMethod(patched, correct, method);
  }

  return { patched, replacements };
}

function findBestRouteMatch(
  foundPath: string,
  contract: RouteContract
): RouteDefinition | null {
  // 1. Exact match
  const exact = contract.routes.find(r => r.path === foundPath);
  if (exact) return exact;

  // 2. Fuzzy match: Jaccard similarity on path segments
  const foundSegs = foundPath.split('/').filter(Boolean);
  let bestScore = 0;
  let bestRoute: RouteDefinition | null = null;

  for (const route of contract.routes) {
    const routeSegs = route.path.split('/').filter(Boolean);
    const intersection = foundSegs.filter(s => routeSegs.includes(s)).length;
    const union = new Set([...foundSegs, ...routeSegs]).size;
    const score = union > 0 ? intersection / union : 0;
    if (score > bestScore && score >= 0.4) {
      bestScore = score;
      bestRoute = route;
    }
  }

  return bestRoute;
}

function fixFetchMethod(source: string, url: string, correctMethod: string): string {
  // Find: fetch('url', { ..., method: 'WRONG', ... }) and replace method value
  const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const methodRe = new RegExp(
    `(fetch\\('${escaped}'[^)]*method:\\s*['"])([A-Z]+)(['"])`,
    'g'
  );
  return source.replace(methodRe, (_match, pre, foundMethod, close) => {
    if (foundMethod !== correctMethod) {
      console.log(`[route-injector] Fixed method ${foundMethod} → ${correctMethod} for ${url}`);
      return `${pre}${correctMethod}${close}`;
    }
    return _match;
  });
}
