/**
 * span-name-normaliser.ts
 *
 * Corrects paraphrased span names in generated source files before the static
 * validator runs. Uses Jaccard similarity on dot/underscore tokens so that
 * "signup.user_input_validation" → "signup.validate_user_input" when the
 * contract name is the latter and similarity ≥ 0.6.
 *
 * Runs after injectContractUrls(), before injectInstrumentation().
 */

import fs from 'fs';
import { TraceTopologyContract } from './trace-topology-contract';

export interface SpanNameCorrection {
  file: string;
  wrong: string;
  correct: string;
  similarity: number;
}

/**
 * Scan every `// INSTRUMENT: <name>` marker in each file.
 * If the name is not an exact contract span, find the closest contract span
 * by Jaccard token similarity. Correct it if similarity ≥ 0.6.
 *
 * Returns a list of corrections applied across all files.
 */
export function normaliseSpanNames(
  filePaths: string[],
  contract: TraceTopologyContract
): SpanNameCorrection[] {
  const contractNames = contract.spans.map(s => s.name);
  const allCorrections: SpanNameCorrection[] = [];

  for (const filePath of filePaths) {
    if (!fs.existsSync(filePath)) continue;

    let source = fs.readFileSync(filePath, 'utf-8');
    const corrections = correctFile(source, contractNames, filePath);

    if (corrections.length > 0) {
      // Apply all corrections to the file content
      for (const c of corrections) {
        // Replace all occurrences of the wrong name (in markers and elsewhere)
        source = source.replaceAll(c.wrong, c.correct);
        console.log(
          `[span-normaliser] ${filePath}: '${c.wrong}' → '${c.correct}' ` +
          `(similarity: ${Math.round(c.similarity * 100)}%)`
        );
      }
      fs.writeFileSync(filePath, source, 'utf-8');
      allCorrections.push(...corrections);
    }
  }

  return allCorrections;
}

function correctFile(
  source: string,
  contractNames: string[],
  filePath: string
): SpanNameCorrection[] {
  const corrections: SpanNameCorrection[] = [];
  const seen = new Set<string>(); // avoid correcting the same wrong name twice

  const markerRe = /\/\/\s*INSTRUMENT:\s*([^\s—–\-][^\n—–]*)/g;
  let m: RegExpExecArray | null;

  while ((m = markerRe.exec(source)) !== null) {
    const raw = m[1].trim().replace(/\s*[—–\-\s].*$/, '').trim();
    if (contractNames.includes(raw) || seen.has(raw)) continue;

    const closest = findClosestSpanName(raw, contractNames);
    if (closest === null) continue;

    const score = jaccard(raw, closest);
    if (score >= 0.6) {
      corrections.push({ file: filePath, wrong: raw, correct: closest, similarity: score });
      seen.add(raw);
    }
  }

  return corrections;
}

function findClosestSpanName(name: string, contractNames: string[]): string | null {
  let bestScore = 0;
  let bestName: string | null = null;

  for (const cn of contractNames) {
    const score = jaccard(name, cn);
    if (score > bestScore) {
      bestScore = score;
      bestName = cn;
    }
  }

  return bestName;
}

/** Jaccard similarity on dot/underscore tokens (case-insensitive). */
function jaccard(a: string, b: string): number {
  const tokensA = new Set(a.toLowerCase().split(/[._]/));
  const tokensB = new Set(b.toLowerCase().split(/[._]/));
  const intersection = [...tokensA].filter(t => tokensB.has(t)).length;
  const union = new Set([...tokensA, ...tokensB]).size;
  return union > 0 ? intersection / union : 0;
}
