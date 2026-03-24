import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { useProjectStore } from '../store/project-store';
import Button from '../components/Button';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface CapturedSpan {
  span_id: string;
  parent_span_id: string | null;
  trace_id: string;
  op: string;
  description: string;
  start_timestamp: number;
  timestamp: number;
  status?: string;
  data?: Record<string, any>;
}

interface CapturedTrace {
  trace_id: string;
  transactions: any[];
  allSpans: CapturedSpan[];
  orphanSpanIds: string[];
  score: number;
  grade: string;
  capturedAt: number;
}

// ---------------------------------------------------------------------------
// Waterfall helpers
// ---------------------------------------------------------------------------
interface SpanRow {
  span: CapturedSpan;
  depth: number;
  isOrphan: boolean;
}

function buildWaterfall(trace: CapturedTrace): SpanRow[] {
  const spanMap = new Map<string, CapturedSpan>();
  for (const s of trace.allSpans) {
    if (s.span_id) spanMap.set(s.span_id, s);
  }

  const orphanSet = new Set(trace.orphanSpanIds);
  const childrenOf = new Map<string | null, CapturedSpan[]>();
  for (const s of trace.allSpans) {
    const parent = spanMap.has(s.parent_span_id ?? '') ? s.parent_span_id : null;
    if (!childrenOf.has(parent)) childrenOf.set(parent, []);
    childrenOf.get(parent)!.push(s);
  }

  // Sort children by start_timestamp
  for (const [, children] of childrenOf) {
    children.sort((a, b) => a.start_timestamp - b.start_timestamp);
  }

  const rows: SpanRow[] = [];
  const visit = (spanId: string | null, depth: number) => {
    const children = childrenOf.get(spanId) || [];
    for (const child of children) {
      rows.push({ span: child, depth, isOrphan: orphanSet.has(child.span_id) });
      visit(child.span_id, depth + 1);
    }
  };
  visit(null, 0);
  return rows;
}

function opColor(op: string, isOrphan: boolean): string {
  if (isOrphan) return 'bg-red-500';
  if (op === 'pageload' || op === 'navigation') return 'bg-sentry-purple-500';
  if (op.startsWith('http.server')) return 'bg-blue-500';
  if (op.startsWith('http.client')) return 'bg-cyan-500';
  if (op.startsWith('db')) return 'bg-yellow-500';
  if (op.startsWith('cache')) return 'bg-green-500';
  return 'bg-white/40';
}

function formatDuration(start: number, end: number): string {
  const ms = (end - start) * 1000;
  if (ms < 1) return '<1ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function gradeColor(grade: string): string {
  const map: Record<string, string> = { A: 'text-green-400 bg-green-400/10 border-green-400/30', B: 'text-blue-400 bg-blue-400/10 border-blue-400/30', C: 'text-yellow-400 bg-yellow-400/10 border-yellow-400/30', D: 'text-orange-400 bg-orange-400/10 border-orange-400/30', F: 'text-red-400 bg-red-400/10 border-red-400/30' };
  return map[grade] || map['F'];
}

// ---------------------------------------------------------------------------
// Waterfall component
// ---------------------------------------------------------------------------
function TraceWaterfall({ trace }: { trace: CapturedTrace }) {
  const rows = buildWaterfall(trace);
  if (rows.length === 0) return <p className="text-sm text-white/30 p-4">No spans to display.</p>;

  const starts = trace.allSpans.map(s => s.start_timestamp).filter(Boolean);
  const ends = trace.allSpans.map(s => s.timestamp).filter(Boolean);
  const traceStart = Math.min(...starts);
  const traceEnd = Math.max(...ends);
  const traceDuration = traceEnd - traceStart || 1;

  return (
    <div className="overflow-x-auto">
      {/* Time ruler */}
      <div className="flex mb-2 ml-64 pr-4">
        {[0, 25, 50, 75, 100].map(pct => (
          <div key={pct} className="flex-1 text-[10px] text-white/25 font-mono">
            {pct === 0 ? '0' : `${Math.round(traceDuration * pct / 100 * 1000)}ms`}
          </div>
        ))}
      </div>
      <div className="space-y-0.5">
        {rows.map(({ span, depth, isOrphan }, i) => {
          const barLeft = ((span.start_timestamp - traceStart) / traceDuration) * 100;
          const barWidth = Math.max(0.5, ((span.timestamp - span.start_timestamp) / traceDuration) * 100);
          const duration = formatDuration(span.start_timestamp, span.timestamp);
          const color = opColor(span.op, isOrphan);

          return (
            <div key={`${span.span_id}-${i}`} className="flex items-center group hover:bg-white/3 rounded">
              {/* Left: name */}
              <div
                className="w-64 shrink-0 flex items-center gap-1.5 pr-3 overflow-hidden"
                style={{ paddingLeft: `${8 + depth * 16}px` }}
              >
                <span className={`w-2 h-2 rounded-full shrink-0 ${color}`} />
                <span className="text-[11px] text-white/70 truncate font-mono" title={span.description}>
                  {span.description}
                </span>
                {isOrphan && (
                  <span className="text-[9px] text-red-400 border border-red-400/40 rounded px-1 shrink-0">orphan</span>
                )}
              </div>
              {/* Right: bar */}
              <div className="flex-1 relative h-5 mr-4">
                <div
                  className={`absolute top-0.5 h-4 rounded-sm opacity-80 ${color}`}
                  style={{ left: `${barLeft}%`, width: `${barWidth}%`, minWidth: '2px' }}
                />
              </div>
              {/* Duration */}
              <div className="w-16 shrink-0 text-[11px] text-white/35 font-mono text-right pr-3">
                {duration}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sentry prompt template (keep existing logic)
// ---------------------------------------------------------------------------
const PROMPT_TEMPLATE = `You are a distributed tracing expert specializing in Sentry SDK instrumentation. Your task is to perform a comprehensive health and consistency analysis of the distributed trace data provided below, cross-referencing it against the engagement spec that describes the expected instrumentation.

## INPUTS

### 1. Engagement Spec (SpanDefinition list)
\`\`\`json
{{ENGAGEMENT_SPEC_JSON}}
\`\`\`

### 2. Trace Data (Sentry API format)
\`\`\`json
{{TRACE_DATA_JSON}}
\`\`\`

Perform orphan span detection, FE→BE connectivity checks, timing validation, attribute completeness, and op code naming checks.

Return a structured JSON health report with: overall_health_score (0-100), health_grade (A/B/C/D/F), findings (severity: critical/warning/info), and recommendations.`;

function buildPrompt(specJson: string, traceDataJson: string): string {
  return PROMPT_TEMPLATE
    .replace('{{ENGAGEMENT_SPEC_JSON}}', specJson)
    .replace('{{TRACE_DATA_JSON}}', traceDataJson);
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------
export default function TraceHealthPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const { currentProject, loadProject } = useProjectStore();
  const [tab, setTab] = useState<'local' | 'sentry'>('local');

  // --- Local ingest state ---
  const [ingestRunning, setIngestRunning] = useState(false);
  const [localDsn, setLocalDsn] = useState('');
  const [traces, setTraces] = useState<CapturedTrace[]>([]);
  const [selectedTrace, setSelectedTrace] = useState<CapturedTrace | null>(null);
  const [dsnCopied, setDsnCopied] = useState(false);
  const [ingestError, setIngestError] = useState('');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // --- Sentry tab state ---
  const [traceIdsInput, setTraceIdsInput] = useState('');
  const [fetchedTraceIds, setFetchedTraceIds] = useState<string[]>([]);
  const [selectedTraceIds, setSelectedTraceIds] = useState<Set<string>>(new Set());
  const [fetchingIds, setFetchingIds] = useState(false);
  const [fetchingSpans, setFetchingSpans] = useState(false);
  const [fetchError, setFetchError] = useState('');
  const [generatedPrompt, setGeneratedPrompt] = useState('');
  const [promptCopied, setPromptCopied] = useState(false);

  useEffect(() => {
    if (projectId) loadProject(projectId);
  }, [projectId, loadProject]);

  // On mount, check if ingest server is already running
  useEffect(() => {
    window.electronAPI.getTraceIngestStatus().then(status => {
      setIngestRunning(status.running);
      setLocalDsn(status.dsn);
    });
  }, []);

  const refreshTraces = useCallback(async () => {
    const t = await window.electronAPI.getLocalTraces();
    setTraces(t);
    // If selected trace still exists, update it
    if (selectedTrace) {
      const updated = t.find((x: CapturedTrace) => x.trace_id === selectedTrace.trace_id);
      if (updated) setSelectedTrace(updated);
    }
  }, [selectedTrace]);

  // Poll when running
  useEffect(() => {
    if (ingestRunning) {
      refreshTraces();
      pollRef.current = setInterval(refreshTraces, 2000);
    } else {
      if (pollRef.current) clearInterval(pollRef.current);
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [ingestRunning, refreshTraces]);

  const handleToggleIngest = async () => {
    setIngestError('');
    if (ingestRunning) {
      await window.electronAPI.stopTraceIngest();
      setIngestRunning(false);
    } else {
      const result = await window.electronAPI.startTraceIngest();
      if (result.success) {
        setIngestRunning(true);
        setLocalDsn(result.dsn || '');
      } else {
        setIngestError(result.error || 'Failed to start ingest server');
      }
    }
  };

  const handleClearTraces = async () => {
    await window.electronAPI.clearLocalTraces();
    setTraces([]);
    setSelectedTrace(null);
  };

  const handleCopyDsn = () => {
    navigator.clipboard.writeText(localDsn);
    setDsnCopied(true);
    setTimeout(() => setDsnCopied(false), 2000);
  };

  if (!currentProject) return <div className="p-8 text-white/50">Loading...</div>;

  const spans = currentProject.instrumentation?.spans ?? [];
  const specJson = JSON.stringify(spans, null, 2);

  // Sentry tab helpers
  const manualIds = traceIdsInput.split(/[\s,\n]+/).map(s => s.trim()).filter(Boolean);
  const allSelectedIds = [...new Set([...selectedTraceIds, ...manualIds])];

  const handleFetchTraceIds = async () => {
    setFetchingIds(true); setFetchError('');
    const result = await window.electronAPI.listRecentSentryTraceIds(currentProject.project?.slug);
    setFetchingIds(false);
    if (!result.success || !result.traceIds) { setFetchError(result.error ?? 'Unknown error'); return; }
    setFetchedTraceIds(result.traceIds);
    setSelectedTraceIds(new Set(result.traceIds.slice(0, 3)));
  };

  const handleGeneratePrompt = async () => {
    if (allSelectedIds.length === 0) { setGeneratedPrompt(buildPrompt(specJson, '[]')); return; }
    setFetchingSpans(true); setFetchError('');
    const result = await window.electronAPI.fetchSentryTraceSpans(allSelectedIds);
    setFetchingSpans(false);
    if (!result.success) { setFetchError(result.error ?? 'Unknown error'); return; }
    setGeneratedPrompt(buildPrompt(specJson, JSON.stringify(result.spans ?? [], null, 2)));
  };

  const hasFe = (t: CapturedTrace) => t.allSpans.some(s => s.op === 'pageload' || s.op === 'navigation');
  const hasBe = (t: CapturedTrace) => t.allSpans.some(s => s.op === 'http.server');
  const traceLabel = (t: CapturedTrace) => hasFe(t) && hasBe(t) ? 'FE+BE' : hasFe(t) ? 'FE' : hasBe(t) ? 'BE' : 'spans';
  const totalDuration = (t: CapturedTrace) => {
    const starts = t.allSpans.map(s => s.start_timestamp).filter(Boolean);
    const ends = t.allSpans.map(s => s.timestamp).filter(Boolean);
    if (!starts.length || !ends.length) return null;
    return formatDuration(Math.min(...starts), Math.max(...ends));
  };

  return (
    <div className="h-full flex flex-col bg-sentry-background text-white">
      {/* Header */}
      <div className="px-6 py-4 border-b border-sentry-border shrink-0">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-white">Trace Health</h1>
            <p className="text-xs text-white/40 mt-0.5">Inspect and validate distributed traces</p>
          </div>
          {/* Tabs */}
          <div className="flex gap-1 bg-sentry-surface border border-sentry-border rounded-lg p-1">
            {(['local', 'sentry'] as const).map(t => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-3 py-1 text-xs font-medium rounded-md transition-all ${tab === t ? 'bg-sentry-purple-500 text-white' : 'text-white/50 hover:text-white/80'}`}
              >
                {t === 'local' ? '⚡ Local Ingest' : '☁️ Sentry API'}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ================================================================ LOCAL TAB */}
      {tab === 'local' && (
        <div className="flex-1 flex overflow-hidden">
          {/* Left panel */}
          <div className="w-72 border-r border-sentry-border flex flex-col shrink-0">
            {/* Server controls */}
            <div className="p-4 border-b border-sentry-border space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-white/60">Ingest Server</span>
                <div className={`flex items-center gap-1.5 text-xs font-medium ${ingestRunning ? 'text-green-400' : 'text-white/30'}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${ingestRunning ? 'bg-green-400 animate-pulse' : 'bg-white/20'}`} />
                  {ingestRunning ? 'Running :9999' : 'Stopped'}
                </div>
              </div>
              <button
                onClick={handleToggleIngest}
                className={`w-full py-1.5 rounded-lg text-xs font-medium transition-all ${ingestRunning ? 'bg-red-500/10 border border-red-500/30 text-red-400 hover:bg-red-500/20' : 'bg-sentry-purple-500/15 border border-sentry-purple-500/30 text-sentry-purple-300 hover:bg-sentry-purple-500/25'}`}
              >
                {ingestRunning ? 'Stop Server' : 'Start Server'}
              </button>
              {ingestError && <p className="text-xs text-red-400">{ingestError}</p>}

              {localDsn && (
                <div>
                  <p className="text-[10px] text-white/30 mb-1">Local DSN — set in generated app .env:</p>
                  <div className="flex gap-1">
                    <code className="flex-1 text-[10px] bg-sentry-surface border border-sentry-border rounded px-2 py-1 font-mono text-white/60 truncate">
                      {localDsn}
                    </code>
                    <button
                      onClick={handleCopyDsn}
                      className="px-2 py-1 bg-sentry-surface border border-sentry-border rounded text-[10px] text-white/50 hover:text-white/80 transition-colors shrink-0"
                    >
                      {dsnCopied ? '✓' : 'Copy'}
                    </button>
                  </div>
                  <p className="text-[10px] text-white/25 mt-1">
                    Set <code className="text-white/40">SENTRY_DSN</code> and <code className="text-white/40">NEXT_PUBLIC_SENTRY_DSN</code> to this value in the generated app.
                  </p>
                </div>
              )}
            </div>

            {/* Trace list */}
            <div className="flex items-center justify-between px-4 py-2 border-b border-sentry-border">
              <span className="text-[11px] font-medium text-white/40 uppercase tracking-wider">
                Traces {traces.length > 0 && `(${traces.length})`}
              </span>
              {traces.length > 0 && (
                <button onClick={handleClearTraces} className="text-[10px] text-white/30 hover:text-red-400 transition-colors">
                  Clear
                </button>
              )}
            </div>

            <div className="flex-1 overflow-y-auto">
              {traces.length === 0 ? (
                <div className="p-4 text-center">
                  <p className="text-xs text-white/25">
                    {ingestRunning ? 'Waiting for traces…\nRun the data generator with\nthe local DSN.' : 'Start the ingest server\nthen run the data generator.'}
                  </p>
                </div>
              ) : (
                traces.map(t => (
                  <button
                    key={t.trace_id}
                    onClick={() => setSelectedTrace(selectedTrace?.trace_id === t.trace_id ? null : t)}
                    className={`w-full text-left px-4 py-3 border-b border-sentry-border transition-colors ${selectedTrace?.trace_id === t.trace_id ? 'bg-sentry-purple-500/10' : 'hover:bg-white/3'}`}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <code className="text-[10px] text-white/40 font-mono">{t.trace_id.substring(0, 12)}…</code>
                      <span className={`text-[11px] font-bold border rounded px-1.5 py-0.5 ${gradeColor(t.grade)}`}>
                        {t.grade}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-[10px] text-white/35">
                      <span className="bg-white/8 rounded px-1.5 py-0.5">{traceLabel(t)}</span>
                      <span>{t.allSpans.length} spans</span>
                      {totalDuration(t) && <span>{totalDuration(t)}</span>}
                      {t.orphanSpanIds.length > 0 && (
                        <span className="text-red-400">{t.orphanSpanIds.length} orphan{t.orphanSpanIds.length > 1 ? 's' : ''}</span>
                      )}
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>

          {/* Right: waterfall */}
          <div className="flex-1 overflow-auto p-5">
            {selectedTrace ? (
              <>
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <h2 className="text-sm font-semibold text-white">
                      Trace <code className="text-white/50 font-mono text-xs">{selectedTrace.trace_id}</code>
                    </h2>
                    <div className="flex items-center gap-3 mt-1 text-xs text-white/40">
                      <span>{selectedTrace.allSpans.length} spans</span>
                      <span>{selectedTrace.transactions.length} transaction{selectedTrace.transactions.length !== 1 ? 's' : ''}</span>
                      {selectedTrace.orphanSpanIds.length > 0 && (
                        <span className="text-red-400">{selectedTrace.orphanSpanIds.length} orphan span{selectedTrace.orphanSpanIds.length !== 1 ? 's' : ''}</span>
                      )}
                      <span className={`font-semibold border rounded px-1.5 py-0.5 ${gradeColor(selectedTrace.grade)}`}>
                        Score: {selectedTrace.score}/100
                      </span>
                    </div>
                  </div>
                  {/* Legend */}
                  <div className="flex items-center gap-3 text-[10px] text-white/40">
                    {[['bg-sentry-purple-500', 'pageload'], ['bg-blue-500', 'http.server'], ['bg-cyan-500', 'http.client'], ['bg-yellow-500', 'db'], ['bg-red-500', 'orphan']].map(([color, label]) => (
                      <span key={label} className="flex items-center gap-1">
                        <span className={`w-2 h-2 rounded-full ${color}`} />
                        {label}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="bg-sentry-surface border border-sentry-border rounded-xl p-4">
                  <TraceWaterfall trace={selectedTrace} />
                </div>
              </>
            ) : (
              <div className="h-full flex items-center justify-center text-center">
                <div>
                  <div className="text-4xl mb-3 opacity-30">⟷</div>
                  <p className="text-sm text-white/30">Select a trace to see the waterfall</p>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ================================================================ SENTRY TAB */}
      {tab === 'sentry' && (
        <div className="flex-1 flex overflow-hidden">
          {/* Left config */}
          <div className="w-80 border-r border-sentry-border flex flex-col overflow-y-auto">
            <div className="p-5 space-y-6">
              <section>
                <h2 className="text-[11px] font-semibold text-white/35 uppercase tracking-wider mb-3">Engagement Spec</h2>
                <div className="bg-sentry-surface border border-sentry-border rounded-lg p-3 text-xs text-white/60 space-y-1">
                  <div><span className="text-white/40">Stack:</span> {currentProject.stack?.type}</div>
                  <div><span className="text-white/40">Custom spans:</span> {spans.length}</div>
                  <div className="text-[10px] text-white/25">
                    {spans.filter((s: any) => s.layer === 'frontend').length} frontend · {spans.filter((s: any) => s.layer === 'backend').length} backend
                  </div>
                </div>
              </section>

              <section>
                <h2 className="text-[11px] font-semibold text-white/35 uppercase tracking-wider mb-3">Step 1 — Select Traces</h2>
                <Button onClick={handleFetchTraceIds} disabled={fetchingIds} variant="secondary" size="sm" className="w-full mb-3">
                  {fetchingIds ? 'Fetching…' : '🔍 Fetch Recent Traces from Sentry'}
                </Button>
                {fetchedTraceIds.length > 0 && (
                  <div className="space-y-1 mb-3">
                    <p className="text-[10px] text-white/30 mb-1">Select up to 5:</p>
                    {fetchedTraceIds.map(tid => (
                      <label key={tid} className="flex items-center gap-2 cursor-pointer text-xs">
                        <input type="checkbox" checked={selectedTraceIds.has(tid)} onChange={() => {
                          setSelectedTraceIds(prev => { const n = new Set(prev); if (n.has(tid)) n.delete(tid); else n.add(tid); return n; });
                        }} className="rounded" />
                        <span className="font-mono text-white/50 truncate text-[10px]">{tid}</span>
                      </label>
                    ))}
                  </div>
                )}
                <div>
                  <label className="block text-[10px] text-white/30 mb-1">Or paste trace IDs (comma/newline):</label>
                  <textarea
                    className="w-full h-20 text-[10px] font-mono bg-sentry-surface border border-sentry-border rounded-md p-2 resize-none text-white/60 placeholder-white/20 focus:outline-none focus:ring-1 focus:ring-sentry-purple-500/40"
                    placeholder="abc123..., def456..."
                    value={traceIdsInput}
                    onChange={e => setTraceIdsInput(e.target.value)}
                  />
                </div>
              </section>

              <section className="space-y-2">
                <h2 className="text-[11px] font-semibold text-white/35 uppercase tracking-wider mb-3">Step 2 — Generate Prompt</h2>
                {allSelectedIds.length > 0 ? (
                  <Button onClick={handleGeneratePrompt} disabled={fetchingSpans} size="sm" className="w-full">
                    {fetchingSpans ? `Fetching ${allSelectedIds.length} trace(s)…` : `Generate Prompt (${allSelectedIds.length} trace${allSelectedIds.length > 1 ? 's' : ''})`}
                  </Button>
                ) : (
                  <Button onClick={() => { setGeneratedPrompt(buildPrompt(specJson, '[ /* paste Sentry span JSON here */ ]')); }} variant="secondary" size="sm" className="w-full">
                    Copy Prompt (manual trace data)
                  </Button>
                )}
                {fetchError && <div className="text-xs text-red-400 bg-red-400/5 border border-red-400/20 rounded p-2">{fetchError}</div>}
              </section>

              <section className="bg-sentry-surface border border-sentry-border rounded-lg p-3 text-[11px] text-white/40 space-y-1">
                <p className="font-medium text-white/60 mb-1">How to use:</p>
                <ol className="list-decimal list-inside space-y-1">
                  <li>Select traces from Sentry or paste IDs</li>
                  <li>Click Generate Prompt</li>
                  <li>Copy and paste into Claude</li>
                  <li>Claude returns a JSON health report</li>
                </ol>
              </section>
            </div>
          </div>

          {/* Right: prompt */}
          <div className="flex-1 flex flex-col overflow-hidden">
            <div className="px-5 py-3 border-b border-sentry-border flex items-center justify-between shrink-0">
              <div>
                <h2 className="text-sm font-semibold text-white">Generated Prompt</h2>
                {generatedPrompt && <p className="text-[10px] text-white/30 mt-0.5">{generatedPrompt.length.toLocaleString()} chars</p>}
              </div>
              {generatedPrompt && (
                <Button onClick={async () => { await navigator.clipboard.writeText(generatedPrompt); setPromptCopied(true); setTimeout(() => setPromptCopied(false), 2000); }} size="sm">
                  {promptCopied ? '✅ Copied!' : '📋 Copy'}
                </Button>
              )}
            </div>
            <div className="flex-1 overflow-y-auto bg-sentry-surface font-mono text-[11px] text-green-300/80 whitespace-pre-wrap p-5">
              {generatedPrompt || (
                <div className="text-white/20 font-sans text-sm text-center py-16">
                  <div className="text-4xl mb-4">🔬</div>
                  <p>Select traces and click Generate Prompt</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
