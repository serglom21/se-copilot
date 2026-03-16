import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Zap, FileText, BarChart2, Database, Upload, Package, ExternalLink, CheckCircle2 } from 'lucide-react';
import { useProjectStore } from '../store/project-store';
import Button from '../components/Button';
import DashboardPreview from '../components/DashboardPreview';
import { toast } from '../store/toast-store';

type ArtifactStatus = { generated: boolean; loading: boolean; path: string };

export default function GeneratePage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const { currentProject, loadProject, generateApp, generateGuide, generateDashboard, generateDataScript } = useProjectStore();

  const [status, setStatus] = useState({
    app: { generated: false, loading: false, path: '' } as ArtifactStatus,
    guide: { generated: false, loading: false, path: '' } as ArtifactStatus,
    dashboard: { generated: false, loading: false, path: '' } as ArtifactStatus,
    dataScript: { generated: false, loading: false, path: '' } as ArtifactStatus,
  });

  const [pushingDashboard, setPushingDashboard] = useState(false);
  const [dashboardPushResult, setDashboardPushResult] = useState<{ success: boolean; dashboardUrl?: string; error?: string } | null>(null);
  const [exporting, setExporting] = useState(false);
  const [generateAllLoading, setGenerateAllLoading] = useState(false);

  useEffect(() => {
    if (projectId) loadProject(projectId);
  }, [projectId]);

  useEffect(() => {
    const load = async () => {
      if (currentProject && (currentProject.status === 'generated' || currentProject.status === 'published')) {
        const outputPath = await window.electronAPI.getOutputPath(currentProject.id);
        setStatus({
          app: { generated: true, loading: false, path: outputPath },
          guide: { generated: true, loading: false, path: `${outputPath}/IMPLEMENTATION_GUIDE.md` },
          dashboard: { generated: true, loading: false, path: `${outputPath}/sentry-dashboard.json` },
          dataScript: { generated: true, loading: false, path: `${outputPath}/generate_data.py` },
        });
      }
    };
    load();
  }, [currentProject?.id, currentProject?.status]);

  const handleGenerateApp = async () => {
    setStatus(s => ({ ...s, app: { ...s.app, loading: true } }));
    try {
      const result = await generateApp();
      if (!result.success) throw new Error(result.error);
      setStatus(s => ({ ...s, app: { generated: true, loading: false, path: result.outputPath || '' } }));
      if (currentProject) {
        await window.electronAPI.updateProject(currentProject.id, { status: 'generated' });
        await loadProject(currentProject.id);
      }
      toast.success('Reference app generated');
    } catch (error) {
      toast.error('Failed to generate app: ' + error);
      setStatus(s => ({ ...s, app: { ...s.app, loading: false } }));
    }
  };

  const handleGenerateGuide = async () => {
    setStatus(s => ({ ...s, guide: { ...s.guide, loading: true } }));
    try {
      const result = await generateGuide();
      if (!result.success) throw new Error(result.error);
      setStatus(s => ({ ...s, guide: { generated: true, loading: false, path: result.outputPath || '' } }));
      toast.success('Implementation guide generated');
    } catch (error) {
      toast.error('Failed to generate guide: ' + error);
      setStatus(s => ({ ...s, guide: { ...s.guide, loading: false } }));
    }
  };

  const handleGenerateDashboard = async () => {
    setStatus(s => ({ ...s, dashboard: { ...s.dashboard, loading: true } }));
    try {
      const result = await generateDashboard();
      if (!result.success) throw new Error(result.error);
      setStatus(s => ({ ...s, dashboard: { generated: true, loading: false, path: result.outputPath || '' } }));
      toast.success('Dashboard JSON generated');
    } catch (error) {
      toast.error('Failed to generate dashboard: ' + error);
      setStatus(s => ({ ...s, dashboard: { ...s.dashboard, loading: false } }));
    }
  };

  const handleGenerateDataScript = async () => {
    setStatus(s => ({ ...s, dataScript: { ...s.dataScript, loading: true } }));
    try {
      const result = await generateDataScript();
      if (!result.success) throw new Error(result.error);
      setStatus(s => ({ ...s, dataScript: { generated: true, loading: false, path: result.outputPath || '' } }));
      toast.success('Data generation script created');
    } catch (error) {
      toast.error('Failed to generate data script: ' + error);
      setStatus(s => ({ ...s, dataScript: { ...s.dataScript, loading: false } }));
    }
  };

  const handlePushDashboardToSentry = async () => {
    if (!currentProject) return;
    setPushingDashboard(true);
    setDashboardPushResult(null);
    try {
      const result = await window.electronAPI.createSentryDashboard(
        currentProject.id,
        `${currentProject.project.name} - Performance Dashboard`
      );
      setDashboardPushResult(result);
      if (result.success) toast.success('Dashboard pushed to Sentry');
      else throw new Error(result.error);
    } catch (error) {
      toast.error('Failed to push dashboard: ' + error);
    } finally {
      setPushingDashboard(false);
    }
  };

  const handleGenerateAll = async () => {
    setGenerateAllLoading(true);
    setStatus({ app: { generated: false, loading: true, path: '' }, guide: { generated: false, loading: true, path: '' }, dashboard: { generated: false, loading: true, path: '' }, dataScript: { generated: false, loading: true, path: '' } });
    try {
      const [appR, guideR, dashR, dataR] = await Promise.allSettled([generateApp(), generateGuide(), generateDashboard(), generateDataScript()]);
      setStatus({
        app: { generated: appR.status === 'fulfilled' && appR.value.success, loading: false, path: appR.status === 'fulfilled' ? (appR.value.outputPath || '') : '' },
        guide: { generated: guideR.status === 'fulfilled' && guideR.value.success, loading: false, path: guideR.status === 'fulfilled' ? (guideR.value.outputPath || '') : '' },
        dashboard: { generated: dashR.status === 'fulfilled' && dashR.value.success, loading: false, path: dashR.status === 'fulfilled' ? (dashR.value.outputPath || '') : '' },
        dataScript: { generated: dataR.status === 'fulfilled' && dataR.value.success, loading: false, path: dataR.status === 'fulfilled' ? (dataR.value.outputPath || '') : '' },
      });
      if (currentProject) {
        await window.electronAPI.updateProject(currentProject.id, { status: 'generated' });
        await loadProject(currentProject.id);
      }
      toast.success('All artifacts generated');
    } catch (error) {
      toast.error('Generation error: ' + error);
    } finally {
      setGenerateAllLoading(false);
    }
  };

  const handleExportDemoPackage = async () => {
    if (!currentProject) return;
    setExporting(true);
    try {
      const result = await window.electronAPI.exportDemoPackage(currentProject.id);
      if (!result.success) throw new Error(result.error);
      toast.success(`Demo package exported to ${result.outputPath}`);
    } catch (error) {
      toast.error('Export failed: ' + error);
    } finally {
      setExporting(false);
    }
  };

  const allGenerated = status.app.generated && status.guide.generated && status.dashboard.generated && status.dataScript.generated;

  if (!currentProject) return <div className="p-8 text-white/50 text-sm">Loading…</div>;

  return (
    <div className="p-8 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-white">Generate Artifacts</h1>
          <p className="text-sm text-white/45 mt-0.5">Reference app, implementation guide, and dashboard JSON</p>
        </div>
        <div className="flex items-center gap-2">
          {currentProject.project.githubRepoUrl && (
            <Button size="sm" variant="ghost" onClick={() => window.electronAPI.openInChrome(currentProject.project.githubRepoUrl!)}>
              <ExternalLink size={13} /> GitHub
            </Button>
          )}
          <Button onClick={handleGenerateAll} disabled={generateAllLoading}>
            <Zap size={14} /> {generateAllLoading ? 'Generating…' : 'Generate All'}
          </Button>
        </div>
      </div>

      {/* Project summary */}
      <div className="border border-sentry-border rounded-lg p-4 mb-5 bg-sentry-surface">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
          <SummaryItem label="Name" value={currentProject.project.name} />
          <SummaryItem label="Vertical" value={currentProject.project.vertical} />
          <SummaryItem label="Stack" value={stackLabel(currentProject.stack)} />
          <SummaryItem label="Custom Spans" value={String(currentProject.instrumentation.spans.length)} />
        </div>
      </div>

      {/* Artifact cards */}
      <div className="space-y-3 mb-5">
        <ArtifactCard
          icon={<Zap size={18} className="text-sentry-purple-400" />}
          title="Reference Application"
          description="Next.js frontend + Express backend with Sentry SDK and custom instrumentation"
          status={status.app}
          onGenerate={handleGenerateApp}
        />
        <ArtifactCard
          icon={<FileText size={18} className="text-sentry-purple-400" />}
          title="Implementation Guide"
          description="Markdown documentation explaining the instrumentation and how to validate it"
          status={status.guide}
          onGenerate={handleGenerateGuide}
        />

        {/* Dashboard card — has extra push-to-sentry action */}
        <div className="border border-sentry-border rounded-lg p-4 bg-sentry-surface">
          <div className="flex items-start justify-between">
            <div className="flex items-start gap-3 flex-1 min-w-0">
              <div className="mt-0.5 shrink-0"><BarChart2 size={18} className="text-sentry-purple-400" /></div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold text-white">Dashboard JSON</h3>
                  {status.dashboard.generated && <CheckCircle2 size={14} className="text-green-400" />}
                </div>
                <p className="text-xs text-white/45 mt-0.5">Sentry dashboard configuration based on your instrumentation plan</p>
                {status.dashboard.generated && status.dashboard.path && (
                  <p className="text-xs text-white/30 mt-1 font-mono truncate">{status.dashboard.path}</p>
                )}
                {dashboardPushResult?.success && dashboardPushResult.dashboardUrl && (
                  <button
                    onClick={() => window.electronAPI.openInChrome(dashboardPushResult.dashboardUrl!)}
                    className="text-xs text-sentry-purple-400 hover:text-sentry-purple-300 mt-1 flex items-center gap-1"
                  >
                    <ExternalLink size={11} /> View in Sentry
                  </button>
                )}
              </div>
            </div>
            <div className="flex flex-col gap-1.5 shrink-0 ml-4">
              <Button
                size="sm"
                onClick={handleGenerateDashboard}
                disabled={status.dashboard.loading}
                variant={status.dashboard.generated ? 'secondary' : 'primary'}
              >
                {status.dashboard.loading ? 'Generating…' : status.dashboard.generated ? 'Regenerate' : 'Generate'}
              </Button>
              {status.dashboard.generated && (
                <Button size="sm" variant="secondary" onClick={handlePushDashboardToSentry} disabled={pushingDashboard}>
                  <Upload size={12} /> {pushingDashboard ? 'Pushing…' : 'Push to Sentry'}
                </Button>
              )}
            </div>
          </div>
        </div>

        <ArtifactCard
          icon={<Database size={18} className="text-sentry-purple-400" />}
          title="Data Generation Script"
          description="Python script to generate realistic test data with custom spans and attributes"
          status={status.dataScript}
          onGenerate={handleGenerateDataScript}
        />
      </div>

      {/* Dashboard Preview */}
      {status.dashboard.generated && status.dashboard.path && (
        <div className="border border-sentry-border rounded-lg p-5 mb-5 bg-sentry-surface">
          <h3 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
            <BarChart2 size={15} className="text-sentry-purple-400" /> Dashboard Preview
          </h3>
          <DashboardPreview dashboardPath={status.dashboard.path} />
        </div>
      )}

      {/* Bottom actions */}
      {allGenerated && (
        <div className="flex gap-3">
          <Button size="lg" variant="secondary" onClick={handleExportDemoPackage} disabled={exporting}>
            <Package size={14} /> {exporting ? 'Exporting…' : 'Export Demo Package'}
          </Button>
          <Button size="lg" onClick={() => navigate(`/project/${currentProject.id}/publish`)}>
            Next: Publish →
          </Button>
        </div>
      )}
    </div>
  );
}

function SummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] text-white/35 uppercase tracking-wide mb-0.5">{label}</div>
      <div className="text-sm text-white/80 capitalize">{value}</div>
    </div>
  );
}

function stackLabel(stack: any) {
  if (!stack) return '—';
  if (stack.type === 'web') return 'Next.js + Express';
  if (stack.type === 'mobile') return 'React Native';
  if (stack.type === 'backend-only') return stack.backend === 'fastapi' ? 'FastAPI' : 'Flask';
  return stack.type;
}

function ArtifactCard({ icon, title, description, status, onGenerate }: {
  icon: React.ReactNode;
  title: string;
  description: string;
  status: ArtifactStatus;
  onGenerate: () => void;
}) {
  return (
    <div className="border border-sentry-border rounded-lg p-4 bg-sentry-surface flex items-start justify-between gap-4">
      <div className="flex items-start gap-3 flex-1 min-w-0">
        <div className="mt-0.5 shrink-0">{icon}</div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-white">{title}</h3>
            {status.generated && <CheckCircle2 size={14} className="text-green-400" />}
          </div>
          <p className="text-xs text-white/45 mt-0.5">{description}</p>
          {status.generated && status.path && (
            <p className="text-xs text-white/25 mt-1 font-mono truncate">{status.path}</p>
          )}
        </div>
      </div>
      <Button
        size="sm"
        onClick={onGenerate}
        disabled={status.loading}
        variant={status.generated ? 'secondary' : 'primary'}
        className="shrink-0"
      >
        {status.loading ? 'Generating…' : status.generated ? 'Regenerate' : 'Generate'}
      </Button>
    </div>
  );
}
