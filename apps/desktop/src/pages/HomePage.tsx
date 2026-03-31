import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import * as Sentry from '@sentry/react';
import { Plus, FolderOpen, Github, Upload, Trash2, ExternalLink, MoreHorizontal, Loader2 } from 'lucide-react';
import { useProjectStore } from '../store/project-store';
import Button from '../components/Button';
import { Input } from '../components/Input';
import { toast } from '../store/toast-store';

const STATUS_DOT: Record<string, string> = {
  draft: 'bg-white/30',
  planning: 'bg-blue-400',
  locked: 'bg-yellow-400',
  generated: 'bg-green-400',
  published: 'bg-sentry-purple-400',
};

type UploadStatus = {
  projectName: string;
  organization: string;
  dataGenerationStatus: 'pending' | 'in-progress' | 'done' | 'error';
  dashboardUploadStatus: 'pending' | 'in-progress' | 'done' | 'error';
  dashboardUrl?: string;
  error?: string;
  batch?: { current: number; total: number };
};

export default function HomePage() {
  const navigate = useNavigate();
  const { projects, loadProjects, setCurrentProject, deleteProject } = useProjectStore();
  const [uploadingDashboard, setUploadingDashboard] = useState<string | null>(null);
  const [uploadStatus, setUploadStatus] = useState<UploadStatus | null>(null);
  const [credentialsPrompt, setCredentialsPrompt] = useState<{ projectId: string; projectName: string } | null>(null);
  const [credentials, setCredentials] = useState({ authToken: '', organization: '', dsn: '' });
  const [menuOpen, setMenuOpen] = useState<string | null>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null);
  const [deletingProjectId, setDeletingProjectId] = useState<string | null>(null);

  useEffect(() => {
    loadProjects();
  }, []);

  // Pre-fill credentials from Settings on mount
  useEffect(() => {
    window.electronAPI.getSettings?.().then((s: any) => {
      if (s?.sentry?.authToken || s?.sentry?.organization) {
        setCredentials(c => ({
          ...c,
          authToken: s.sentry.authToken || c.authToken,
          organization: s.sentry.organization || c.organization,
        }));
      }
    }).catch(() => {});
  }, []);

  const handleOpenProject = (project: any) => {
    setCurrentProject(project);
    navigate(`/project/${project.id}/plan`);
  };

  const handleDeleteProject = async (projectId: string) => {
    if (confirm('Delete this project? This cannot be undone.')) {
      setMenuOpen(null);
      setMenuPos(null);
      setDeletingProjectId(projectId);
      try {
        await deleteProject(projectId);
      } finally {
        setDeletingProjectId(null);
      }
    }
  };

  const handleUploadDashboard = (project: any) => {
    setCredentialsPrompt({ projectId: project.id, projectName: project.project.name });
    setMenuOpen(null);
  };

  const handleConfirmUpload = async () => {
    if (!credentialsPrompt) return;
    if (!credentials.authToken.trim() || !credentials.organization.trim()) {
      toast.error('Auth Token and Organization are required');
      return;
    }

    const { projectId, projectName } = credentialsPrompt;
    setCredentialsPrompt(null);
    setUploadingDashboard(projectId);
    setUploadStatus({
      projectName,
      organization: credentials.organization,
      dataGenerationStatus: 'in-progress',
      dashboardUploadStatus: 'pending',
    });

    try {
      if (credentials.dsn) {
        const BATCHES = 10;
        for (let batch = 1; batch <= BATCHES; batch++) {
          setUploadStatus(prev => prev ? { ...prev, batch: { current: batch, total: BATCHES } } : null);

          const dataResult = await window.electronAPI.runDataGenerator(projectId, {
            frontendDsn: credentials.dsn,
            backendDsn: credentials.dsn,
            numTraces: 100,
            numErrors: 10,
            environment: 'demo'
          });

          if (!dataResult.success) {
            throw new Error(`Batch ${batch} failed: ${dataResult.error}`);
          }
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        setUploadStatus(prev => prev ? { ...prev, dataGenerationStatus: 'done', dashboardUploadStatus: 'in-progress', batch: undefined } : null);
      } else {
        setUploadStatus(prev => prev ? { ...prev, dataGenerationStatus: 'done', dashboardUploadStatus: 'in-progress' } : null);
      }

      const uploadPromise = window.electronAPI.createSentryDashboard(
        projectId,
        `${projectName} - Performance Dashboard`,
        { authToken: credentials.authToken.trim(), organization: credentials.organization.trim() }
      );
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Upload timed out after 15 seconds')), 15000)
      );

      const result = await Promise.race([uploadPromise, timeoutPromise]) as any;

      if (result.success && result.dashboardUrl) {
        setUploadStatus(prev => prev ? { ...prev, dashboardUploadStatus: 'done', dashboardUrl: result.dashboardUrl } : null);
        toast.success('Dashboard uploaded to Sentry');
      } else {
        throw new Error(result.error || 'Upload failed');
      }
    } catch (error) {
      Sentry.captureException(error);
      const msg = error instanceof Error ? error.message : String(error);
      setUploadStatus(prev => {
        if (!prev) return null;
        return {
          ...prev,
          dataGenerationStatus: prev.dataGenerationStatus === 'in-progress' ? 'error' : prev.dataGenerationStatus,
          dashboardUploadStatus: prev.dashboardUploadStatus === 'in-progress' ? 'error' : prev.dashboardUploadStatus,
          error: msg,
        };
      });
    } finally {
      setUploadingDashboard(null);
    }
  };

  // Compute progress percent for the upload modal
  function computeUploadProgress(): number {
    if (!uploadStatus) return 0;
    const { dataGenerationStatus, dashboardUploadStatus, batch } = uploadStatus;
    const hasDsn = !!credentials.dsn;
    if (!hasDsn) {
      if (dashboardUploadStatus === 'in-progress') return 50;
      if (dashboardUploadStatus === 'done') return 100;
      return 0;
    }
    if (dataGenerationStatus === 'in-progress' && batch) {
      return Math.round((batch.current / batch.total) * 50);
    }
    if (dataGenerationStatus === 'done' && dashboardUploadStatus === 'in-progress') return 60;
    if (dashboardUploadStatus === 'done') return 100;
    return 0;
  }
  const uploadProgress = computeUploadProgress();

  return (
    <div className="p-8 max-w-5xl mx-auto" onClick={() => { setMenuOpen(null); setMenuPos(null); }}>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-white">Projects</h1>
          <p className="text-sm text-white/45 mt-0.5">Every great demo leaves a trace 🐾</p>
        </div>
        <Link to="/new">
          <Button size="md">
            <Plus size={15} /> New Project
          </Button>
        </Link>
      </div>

      {/* Empty state */}
      {projects.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 border border-sentry-border rounded-lg bg-sentry-surface/50">
          <FolderOpen size={48} className="text-white/20 mb-4" />
          <h3 className="text-base font-semibold text-white mb-1">No projects yet</h3>
          <p className="text-sm text-white/40 mb-6">Create your first project to get started</p>
          <Link to="/new">
            <Button size="md"><Plus size={15} /> Create Project</Button>
          </Link>
        </div>
      ) : (
        /* Project table */
        <div className="border border-sentry-border rounded-lg overflow-hidden">
          {/* Table header */}
          <div className="grid grid-cols-[1fr_120px_120px_90px_60px_110px] gap-4 px-4 py-2.5 bg-sentry-surface border-b border-sentry-border text-[11px] font-semibold text-white/35 uppercase tracking-wider">
            <span>Name</span>
            <span>Vertical</span>
            <span>Stack</span>
            <span>Status</span>
            <span>Spans</span>
            <span></span>
          </div>

          {/* Rows */}
          {projects.map((project, i) => (
            <div
              key={project.id}
              className={`grid grid-cols-[1fr_120px_120px_90px_60px_110px] gap-4 px-4 py-3 items-center transition-colors ${deletingProjectId === project.id ? 'opacity-50 pointer-events-none' : 'cursor-pointer hover:bg-white/3'} ${i < projects.length - 1 ? 'border-b border-sentry-border' : ''}`}
              onClick={() => deletingProjectId !== project.id && handleOpenProject(project)}
            >
              <span className="text-sm font-medium text-white truncate">{project.project.name}</span>
              <span className="text-sm text-white/55 capitalize">{project.project.vertical}</span>
              <span className="text-xs text-white/45">{stackLabel(project.stack)}</span>
              <span>
                <span className="flex items-center gap-1.5">
                  <span className={`w-2 h-2 rounded-full shrink-0 ${STATUS_DOT[project.status] || 'bg-white/30'}`} />
                  <span className="text-xs text-white/65 capitalize">{project.status}</span>
                </span>
              </span>
              <span className="text-sm text-white/55">{project.instrumentation.spans.length}</span>

              {/* Actions */}
              <div className="flex items-center gap-1.5" onClick={e => e.stopPropagation()}>
                {deletingProjectId === project.id ? (
                  <span className="flex items-center gap-1.5 text-xs text-white/40 px-1">
                    <Loader2 size={13} className="animate-spin" /> Deleting…
                  </span>
                ) : (
                <>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => { setCurrentProject(project); navigate(`/project/${project.id}/plan`); }}
                    title="Open project"
                  >
                    Open
                  </Button>
                  <div>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (menuOpen === project.id) {
                          setMenuOpen(null);
                          setMenuPos(null);
                        } else {
                          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                          setMenuPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
                          setMenuOpen(project.id);
                        }
                      }}
                    >
                      <MoreHorizontal size={14} />
                    </Button>
                  </div>
                </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Kebab menu — fixed so it escapes overflow-hidden table */}
      {menuOpen && menuPos && (() => {
        const project = projects.find(p => p.id === menuOpen);
        if (!project) return null;
        return (
          <div
            className="fixed z-50 w-44 bg-sentry-background-secondary border border-sentry-border rounded-lg shadow-sentry-lg py-1 text-sm"
            style={{ top: menuPos.top, right: menuPos.right }}
            onClick={e => e.stopPropagation()}
          >
            {project.project.githubRepoUrl && (
              <MenuEntry icon={<Github size={13} />} onClick={() => { window.electronAPI.openInChrome(project.project.githubRepoUrl!); setMenuOpen(null); }}>
                View on GitHub
              </MenuEntry>
            )}
            {(project.status === 'generated' || project.status === 'published') && (
              <MenuEntry
                icon={<Upload size={13} />}
                onClick={() => handleUploadDashboard(project)}
                disabled={uploadingDashboard === project.id}
              >
                {uploadingDashboard === project.id ? 'Uploading…' : 'Upload to Sentry'}
              </MenuEntry>
            )}
            <div className="border-t border-sentry-border my-1" />
            <MenuEntry icon={<Trash2 size={13} />} onClick={() => handleDeleteProject(project.id)} danger>
              Delete
            </MenuEntry>
          </div>
        );
      })()}

      {/* Credentials modal */}
      {credentialsPrompt && (
        <Modal title="Upload to Sentry" subtitle={credentialsPrompt.projectName} onClose={() => setCredentialsPrompt(null)}>
          <div className="space-y-4">
            <p className="text-sm text-white/55">
              Enter credentials for the Sentry org where you want to upload this dashboard.
              {credentials.authToken ? ' Your saved Settings credentials have been pre-filled.' : (
                <> Configure defaults in <Link to="/settings" className="text-sentry-purple-400 hover:underline">Settings</Link>.</>
              )}
            </p>

            <Input
              label="Sentry Auth Token"
              type="password"
              placeholder="sntrys_..."
              value={credentials.authToken}
              onChange={e => setCredentials(c => ({ ...c, authToken: e.target.value }))}
            />
            <Input
              label="Organization Slug"
              placeholder="my-organization"
              value={credentials.organization}
              onChange={e => setCredentials(c => ({ ...c, organization: e.target.value }))}
            />
            <Input
              label="Project DSN (optional — generates demo data)"
              placeholder="https://...@...ingest.us.sentry.io/..."
              value={credentials.dsn}
              onChange={e => setCredentials(c => ({ ...c, dsn: e.target.value }))}
            />

            <div className="flex gap-2 pt-2">
              <Button
                fullWidth
                onClick={handleConfirmUpload}
                disabled={!credentials.authToken.trim() || !credentials.organization.trim()}
              >
                <Upload size={14} /> Upload Dashboard
              </Button>
              <Button variant="secondary" onClick={() => setCredentialsPrompt(null)}>Cancel</Button>
            </div>
          </div>
        </Modal>
      )}

      {/* Upload status modal */}
      {uploadStatus && (
        <Modal
          title="Uploading to Sentry"
          subtitle={`${uploadStatus.projectName} → ${uploadStatus.organization}`}
          onClose={uploadStatus.dashboardUploadStatus !== 'in-progress' && uploadStatus.dataGenerationStatus !== 'in-progress' ? () => setUploadStatus(null) : undefined}
        >
          {/* Progress bar */}
          <div className="h-1 bg-sentry-border rounded-full overflow-hidden mb-5">
            <div
              className="h-full bg-sentry-gradient rounded-full transition-all duration-500"
              style={{ width: `${uploadProgress}%` }}
            />
          </div>

          <div className="space-y-3">
            <UploadStep
              title="Generate Demo Data"
              status={uploadStatus.dataGenerationStatus}
              detail={
                uploadStatus.dataGenerationStatus === 'in-progress' && uploadStatus.batch
                  ? `Batch ${uploadStatus.batch.current} / ${uploadStatus.batch.total}`
                  : uploadStatus.dataGenerationStatus === 'done'
                    ? '1,000 transactions + 100 errors generated'
                    : uploadStatus.dataGenerationStatus === 'error'
                      ? uploadStatus.error
                      : credentials.dsn ? 'Waiting…' : 'Skipped (no DSN provided)'
              }
            />
            <UploadStep
              title="Upload Dashboard"
              status={uploadStatus.dashboardUploadStatus}
              detail={
                uploadStatus.dashboardUploadStatus === 'done' ? 'Dashboard created successfully' :
                uploadStatus.dashboardUploadStatus === 'in-progress' ? 'Creating dashboard widgets…' :
                uploadStatus.dashboardUploadStatus === 'error' ? uploadStatus.error :
                'Waiting…'
              }
            />
          </div>

          <div className="flex gap-2 mt-5">
            {uploadStatus.dashboardUploadStatus === 'done' && uploadStatus.dashboardUrl && (
              <Button fullWidth onClick={() => window.electronAPI.openInChrome(uploadStatus.dashboardUrl!)}>
                <ExternalLink size={14} /> Open Dashboard
              </Button>
            )}
            {(uploadStatus.dataGenerationStatus === 'error' || uploadStatus.dashboardUploadStatus === 'error' || uploadStatus.dashboardUploadStatus === 'done') && (
              <Button variant="secondary" onClick={() => setUploadStatus(null)}>Close</Button>
            )}
            {(uploadStatus.dataGenerationStatus === 'in-progress' || uploadStatus.dashboardUploadStatus === 'in-progress') && (
              <Button variant="ghost" onClick={() => setUploadStatus(null)}>Cancel</Button>
            )}
          </div>
        </Modal>
      )}
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

function MenuEntry({ icon, onClick, danger, disabled, children }: {
  icon: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      className={`w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors ${
        disabled ? 'opacity-40 cursor-not-allowed' :
        danger ? 'text-sentry-pink hover:bg-sentry-pink/10' :
        'text-white/70 hover:bg-white/5 hover:text-white'
      }`}
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
    >
      {icon} {children}
    </button>
  );
}

function Modal({ title, subtitle, onClose, children }: {
  title: string;
  subtitle?: string;
  onClose?: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4 z-50" onClick={onClose}>
      <div className="bg-sentry-background-secondary border border-sentry-border rounded-xl max-w-lg w-full shadow-sentry-lg" onClick={e => e.stopPropagation()}>
        <div className="border-b border-sentry-border px-5 py-4">
          <div className="text-base font-semibold text-white">{title}</div>
          {subtitle && <div className="text-xs text-white/40 mt-0.5">{subtitle}</div>}
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

function UploadStep({ title, status, detail }: { title: string; status: string; detail?: string | null }) {
  const icon = status === 'done' ? '●' : status === 'in-progress' ? '○' : status === 'error' ? '✕' : '–';
  const color = status === 'done' ? 'text-green-400' : status === 'in-progress' ? 'text-sentry-purple-400 animate-pulse' : status === 'error' ? 'text-sentry-pink' : 'text-white/20';
  return (
    <div className="flex items-start gap-3 p-3 rounded-lg bg-sentry-surface border border-sentry-border">
      <span className={`text-sm font-bold mt-0.5 ${color}`}>{icon}</span>
      <div>
        <div className="text-sm font-medium text-white">{title}</div>
        {detail && <div className="text-xs text-white/45 mt-0.5">{detail}</div>}
      </div>
    </div>
  );
}
