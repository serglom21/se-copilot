import ts from 'typescript';

export interface PageSyntaxError {
  line: number;
  col: number;
  message: string;
  /** 5-line window around the error — included verbatim in LLM repair prompts */
  snippet: string;
}

/**
 * Parse a .tsx/.ts source string with the TypeScript compiler and return
 * syntactic errors only (no type-checking, no file I/O, ~1ms per file).
 * Safe to call before writing to disk — catches ANY syntax error regardless
 * of whether we've seen the pattern before.
 */
export function checkPageSyntax(code: string, filename: string): PageSyntaxError[] {
  const kind = filename.endsWith('.tsx') || filename.endsWith('.jsx')
    ? ts.ScriptKind.TSX
    : ts.ScriptKind.TS;

  const compilerOptions: ts.CompilerOptions = {
    noEmit: true,
    jsx: ts.JsxEmit.ReactJSX,
    target: ts.ScriptTarget.Latest,
    skipLibCheck: true,
    // noResolve prevents TypeScript from touching the filesystem to resolve imports
    noResolve: true,
  };

  const sourceFile = ts.createSourceFile(
    filename,
    code,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    kind
  );

  // Build a minimal in-memory CompilerHost so createProgram never touches disk
  const defaultHost = ts.createCompilerHost(compilerOptions);
  const host: ts.CompilerHost = {
    ...defaultHost,
    getSourceFile: (name, langVersion) => {
      if (name === filename) return sourceFile;
      // Return an empty source file for everything else (lib files etc.)
      return ts.createSourceFile(name, '', langVersion, false);
    },
    fileExists: (name) => name === filename,
    readFile: (name) => (name === filename ? code : ''),
    writeFile: () => {},
  };

  const program = ts.createProgram([filename], compilerOptions, host);
  const diagnostics = program.getSyntacticDiagnostics(sourceFile);

  if (diagnostics.length === 0) return [];

  const lines = code.split('\n');
  return diagnostics.map(d => {
    const pos = d.start ?? 0;
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(pos);
    const snippet = lines
      .slice(Math.max(0, line - 2), Math.min(lines.length, line + 3))
      .map((l, i) => `${line - 1 + i + 1} | ${l}`)
      .join('\n');
    return {
      line: line + 1,
      col: character + 1,
      message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
      snippet,
    };
  });
}

/**
 * Format syntax errors for inclusion in an LLM repair prompt.
 * Includes exact location + surrounding code context for each error.
 */
export function formatSyntaxErrorsForLLM(errors: PageSyntaxError[]): string {
  return errors
    .map(e => `Line ${e.line}, Col ${e.col}: ${e.message}\nContext:\n${e.snippet}`)
    .join('\n\n');
}
