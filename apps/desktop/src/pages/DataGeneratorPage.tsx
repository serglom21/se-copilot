import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Play, Square, Trash2, HelpCircle, Terminal, CheckCircle2, ChevronDown, ChevronRight, RefreshCw, Activity, ExternalLink } from 'lucide-react';
import { useProjectStore } from '../store/project-store';
import { Input } from '../components/Input';
import Button from '../components/Button';
import TroubleshootingChat from '../components/TroubleshootingChat';
import { toast } from '../store/toast-store';

interface HealthReport {
  tracesFound: number;
  coveragePct: number;
  grade: string;
  coveredCount: number;
  totalSpec: number;
  hasDistributed: boolean;
  stackType: string;
  traceIds: string[];
}

export default function DataGeneratorPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const { currentProject, loadProject } = useProjectStore();
  const navigate = useNavigate();

  const [config, setConfig] = useState({
    frontendDsn: '',
    backendDsn: '',
    numTraces: 10,
    numErrors: 5,
    environment: 'development',
  });

  const [running, setRunning] = useState(false);
  const [output, setOutput] = useState<string[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [showChat, setShowChat] = useState(false);
  const outputRef = useRef<HTMLDivElement>(null);

  // Sentry project picker
  const [sentryAuth, setSentryAuth] = useState<{
    authenticated: boolean;
    orgs?: Array<{ slug: string; name: string }>;
  }>({ authenticated: false });
  const [selectedOrg, setSelectedOrg] = useState('');
  const [projects, setProjects] = useState<Array<{ slug: string; name: string; platform?: string }>>([]);
  const [loadingProjects, setLoadingProjects] = useState(false);
  const [selectedProject, setSelectedProject] = useState<{ slug: string; name: string } | null>(null);
  const [loadingDsn, setLoadingDsn] = useState(false);
  const [showManualDsn, setShowManualDsn] = useState(false);

  // Post-run health check
  const [checkingHealth, setCheckingHealth] = useState(false);
  const [healthReport, setHealthReport] = useState<HealthReport | null>(null);

  useEffect(() => {
    if (projectId) loadProject(projectId);
  }, [projectId, loadProject]);

  useEffect(() => {
    window.electronAPI.getSentryOAuthStatus().then(status => {
      setSentryAuth(status);
      if (status.authenticated && status.orgs?.length) {
        const firstOrg = status.orgs[0].slug;
        setSelectedOrg(firstOrg);
        loadProjects(firstOrg);
      } else if (!status.authenticated) {
        setShowManualDsn(true);
      }
    });
  }, []);

  useEffect(() => {
    const cleanupOut = window.electronAPI.onDataOutput(data => setOutput(prev => [...prev, data]));
    const cleanupErr = window.electronAPI.onDataError(error => {
      setOutput(prev => [...prev, `ERROR: ${error}\n`]);
      setErrors(prev => [...prev, error]);
    });
    return () => { cleanupOut(); cleanupErr(); };
  }, []);

  useEffect(() => {
    if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [output]);

  const loadProjects = async (orgSlug: string) => {
    setLoadingProjects(true);
    setProjects([]);
    setSelectedProject(null);
    try {
      const list = await window.electronAPI.listSentryProjects(orgSlug);
      setProjects(list);
    } catch {
      toast.error('Failed to load projects');
    } finally {
      setLoadingProjects(false);
    }
  };

  const handleOrgChange = (orgSlug: string) => {
    setSelectedOrg(orgSlug);
    loadProjects(orgSlug);
  };

  const handleSelectProject = async (project: { slug: string; name: string }) => {
    setSelectedProject(project);
    setLoadingDsn(true);
    try {
      const result = await window.electronAPI.getSentryProjectDsn(selectedOrg, project.slug);
      if (result?.publicDsn) {
        setConfig(c => ({ ...c, frontendDsn: result.publicDsn, backendDsn: result.publicDsn }));
      } else {
        toast.warning('No DSN found for this project — enter manually below');
        setShowManualDsn(true);
      }
    } finally {
      setLoadingDsn(false);
    }
  };

  const runHealthCheck = async () => {
    if (!sentryAuth.authenticated || !currentProject) return;
    setCheckingHealth(true);
    setOutput(prev => [...prev, '\n⏳ Waiting 15s for traces to land in Sentry…\n']);

    await new Promise(r => setTimeout(r, 15000));

    setOutput(prev => [...prev, '🔍 Running trace health check…\n']);

    try {
      const traceResult = await window.electronAPI.listRecentSentryTraceIds();
      if (!traceResult.success || !traceResult.traceIds?.length) {
        setOutput(prev => [...prev, '⚠️  No recent traces found in Sentry yet.\n']);
        setCheckingHealth(false);
        return;
      }

      const spansResult = await window.electronAPI.fetchSentryTraceSpans(traceResult.traceIds.slice(0, 5));
      if (!spansResult.success || !spansResult.spans?.length) {
        setOutput(prev => [...prev, '⚠️  Could not fetch span data from Sentry.\n']);
        setCheckingHealth(false);
        return;
      }

      const spans = spansResult.spans ?? [];
      const specSpans = currentProject.instrumentation?.spans ?? [];
      const stackType = currentProject.stack?.type ?? 'web';

      // Spec coverage: check if each expected span name/op appears in fetched spans
      const foundDescs = new Set(spans.map((s: any) => s.description).filter(Boolean));
      const foundOps = new Set(spans.map((s: any) => s.op).filter(Boolean));
      const covered = specSpans.filter((s: any) =>
        foundDescs.has(s.name) || foundDescs.has(s.op) || foundOps.has(s.op)
      );
      const coveragePct = specSpans.length > 0
        ? Math.round((covered.length / specSpans.length) * 100)
        : 100;

      // Distributed trace connectivity (web/mobile only)
      const hasFE = spans.some((s: any) => s.op === 'pageload' || s.op === 'navigation');
      const hasBE = spans.some((s: any) => s.op === 'http.server');
      const hasDistributed = stackType !== 'backend-only' ? (hasFE && hasBE) : true;

      // Unique traces
      const uniqueTraces = new Set(spans.map((s: any) => s.trace_id).filter(Boolean)).size;

      // Grade based on coverage
      let grade = 'A';
      if (coveragePct < 90) grade = 'B';
      if (coveragePct < 75) grade = 'C';
      if (coveragePct < 60) grade = 'D';
      if (coveragePct < 40) grade = 'F';
      if (!hasDistributed && stackType !== 'backend-only') grade = grade === 'A' ? 'B' : grade;

      setHealthReport({
        tracesFound: uniqueTraces,
        coveragePct,
        grade,
        coveredCount: covered.length,
        totalSpec: specSpans.length,
        hasDistributed,
        stackType,
        traceIds: traceResult.traceIds,
      });

      setOutput(prev => [...prev, `✅ Health check done — grade ${grade}, ${coveragePct}% span coverage.\n`]);
    } catch (err) {
      setOutput(prev => [...prev, `⚠️  Health check failed: ${err}\n`]);
    } finally {
      setCheckingHealth(false);
    }
  };

  const handleRun = async () => {
    if (!projectId) return;
    if (!config.frontendDsn && !config.backendDsn) {
      toast.warning('Select a Sentry project or add at least one DSN');
      return;
    }
    setRunning(true);
    setHealthReport(null);
    setErrors([]);
    setOutput(['Starting Live Data Generator…\n\n']);
    try {
      const result = await window.electronAPI.runLiveDataGenerator(projectId, config);
      if (result.success) {
        setOutput(prev => [...prev, '\nDone — check your Sentry dashboard.\n']);
        toast.success('Data generation complete');
        await loadProject(projectId);
        // Auto-run health check if Sentry is connected
        if (sentryAuth.authenticated) {
          setRunning(false);
          await runHealthCheck();
          return;
        }
      } else {
        setOutput(prev => [...prev, `\nFailed: ${result.error}\n`]);
      }
    } catch (error) {
      setOutput(prev => [...prev, `\nError: ${error}\n`]);
    } finally {
      setRunning(false);
    }
  };

  const handleStop = async () => {
    await window.electronAPI.stopLiveDataGenerator();
    setOutput(prev => [...prev, '\nStopped.\n']);
    setRunning(false);
  };

  if (!currentProject) return <div className="p-8 text-white/50 text-sm">Loading…</div>;

  const hasOutput = output.length > 0 || errors.length > 0;
  const gradeColor = (g: string) => ({
    A: 'text-green-400', B: 'text-blue-400', C: 'text-yellow-400', D: 'text-orange-400', F: 'text-red-400'
  }[g] ?? 'text-white');

  return (
    <div className="h-full flex overflow-hidden">

      {/* ── Left: Config panel ── */}
      <div className="w-72 shrink-0 border-r border-sentry-border flex flex-col">
        <div className="flex-1 overflow-y-auto px-5 py-6 space-y-5">

          <div>
            <h1 className="text-sm font-semibold text-white">Run Data Generator</h1>
            <p className="text-xs text-white/35 mt-0.5">Generate live traces using real Sentry SDKs</p>
          </div>

          <div className="border-t border-sentry-border" />

          {/* DSN picker */}
          <div className="space-y-3">
            <p className="text-xs font-medium text-white/55">Sentry Project</p>

            {sentryAuth.authenticated && (sentryAuth.orgs?.length ?? 0) === 0 ? (
              /* Authenticated but no orgs stored — stale token, prompt reconnect */
              <div className="space-y-2">
                <div className="text-[11px] text-yellow-400/80 bg-yellow-900/15 border border-yellow-700/30 rounded-lg px-3 py-2">
                  Sentry is connected but org info is missing. Please disconnect and reconnect in Settings.
                </div>
                <button
                  className="text-[11px] text-sentry-purple-400 hover:text-sentry-purple-300"
                  onClick={async () => {
                    await window.electronAPI.logoutSentry();
                    setSentryAuth({ authenticated: false });
                    setShowManualDsn(true);
                  }}
                >
                  Disconnect and reconnect →
                </button>
              </div>
            ) : sentryAuth.authenticated ? (
              <>
                {(sentryAuth.orgs?.length ?? 0) > 1 && (
                  <select
                    className="w-full bg-sentry-surface border border-sentry-border rounded-lg px-3 py-2 text-xs text-white/80 focus:outline-none focus:border-sentry-purple-500"
                    value={selectedOrg}
                    onChange={e => handleOrgChange(e.target.value)}
                  >
                    {sentryAuth.orgs?.map(org => (
                      <option key={org.slug} value={org.slug}>{org.name}</option>
                    ))}
                  </select>
                )}

                <div className="rounded-lg border border-sentry-border overflow-hidden">
                  {loadingProjects ? (
                    <div className="px-3 py-3 text-xs text-white/30">Loading projects…</div>
                  ) : projects.length === 0 ? (
                    <div className="px-3 py-3 text-xs text-white/30">
                      No projects found. The Demo Workbench integration may not be installed in this org.
                    </div>
                  ) : (
                    <div className="max-h-48 overflow-y-auto divide-y divide-sentry-border">
                      {projects.map(project => {
                        const isSelected = selectedProject?.slug === project.slug;
                        return (
                          <button
                            key={project.slug}
                            onClick={() => handleSelectProject(project)}
                            disabled={loadingDsn}
                            className={`w-full flex items-center justify-between px-3 py-2.5 text-left transition-colors ${
                              isSelected
                                ? 'bg-sentry-purple-500/20 text-white'
                                : 'text-white/65 hover:bg-white/5 hover:text-white'
                            }`}
                          >
                            <div className="flex items-center gap-2 min-w-0">
                              {isSelected && <CheckCircle2 size={11} className="text-sentry-purple-400 shrink-0" />}
                              <span className="text-xs truncate">{project.name}</span>
                            </div>
                            {project.platform && (
                              <span className="text-[10px] text-white/25 font-mono ml-2 shrink-0">{project.platform}</span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                <button
                  className="flex items-center gap-1.5 text-[11px] text-white/25 hover:text-white/50 transition-colors"
                  onClick={() => loadProjects(selectedOrg)}
                  disabled={loadingProjects}
                >
                  <RefreshCw size={10} className={loadingProjects ? 'animate-spin' : ''} />
                  Refresh
                </button>

                {loadingDsn && <p className="text-[11px] text-white/35">Fetching DSN…</p>}
                {selectedProject && !loadingDsn && (config.frontendDsn || config.backendDsn) && (
                  <div className="flex items-center gap-1.5 text-[11px] text-green-400">
                    <CheckCircle2 size={11} />
                    DSN loaded from <span className="font-medium">{selectedProject.name}</span>
                  </div>
                )}

                <button
                  className="flex items-center gap-1 text-[11px] text-white/25 hover:text-white/50 transition-colors"
                  onClick={() => setShowManualDsn(v => !v)}
                >
                  {showManualDsn ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                  Enter DSN manually
                </button>

                {showManualDsn && (
                  <div className="space-y-2">
                    <Input
                      label="Frontend DSN"
                      placeholder="https://…@sentry.io/…"
                      value={config.frontendDsn}
                      onChange={e => setConfig({ ...config, frontendDsn: e.target.value })}
                    />
                    <Input
                      label="Backend DSN"
                      placeholder="https://…@sentry.io/…"
                      value={config.backendDsn}
                      onChange={e => setConfig({ ...config, backendDsn: e.target.value })}
                    />
                    <p className="text-[11px] text-white/25">Both can use the same DSN</p>
                  </div>
                )}
              </>
            ) : (
              /* Not authenticated */
              <div className="space-y-3">
                <div className="text-[11px] text-white/35 bg-white/3 border border-sentry-border rounded-lg px-3 py-2">
                  Connect Sentry in Settings to pick a project automatically.
                </div>
                <Input
                  label="Frontend DSN"
                  placeholder="https://…@sentry.io/…"
                  value={config.frontendDsn}
                  onChange={e => setConfig({ ...config, frontendDsn: e.target.value })}
                />
                <Input
                  label="Backend DSN"
                  placeholder="https://…@sentry.io/…"
                  value={config.backendDsn}
                  onChange={e => setConfig({ ...config, backendDsn: e.target.value })}
                />
                <p className="text-[11px] text-white/25">Both can use the same DSN</p>
              </div>
            )}
          </div>

          <div className="border-t border-sentry-border" />

          {/* Volume */}
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Input
                label="Traces"
                type="number"
                min="1"
                value={config.numTraces}
                onChange={e => setConfig({ ...config, numTraces: parseInt(e.target.value) || 10 })}
              />
              <Input
                label="Errors"
                type="number"
                min="0"
                value={config.numErrors}
                onChange={e => setConfig({ ...config, numErrors: parseInt(e.target.value) || 5 })}
              />
            </div>
            <Input
              label="Environment"
              value={config.environment}
              onChange={e => setConfig({ ...config, environment: e.target.value })}
            />
          </div>
        </div>

        {/* Actions */}
        <div className="px-5 py-4 border-t border-sentry-border space-y-2">
          {running ? (
            <Button variant="secondary" size="lg" fullWidth onClick={handleStop}>
              <Square size={13} /> Stop
            </Button>
          ) : (
            <Button size="lg" fullWidth onClick={handleRun} disabled={checkingHealth}>
              <Play size={13} /> Run Generator
            </Button>
          )}
          {hasOutput && !running && !checkingHealth && errors.length > 0 && (
            <Button variant="ghost" size="md" fullWidth onClick={() => setShowChat(true)}>
              <HelpCircle size={13} /> Ask AI for help
            </Button>
          )}
        </div>
      </div>

      {/* ── Right: Terminal + health report ── */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Terminal header */}
        <div className="px-5 py-3 border-b border-sentry-border flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2 text-xs text-white/40">
            <Terminal size={13} />
            <span className="font-medium text-white/60">Output</span>
            {(running || checkingHealth) && (
              <span className="flex items-center gap-1.5 text-sentry-purple-400 ml-1">
                <span className="w-1.5 h-1.5 rounded-full bg-sentry-purple-400 animate-pulse" />
                {checkingHealth ? 'Checking health…' : 'Running'}
              </span>
            )}
            {errors.length > 0 && !running && !checkingHealth && (
              <span className="text-sentry-pink ml-1">{errors.length} error{errors.length !== 1 ? 's' : ''}</span>
            )}
          </div>
          {hasOutput && (
            <button
              onClick={() => { setOutput([]); setErrors([]); setHealthReport(null); }}
              disabled={running || checkingHealth}
              className="text-white/20 hover:text-white/50 disabled:opacity-30 transition-colors"
            >
              <Trash2 size={13} />
            </button>
          )}
        </div>

        {/* Terminal output */}
        <div ref={outputRef} className="flex-1 p-5 bg-sentry-background font-mono text-xs overflow-y-auto">
          {output.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-white/12 select-none">
              <Terminal size={28} className="mb-2 opacity-20" />
              <p>Output will appear here</p>
            </div>
          ) : (
            <div className="space-y-px">
              {output.map((line, idx) => {
                const isError = line.includes('ERROR') || line.includes('Failed') || line.includes('Error:');
                const isDone = line.includes('Done') || line.includes('Complete') || line.includes('✅');
                return (
                  <div key={idx} className={`leading-relaxed ${
                    isError ? 'text-sentry-pink/80' : isDone ? 'text-green-400' : 'text-white/50'
                  }`}>{line}</div>
                );
              })}
            </div>
          )}
        </div>

        {/* Health report card */}
        {healthReport && (
          <div className="shrink-0 border-t border-sentry-border p-4">
            <div className="flex items-start gap-4">
              {/* Grade */}
              <div className="text-center shrink-0">
                <div className={`text-4xl font-bold leading-none ${gradeColor(healthReport.grade)}`}>
                  {healthReport.grade}
                </div>
                <div className="text-[10px] text-white/35 mt-1">Grade</div>
              </div>

              {/* Stats */}
              <div className="flex-1 grid grid-cols-3 gap-3">
                <Stat label="Traces" value={String(healthReport.tracesFound)} />
                <Stat
                  label="Span Coverage"
                  value={`${healthReport.coveragePct}%`}
                  sub={`${healthReport.coveredCount}/${healthReport.totalSpec} spans`}
                />
                {healthReport.stackType !== 'backend-only' && (
                  <Stat
                    label="FE→BE Links"
                    value={healthReport.hasDistributed ? '✓' : '✗'}
                    ok={healthReport.hasDistributed}
                  />
                )}
              </div>

              {/* Deep analysis link */}
              <button
                onClick={() => navigate(`/project/${projectId}/trace-health`)}
                className="flex items-center gap-1.5 text-xs text-sentry-purple-400 hover:text-sentry-purple-300 shrink-0"
              >
                <Activity size={13} />
                Deep Analysis
                <ExternalLink size={11} />
              </button>
            </div>
          </div>
        )}
      </div>

      {showChat && projectId && (
        <TroubleshootingChat
          context={{ phase: 'data-generation', projectId, errors, output }}
          onClose={() => setShowChat(false)}
        />
      )}
    </div>
  );
}

function Stat({ label, value, sub, ok }: { label: string; value: string; sub?: string; ok?: boolean }) {
  const valueColor = ok === undefined ? 'text-white' : ok ? 'text-green-400' : 'text-red-400';
  return (
    <div>
      <div className={`text-sm font-semibold ${valueColor}`}>{value}</div>
      <div className="text-[10px] text-white/40">{label}</div>
      {sub && <div className="text-[10px] text-white/25">{sub}</div>}
    </div>
  );
}
