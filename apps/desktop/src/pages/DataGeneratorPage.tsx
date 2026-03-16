import { useState, useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { Play, Square, Trash2, HelpCircle, Terminal } from 'lucide-react';
import { useProjectStore } from '../store/project-store';
import { Input } from '../components/Input';
import Button from '../components/Button';
import TroubleshootingChat from '../components/TroubleshootingChat';
import { toast } from '../store/toast-store';

export default function DataGeneratorPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const { currentProject, loadProject } = useProjectStore();

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

  useEffect(() => {
    if (projectId) loadProject(projectId);
  }, [projectId, loadProject]);

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

  const handleRun = async () => {
    if (!projectId) return;
    if (!config.frontendDsn && !config.backendDsn) {
      toast.warning('Add at least one Sentry DSN');
      return;
    }
    setRunning(true);
    setErrors([]);
    setOutput(['Starting Live Data Generator…\n\n']);
    try {
      const result = await window.electronAPI.runLiveDataGenerator(projectId, config);
      if (result.success) {
        setOutput(prev => [...prev, '\nDone — check your Sentry dashboard.\n']);
        toast.success('Data generation complete');
        await loadProject(projectId);
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

  return (
    <div className="h-full flex overflow-hidden">

      {/* ── Left: Config panel ── */}
      <div className="w-72 shrink-0 border-r border-sentry-border flex flex-col">
        <div className="flex-1 overflow-y-auto px-5 py-6 space-y-5">

          {/* Header */}
          <div>
            <h1 className="text-sm font-semibold text-white">Run Data Generator</h1>
            <p className="text-xs text-white/35 mt-0.5">Generate live traces using real Sentry SDKs</p>
          </div>

          <div className="border-t border-sentry-border" />

          {/* DSN inputs */}
          <div className="space-y-3">
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
            <Button size="lg" fullWidth onClick={handleRun}>
              <Play size={13} /> Run Generator
            </Button>
          )}
          {hasOutput && !running && errors.length > 0 && (
            <Button variant="ghost" size="md" fullWidth onClick={() => setShowChat(true)}>
              <HelpCircle size={13} /> Ask AI for help
            </Button>
          )}
        </div>
      </div>

      {/* ── Right: Terminal output ── */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="px-5 py-3 border-b border-sentry-border flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2 text-xs text-white/40">
            <Terminal size={13} />
            <span className="font-medium text-white/60">Output</span>
            {running && (
              <span className="flex items-center gap-1.5 text-sentry-purple-400 ml-1">
                <span className="w-1.5 h-1.5 rounded-full bg-sentry-purple-400 animate-pulse" />
                Running
              </span>
            )}
            {errors.length > 0 && !running && (
              <span className="text-sentry-pink ml-1">{errors.length} error{errors.length !== 1 ? 's' : ''}</span>
            )}
          </div>
          {hasOutput && (
            <button
              onClick={() => { setOutput([]); setErrors([]); }}
              disabled={running}
              className="text-white/20 hover:text-white/50 disabled:opacity-30 transition-colors"
            >
              <Trash2 size={13} />
            </button>
          )}
        </div>

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
                const isDone = line.includes('Done') || line.includes('Complete');
                return (
                  <div key={idx} className={`leading-relaxed ${
                    isError ? 'text-sentry-pink/80' : isDone ? 'text-green-400' : 'text-white/50'
                  }`}>{line}</div>
                );
              })}
            </div>
          )}
        </div>
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
