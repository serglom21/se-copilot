import { useState, useEffect, useRef, useCallback } from 'react';
import { FlaskConical, Play, Square, Trash2, CheckCircle2, XCircle, BookOpen, RotateCcw } from 'lucide-react';
import Button from '../components/Button';

// ---------------------------------------------------------------------------
// Types (mirrors training-runner.ts)
// ---------------------------------------------------------------------------
interface TrainingSpec {
  name: string;
  slug: string;
  vertical: string;
  description: string;
  stack: { frontend: string; backend: string };
  spans: Array<{ name: string; op: string; layer: string }>;
}

interface CriteriaCheck { pass: boolean; details: string; issues?: string[] }
interface CriteriaResult {
  noOrphanSpans: CriteriaCheck;
  feBeConnected: CriteriaCheck;
  customSpansCovered: CriteriaCheck & { missing?: string[] };
  widgetDataMatched: CriteriaCheck & { missingAttrs?: string[] };
  noRootSpanGaps: CriteriaCheck & { gapSpans?: string[] };
  spanTiming?: CriteriaCheck;
  spanNaming?: CriteriaCheck;
  attributeCompleteness?: CriteriaCheck;
  transactionCompleteness?: CriteriaCheck;
}

interface TrainingRunResult {
  specSlug: string;
  specName: string;
  iterations: number;
  finalScore: number;
  finalGrade: string;
  criteria: CriteriaResult;
  rulesExtracted: string[];
  durationMs: number;
  error?: string;
}

interface TrainingRule {
  id: string;
  category: string;
  title: string;
  rule: string;
  discoveredFrom?: string;
  createdAt: string;
  applyTo: string[];
}

type Tab = 'specs' | 'run' | 'rules';

// ---------------------------------------------------------------------------
// Grade badge
// ---------------------------------------------------------------------------
function GradeBadge({ grade, score }: { grade: string; score: number }) {
  const colors: Record<string, string> = {
    A: 'bg-green-500/15 text-green-400 border-green-500/30',
    B: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
    C: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
    D: 'bg-orange-500/15 text-orange-400 border-orange-500/30',
    F: 'bg-red-500/15 text-red-400 border-red-500/30',
  };
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-mono border ${colors[grade] || colors.F}`}>
      {grade} {score}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Spec card
// ---------------------------------------------------------------------------
function SpecCard({ spec, selected, onToggle }: {
  spec: TrainingSpec;
  selected: boolean;
  onToggle: () => void;
}) {
  const verticalColors: Record<string, string> = {
    ecommerce: 'text-pink-400',
    fintech: 'text-green-400',
    healthcare: 'text-blue-400',
    saas: 'text-purple-400',
    gaming: 'text-yellow-400',
    media: 'text-orange-400',
  };
  return (
    <button
      onClick={onToggle}
      className={`w-full text-left p-4 rounded-lg border transition-all ${
        selected
          ? 'border-sentry-purple-500 bg-sentry-purple-500/10'
          : 'border-sentry-border bg-white/3 hover:bg-white/5'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-white truncate">{spec.name}</span>
            <span className={`text-xs ${verticalColors[spec.vertical] || 'text-white/50'}`}>
              {spec.vertical}
            </span>
          </div>
          <p className="text-xs text-white/50 mt-0.5 truncate">{spec.description}</p>
          <div className="flex items-center gap-3 mt-1.5 text-[11px] text-white/35">
            <span>{spec.spans.length} spans</span>
            <span>{spec.stack.frontend} + {spec.stack.backend}</span>
          </div>
        </div>
        <div className={`w-4 h-4 rounded border shrink-0 mt-0.5 flex items-center justify-center ${
          selected ? 'bg-sentry-purple-500 border-sentry-purple-500' : 'border-white/20'
        }`}>
          {selected && <CheckCircle2 size={10} className="text-white" />}
        </div>
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Result card
// ---------------------------------------------------------------------------
function ResultCard({ result }: { result: TrainingRunResult }) {
  const [expanded, setExpanded] = useState(false);
  const pass = result.finalScore >= 80;

  return (
    <div className={`rounded-lg border ${pass ? 'border-green-500/30' : 'border-red-500/30'} bg-white/3`}>
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center justify-between px-4 py-3 text-left"
      >
        <div className="flex items-center gap-3">
          {pass
            ? <CheckCircle2 size={15} className="text-green-400 shrink-0" />
            : <XCircle size={15} className="text-red-400 shrink-0" />}
          <span className="text-sm font-medium text-white">{result.specName}</span>
          {result.error && <span className="text-xs text-red-400">error</span>}
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-white/40">{result.iterations} iter</span>
          <GradeBadge grade={result.finalGrade} score={result.finalScore} />
        </div>
      </button>

      {expanded && (
        <div className="px-4 pb-3 space-y-1 border-t border-white/8 pt-3">
          {Object.entries(result.criteria).map(([key, val]) => {
            const labels: Record<string, string> = {
              noOrphanSpans: 'No orphan spans',
              feBeConnected: 'FE→BE connected',
              customSpansCovered: 'Custom span coverage',
              widgetDataMatched: 'Widget data matched',
              noRootSpanGaps: 'No span gaps',
              spanTiming: 'Span timing integrity',
              spanNaming: 'Span naming conventions',
              attributeCompleteness: 'Attribute completeness',
              transactionCompleteness: 'Transaction structure',
            };
            return (
              <div key={key} className="flex items-start gap-2">
                {val.pass
                  ? <CheckCircle2 size={13} className="text-green-400 shrink-0 mt-0.5" />
                  : <XCircle size={13} className="text-red-400 shrink-0 mt-0.5" />}
                <div>
                  <span className="text-xs text-white/70">{labels[key] || key}</span>
                  <p className="text-[11px] text-white/40">{val.details}</p>
                </div>
              </div>
            );
          })}
          {result.rulesExtracted.length > 0 && (
            <p className="text-[11px] text-sentry-purple-300 mt-2">
              {result.rulesExtracted.length} rule(s) extracted to rules bank
            </p>
          )}
          {result.error && (
            <p className="text-[11px] text-red-400 mt-2">{result.error}</p>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------
export default function TrainingPage() {
  const [tab, setTab] = useState<Tab>('specs');
  const [specs, setSpecs] = useState<TrainingSpec[]>([]);
  const [selectedSlugs, setSelectedSlugs] = useState<Set<string>>(new Set());
  const [isRunning, setIsRunning] = useState(false);
  const [logs, setLogs] = useState<string>('');
  const [results, setResults] = useState<TrainingRunResult[]>([]);
  const [rules, setRules] = useState<TrainingRule[]>([]);
  const [maxIterations, setMaxIterations] = useState(3);
  const [minScore, setMinScore] = useState(80);
  const logRef = useRef<HTMLPreElement>(null);
  const cleanupRef = useRef<(() => void)[]>([]);

  const api = (window as any).electronAPI;

  // Load specs + rules on mount
  useEffect(() => {
    api.getTrainingSpecs().then((s: TrainingSpec[]) => {
      setSpecs(s);
      setSelectedSlugs(new Set(s.map((sp: TrainingSpec) => sp.slug)));
    });
    api.listRules().then(setRules);
    api.getTrainingStatus().then((s: { running: boolean }) => setIsRunning(s.running));
  }, []);

  // Auto-scroll logs
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs]);

  const toggleSpec = useCallback((slug: string) => {
    setSelectedSlugs(prev => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  }, []);

  const startTraining = useCallback(async () => {
    const selectedSpecs = specs.filter(s => selectedSlugs.has(s.slug));
    if (selectedSpecs.length === 0) return;

    setLogs('');
    setResults([]);
    setIsRunning(true);
    setTab('run');

    // Subscribe to events
    const unsubLog = api.onTrainingLog((msg: string) => {
      setLogs(prev => prev + msg);
    });
    const unsubResult = api.onTrainingSpecResult((result: TrainingRunResult) => {
      setResults(prev => [...prev, result]);
      // Always refresh rules after each spec — rules may have been extracted
      api.listRules().then(setRules);
    });
    const unsubComplete = api.onTrainingComplete((_: TrainingRunResult[]) => {
      setIsRunning(false);
      api.listRules().then(setRules);
    });

    cleanupRef.current.forEach(fn => fn());
    cleanupRef.current = [unsubLog, unsubResult, unsubComplete];

    await api.startTraining({
      specs: selectedSpecs,
      maxIterationsPerSpec: maxIterations,
      minPassScore: minScore,
      localIngestPort: 9999,
    });
  }, [specs, selectedSlugs, maxIterations, minScore]);

  const stopTraining = useCallback(async () => {
    await api.stopTraining();
  }, []);

  const deleteRule = useCallback(async (id: string) => {
    await api.deleteRule(id);
    setRules(prev => prev.filter(r => r.id !== id));
  }, []);

  const clearRules = useCallback(async () => {
    await api.clearRules();
    setRules([]);
  }, []);

  // Cleanup on unmount
  useEffect(() => () => cleanupRef.current.forEach(fn => fn()), []);

  const passCount = results.filter(r => r.finalScore >= minScore).length;

  const categoryColors: Record<string, string> = {
    orphan_spans: 'text-orange-400',
    fe_be_connection: 'text-blue-400',
    custom_spans: 'text-purple-400',
    widget_data: 'text-green-400',
    span_gaps: 'text-yellow-400',
    general: 'text-white/50',
  };

  return (
    <div className="flex flex-col h-full bg-sentry-background">
      {/* Header */}
      <div className="px-8 py-6 border-b border-sentry-border shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <FlaskConical size={20} className="text-sentry-purple-400" />
            <div>
              <h1 className="text-lg font-semibold text-white">Training Loop</h1>
              <p className="text-xs text-white/40 mt-0.5">
                Generate, validate, and learn from reference apps autonomously
              </p>
            </div>
          </div>
          {tab === 'run' && (
            <div className="flex items-center gap-3">
              {results.length > 0 && (
                <span className="text-sm text-white/50">
                  {passCount}/{results.length} passed
                </span>
              )}
              {isRunning
                ? <Button variant="ghost" size="sm" onClick={stopTraining} className="gap-1.5 text-red-400 border-red-500/30 hover:bg-red-500/10">
                    <Square size={13} /> Stop
                  </Button>
                : <Button variant="primary" size="sm" onClick={startTraining} className="gap-1.5">
                    <RotateCcw size={13} /> Re-run
                  </Button>
              }
            </div>
          )}
        </div>

        {/* Tabs */}
        <div className="flex gap-1 mt-5">
          {(['specs', 'run', 'rules'] as Tab[]).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-1.5 rounded-md text-xs font-medium transition-all capitalize ${
                tab === t
                  ? 'bg-sentry-purple-500/20 text-sentry-purple-300 border border-sentry-purple-500/30'
                  : 'text-white/40 hover:text-white/70'
              }`}
            >
              {t === 'rules' ? `Rules (${rules.length})` : t === 'run' ? `Run${results.length ? ` (${results.length})` : ''}` : 'Spec Bank'}
            </button>
          ))}
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-hidden">

        {/* Spec Bank */}
        {tab === 'specs' && (
          <div className="h-full overflow-y-auto px-8 py-6">
            <div className="flex items-center justify-between mb-4">
              <p className="text-sm text-white/50">
                Select specs to include in the training run
              </p>
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-2 text-xs text-white/50">
                  <label>Max iterations:</label>
                  <input
                    type="number"
                    min={1}
                    max={20}
                    value={maxIterations}
                    onChange={e => setMaxIterations(Number(e.target.value))}
                    className="w-12 bg-white/5 border border-sentry-border rounded px-2 py-1 text-white text-center"
                  />
                </div>
                <div className="flex items-center gap-2 text-xs text-white/50">
                  <label>Pass score:</label>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={minScore}
                    onChange={e => setMinScore(Number(e.target.value))}
                    className="w-14 bg-white/5 border border-sentry-border rounded px-2 py-1 text-white text-center"
                  />
                </div>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={startTraining}
                  disabled={selectedSlugs.size === 0 || isRunning}
                  className="gap-1.5"
                >
                  <Play size={13} />
                  Run {selectedSlugs.size} spec{selectedSlugs.size !== 1 ? 's' : ''}
                </Button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              {specs.map(spec => (
                <SpecCard
                  key={spec.slug}
                  spec={spec}
                  selected={selectedSlugs.has(spec.slug)}
                  onToggle={() => toggleSpec(spec.slug)}
                />
              ))}
            </div>

            {specs.length === 0 && (
              <div className="text-center py-16 text-white/30">
                <FlaskConical size={40} className="mx-auto mb-3 opacity-30" />
                <p className="text-sm">Loading spec bank...</p>
              </div>
            )}
          </div>
        )}

        {/* Run tab */}
        {tab === 'run' && (
          <div className="h-full flex flex-col">
            {/* Results chips */}
            {results.length > 0 && (
              <div className="px-8 py-3 border-b border-sentry-border shrink-0">
                <div className="flex flex-wrap gap-2">
                  {results.map(r => (
                    <div
                      key={r.specSlug}
                      className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs border ${
                        r.finalScore >= minScore
                          ? 'bg-green-500/10 border-green-500/30 text-green-400'
                          : 'bg-red-500/10 border-red-500/30 text-red-400'
                      }`}
                    >
                      {r.finalScore >= minScore
                        ? <CheckCircle2 size={11} />
                        : <XCircle size={11} />}
                      <span>{r.specName}</span>
                      <span className="font-mono">{r.finalScore}</span>
                    </div>
                  ))}
                  {isRunning && (
                    <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs border border-sentry-purple-500/30 text-sentry-purple-300 bg-sentry-purple-500/10">
                      <span className="w-1.5 h-1.5 rounded-full bg-sentry-purple-400 animate-pulse" />
                      Running...
                    </div>
                  )}
                </div>
              </div>
            )}

            <div className="flex-1 flex gap-0 overflow-hidden">
              {/* Log output */}
              <div className="flex-1 overflow-hidden flex flex-col">
                <pre
                  ref={logRef}
                  className="flex-1 overflow-y-auto px-8 py-4 text-[11px] leading-relaxed text-white/70 font-mono whitespace-pre-wrap"
                >
                  {logs || (
                    <span className="text-white/20">
                      {isRunning ? 'Starting...' : 'No run yet. Select specs and click Run.'}
                    </span>
                  )}
                </pre>
              </div>

              {/* Results sidebar */}
              {results.length > 0 && (
                <div className="w-72 border-l border-sentry-border overflow-y-auto p-4 space-y-2 shrink-0">
                  <p className="text-xs font-medium text-white/40 mb-3">Results</p>
                  {results.map(r => (
                    <ResultCard key={r.specSlug} result={r} />
                  ))}
                </div>
              )}
            </div>

            {/* Start button when no run yet */}
            {!isRunning && logs === '' && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div className="pointer-events-auto text-center">
                  <FlaskConical size={48} className="mx-auto mb-4 text-white/15" />
                  <p className="text-white/30 text-sm mb-4">No training run yet</p>
                  <Button variant="primary" onClick={() => setTab('specs')}>
                    Configure & Start
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Rules tab */}
        {tab === 'rules' && (
          <div className="h-full overflow-y-auto px-8 py-6">
            <div className="flex items-center justify-between mb-5">
              <div>
                <h2 className="text-sm font-medium text-white">Rules Bank</h2>
                <p className="text-xs text-white/40 mt-0.5">
                  Rules extracted from training failures are injected into future generation prompts
                </p>
              </div>
              {rules.length > 0 && (
                <Button variant="ghost" size="sm" onClick={clearRules} className="gap-1.5 text-red-400/70 hover:text-red-400">
                  <Trash2 size={12} /> Clear all
                </Button>
              )}
            </div>

            {rules.length === 0 ? (
              <div className="text-center py-16 text-white/25">
                <BookOpen size={40} className="mx-auto mb-3 opacity-30" />
                <p className="text-sm">No rules yet</p>
                <p className="text-xs mt-1">Run training to discover and extract rules automatically</p>
              </div>
            ) : (
              <div className="space-y-3">
                {rules.map(rule => (
                  <div key={rule.id} className="p-4 rounded-lg border border-sentry-border bg-white/3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className={`text-[11px] font-mono uppercase ${categoryColors[rule.category] || 'text-white/40'}`}>
                            {rule.category.replace(/_/g, ' ')}
                          </span>
                          {rule.discoveredFrom && (
                            <span className="text-[10px] text-white/25">from {rule.discoveredFrom}</span>
                          )}
                        </div>
                        <p className="text-xs font-medium text-white mb-1">{rule.title}</p>
                        <p className="text-[11px] text-white/50 leading-relaxed">{rule.rule}</p>
                        <div className="flex gap-1 mt-2">
                          {rule.applyTo.map(a => (
                            <span key={a} className="px-1.5 py-0.5 rounded text-[10px] bg-white/5 text-white/30 border border-white/10">
                              {a}
                            </span>
                          ))}
                        </div>
                      </div>
                      <button
                        onClick={() => deleteRule(rule.id)}
                        className="text-white/20 hover:text-red-400 transition-colors shrink-0"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

      </div>
    </div>
  );
}
