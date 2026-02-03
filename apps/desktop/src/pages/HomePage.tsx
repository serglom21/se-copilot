import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import * as Sentry from '@sentry/react';
import { useProjectStore } from '../store/project-store';
import Button from '../components/Button';
import { Input } from '../components/Input';

type UploadStatus = {
  projectName: string;
  organization: string;
  dataGenerationStatus: 'pending' | 'in-progress' | 'done' | 'error';
  dashboardUploadStatus: 'pending' | 'in-progress' | 'done' | 'error';
  dashboardUrl?: string;
  error?: string;
};

export default function HomePage() {
  const { projects, loadProjects, setCurrentProject, deleteProject } = useProjectStore();
  const [uploadingDashboard, setUploadingDashboard] = useState<string | null>(null);
  const [uploadStatus, setUploadStatus] = useState<UploadStatus | null>(null);
  const [sentryCredentialsPrompt, setSentryCredentialsPrompt] = useState<{ projectId: string; projectName: string } | null>(null);
  const [sentryCredentials, setSentryCredentials] = useState({ authToken: '', organization: '', dsn: '' });

  useEffect(() => {
    loadProjects();
  }, []);

  const handleOpenProject = (project: any) => {
    setCurrentProject(project);
  };

  const handleDeleteProject = async (projectId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirm('Are you sure you want to delete this project?')) {
      await deleteProject(projectId);
    }
  };

  const handleUploadDashboard = async (project: any, e: React.MouseEvent) => {
    e.stopPropagation();

    // Show credentials prompt
    setSentryCredentials({ authToken: '', organization: '' });
    setSentryCredentialsPrompt({
      projectId: project.id,
      projectName: project.project.name
    });
  };

  const handleConfirmUpload = async () => {
    if (!sentryCredentialsPrompt) return;

    if (!sentryCredentials.authToken.trim() || !sentryCredentials.organization.trim()) {
      alert('Please provide both Auth Token and Organization slug');
      return;
    }

    const { projectId, projectName } = sentryCredentialsPrompt;

    // Close the modal
    console.log('[UI] Starting dashboard upload for:', projectName);
    setSentryCredentialsPrompt(null);
    setUploadingDashboard(projectId);

    // Initialize upload status modal
    setUploadStatus({
      projectName,
      organization: sentryCredentials.organization,
      dataGenerationStatus: 'in-progress',
      dashboardUploadStatus: 'pending',
    });

    try {
      // First, generate test data if DSN is provided
      if (sentryCredentials.dsn) {
        console.log('[UI] Generating demo-quality test data...');

        // Generate data in multiple batches for better demo quality
        const BATCHES = 10; // Run 10 batches
        const TRACES_PER_BATCH = 100;
        const ERRORS_PER_BATCH = 10;

        for (let batch = 1; batch <= BATCHES; batch++) {
          setUploadStatus(prev => prev ? {
            ...prev,
            dataGenerationStatus: 'in-progress',
            error: `Generating batch ${batch}/${BATCHES}...`
          } : null);

          const dataResult = await window.electronAPI.runDataGenerator(projectId, {
            frontendDsn: sentryCredentials.dsn,
            backendDsn: sentryCredentials.dsn,
            numTraces: TRACES_PER_BATCH,
            numErrors: ERRORS_PER_BATCH,
            environment: 'demo'
          });

          if (!dataResult.success) {
            setUploadStatus(prev => prev ? { ...prev, dataGenerationStatus: 'error', error: dataResult.error } : null);
            throw new Error(`Failed to generate data (batch ${batch}): ${dataResult.error}`);
          }

          console.log(`[UI] Batch ${batch}/${BATCHES} complete`);

          // Small delay between batches to avoid rate limiting
          await new Promise(resolve => setTimeout(resolve, 1000));
        }

        console.log('[UI] All test data generated successfully');
        setUploadStatus(prev => prev ? {
          ...prev,
          dataGenerationStatus: 'done',
          dashboardUploadStatus: 'in-progress',
          error: undefined
        } : null);
      } else {
        // Skip data generation if no DSN provided
        setUploadStatus(prev => prev ? { ...prev, dataGenerationStatus: 'done', dashboardUploadStatus: 'in-progress' } : null);
      }

      // Upload the dashboard
      console.log('[UI] Calling electronAPI.createSentryDashboard...');

      // Add a manual timeout
      const uploadPromise = window.electronAPI.createSentryDashboard(
        projectId,
        `${projectName} - Performance Dashboard`,
        {
          authToken: sentryCredentials.authToken.trim(),
          organization: sentryCredentials.organization.trim()
        }
      );

      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Upload timed out after 15 seconds')), 15000)
      );

      const result = await Promise.race([uploadPromise, timeoutPromise]) as any;
      console.log('[UI] Got result:', result);

      if (result.success && result.dashboardUrl) {
        console.log('[UI] Upload successful, URL:', result.dashboardUrl);
        setUploadStatus(prev => prev ? { ...prev, dashboardUploadStatus: 'done', dashboardUrl: result.dashboardUrl } : null);
      } else {
        console.error('[UI] Upload failed:', result.error);
        Sentry.captureMessage(`Dashboard upload failed: ${result.error}`, 'error');
        setUploadStatus(prev => prev ? { ...prev, dashboardUploadStatus: 'error', error: result.error } : null);
      }
    } catch (error) {
      console.error('[UI] Exception during upload:', error);
      Sentry.captureException(error);
      const errorMsg = error instanceof Error ? error.message : String(error);
      setUploadStatus(prev => {
        if (!prev) return null;
        return {
          ...prev,
          dataGenerationStatus: prev.dataGenerationStatus === 'in-progress' ? 'error' : prev.dataGenerationStatus,
          dashboardUploadStatus: prev.dashboardUploadStatus === 'in-progress' ? 'error' : prev.dashboardUploadStatus,
          error: errorMsg
        };
      });
    } finally {
      console.log('[UI] Cleaning up upload state');
      setUploadingDashboard(null);
    }
  };

  return (
    <div className="p-8 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-4xl font-bold text-white mb-2">Projects</h1>
          <p className="text-gray-400 text-lg">Manage your Sentry demo projects</p>
        </div>
        <Link to="/new">
          <Button size="lg">
            <span className="mr-2">✨</span> New Project
          </Button>
        </Link>
      </div>

      {projects.length === 0 ? (
        <div className="text-center py-20 card glass">
          <div className="text-7xl mb-6 opacity-50">📂</div>
          <h3 className="text-2xl font-semibold text-white mb-3">No projects yet</h3>
          <p className="text-gray-400 mb-8 text-lg">Create your first project to get started</p>
          <Link to="/new">
            <Button size="lg">
              <span className="mr-2">✨</span> Create Project
            </Button>
          </Link>
        </div>
      ) : (
        <div className="grid gap-5">
          {projects.map(project => (
            <div
              key={project.id}
              className="card p-6 cursor-pointer group hover:scale-[1.01]"
              onClick={() => handleOpenProject(project)}
            >
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <h3 className="text-2xl font-semibold text-white mb-2 group-hover:text-gradient transition-all">
                    {project.project.name}
                  </h3>
                  <div className="flex items-center gap-4 text-sm text-gray-400 mb-3">
                    <span className="flex items-center gap-1">
                      <span className="font-medium">Vertical:</span> {project.project.vertical}
                    </span>
                    {project.project.customerWebsite && (
                      <span className="flex items-center gap-1">
                        <span className="font-medium">Website:</span>
                        <a
                          href={project.project.customerWebsite}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-sentry-purple-400 hover:text-sentry-purple-300 hover:underline transition-colors"
                          onClick={e => e.stopPropagation()}
                        >
                          {new URL(project.project.customerWebsite).hostname}
                        </a>
                      </span>
                    )}
                    <span className="flex items-center gap-1">
                      <span className="font-medium">Status:</span>
                      <StatusBadge status={project.status} />
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="font-medium">Spans:</span> {project.instrumentation.spans.length}
                    </span>
                  </div>
                  {project.project.notes && (
                    <p className="text-gray-400 text-sm line-clamp-2">{project.project.notes}</p>
                  )}
                </div>
                <div className="flex gap-2">
                  <Link to={`/project/${project.id}/plan`}>
                    <Button size="sm" variant="secondary" onClick={e => e.stopPropagation()}>
                      Open
                    </Button>
                  </Link>
                  {project.project.githubRepoUrl && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={e => {
                        e.stopPropagation();
                        window.electronAPI.openInChrome(project.project.githubRepoUrl!);
                      }}
                    >
                      📂 GitHub
                    </Button>
                  )}
                  {(project.status === 'generated' || project.status === 'published') && (
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={e => handleUploadDashboard(project, e)}
                      disabled={uploadingDashboard === project.id}
                    >
                      {uploadingDashboard === project.id ? '⏳ Uploading' : '🚀 Upload to Sentry'}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={e => handleDeleteProject(project.id, e)}
                  >
                    Delete
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Sentry Credentials Prompt Modal */}
      {sentryCredentialsPrompt && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 z-50" onClick={() => setSentryCredentialsPrompt(null)}>
          <div className="card max-w-2xl w-full shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="bg-sentry-background-secondary border-b border-sentry-border px-6 py-4">
              <div className="flex items-center gap-3 mb-2">
                <span className="text-3xl">🔮</span>
                <div>
                  <h2 className="text-2xl font-bold text-white">Upload to Sentry</h2>
                  <p className="text-sm text-gray-400">{sentryCredentialsPrompt.projectName}</p>
                </div>
              </div>
            </div>
            <div className="p-6 space-y-6">
              <div className="bg-blue-900/20 p-4 rounded-lg text-sm text-blue-300 border border-blue-700/50">
                <p className="font-semibold text-blue-100 mb-2">📝 Provide Sentry Credentials</p>
                <p>Enter the Sentry organization credentials where you want to upload this dashboard. Each project can be deployed to a different Sentry organization.</p>
              </div>

              <Input
                label="Sentry Auth Token"
                type="password"
                placeholder="sntrys_..."
                value={sentryCredentials.authToken}
                onChange={e => setSentryCredentials({ ...sentryCredentials, authToken: e.target.value })}
              />

              <Input
                label="Organization Slug"
                placeholder="my-organization"
                value={sentryCredentials.organization}
                onChange={e => setSentryCredentials({ ...sentryCredentials, organization: e.target.value })}
              />

              <Input
                label="Project DSN (optional - for test data)"
                placeholder="https://...@...ingest.us.sentry.io/..."
                value={sentryCredentials.dsn || ''}
                onChange={e => setSentryCredentials({ ...sentryCredentials, dsn: e.target.value })}
              />

              <div className="bg-sentry-purple-900/20 p-4 rounded-lg text-sm text-sentry-purple-300 border border-sentry-purple-700/50">
                <p className="font-semibold text-sentry-purple-100 mb-2">💡 How to get credentials</p>
                <ol className="list-decimal list-inside space-y-1">
                  <li>Go to <a href="https://sentry.io/settings/account/api/auth-tokens/" target="_blank" rel="noopener noreferrer" className="text-sentry-purple-400 hover:text-sentry-purple-300 underline">Sentry Auth Tokens</a></li>
                  <li>Create a token with <code className="bg-sentry-purple-800/50 px-2 py-0.5 rounded text-sentry-purple-100">org:write</code> scope</li>
                  <li>Your organization slug is in your Sentry URL: sentry.io/organizations/<strong className="text-sentry-purple-100">org-slug</strong>/</li>
                  <li>Optional: Add your project DSN to generate realistic test data with custom spans</li>
                </ol>
              </div>

              <div className="flex gap-3 pt-4">
                <Button
                  size="lg"
                  onClick={handleConfirmUpload}
                  disabled={!sentryCredentials.authToken.trim() || !sentryCredentials.organization.trim()}
                  className="flex-1"
                >
                  🚀 Upload Dashboard
                </Button>
                <Button
                  size="lg"
                  variant="secondary"
                  onClick={() => setSentryCredentialsPrompt(null)}
                >
                  Cancel
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Upload Status Modal */}
      {uploadStatus && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 z-50" onClick={() => setUploadStatus(null)}>
          <div className="card max-w-2xl w-full shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="bg-sentry-background-secondary border-b border-sentry-border px-6 py-4">
              <div className="flex items-center gap-3 mb-2">
                <span className="text-3xl">🚀</span>
                <div>
                  <h2 className="text-2xl font-bold text-white">Uploading to Sentry</h2>
                  <p className="text-sm text-gray-400">{uploadStatus.projectName} → {uploadStatus.organization}</p>
                </div>
              </div>
            </div>
            <div className="p-6 space-y-4">
              {/* Step 1: Generate Data */}
              <div className="flex items-start gap-4 p-4 rounded-lg bg-gray-900/50 border border-gray-700/50">
                <div className="text-2xl mt-0.5">
                  {uploadStatus.dataGenerationStatus === 'in-progress' && '⏳'}
                  {uploadStatus.dataGenerationStatus === 'done' && '✅'}
                  {uploadStatus.dataGenerationStatus === 'error' && '❌'}
                  {uploadStatus.dataGenerationStatus === 'pending' && '⏸️'}
                </div>
                <div className="flex-1">
                  <h3 className="text-lg font-semibold text-white mb-1">Generate Demo Data</h3>
                  <p className="text-sm text-gray-400">
                    {uploadStatus.dataGenerationStatus === 'in-progress' && (
                      <>
                        Generating 1,000 transactions with custom spans (conda, data, package, kernel)
                        {uploadStatus.error && <><br/><span className="text-blue-400">{uploadStatus.error}</span></>}
                      </>
                    )}
                    {uploadStatus.dataGenerationStatus === 'done' && '✅ Generated 1,000 transactions with 4,000 custom spans + 100 errors'}
                    {uploadStatus.dataGenerationStatus === 'error' && `Failed: ${uploadStatus.error}`}
                    {uploadStatus.dataGenerationStatus === 'pending' && 'Waiting...'}
                  </p>
                </div>
              </div>

              {/* Step 2: Upload Dashboard */}
              <div className="flex items-start gap-4 p-4 rounded-lg bg-gray-900/50 border border-gray-700/50">
                <div className="text-2xl mt-0.5">
                  {uploadStatus.dashboardUploadStatus === 'in-progress' && '⏳'}
                  {uploadStatus.dashboardUploadStatus === 'done' && '✅'}
                  {uploadStatus.dashboardUploadStatus === 'error' && '❌'}
                  {uploadStatus.dashboardUploadStatus === 'pending' && '⏸️'}
                </div>
                <div className="flex-1">
                  <h3 className="text-lg font-semibold text-white mb-1">Upload Dashboard</h3>
                  <p className="text-sm text-gray-400">
                    {uploadStatus.dashboardUploadStatus === 'in-progress' && 'Creating dashboard with 7 widgets...'}
                    {uploadStatus.dashboardUploadStatus === 'done' && 'Dashboard created successfully!'}
                    {uploadStatus.dashboardUploadStatus === 'error' && `Failed: ${uploadStatus.error}`}
                    {uploadStatus.dashboardUploadStatus === 'pending' && 'Waiting...'}
                  </p>
                </div>
              </div>

              {/* Actions */}
              <div className="flex gap-3 pt-4">
                {uploadStatus.dashboardUploadStatus === 'done' && uploadStatus.dashboardUrl && (
                  <>
                    <Button
                      size="lg"
                      onClick={() => {
                        window.electronAPI.openInChrome(uploadStatus.dashboardUrl!);
                      }}
                      className="flex-1"
                    >
                      🔗 Open Dashboard in Sentry
                    </Button>
                    <Button
                      size="lg"
                      variant="secondary"
                      onClick={() => setUploadStatus(null)}
                    >
                      Close
                    </Button>
                  </>
                )}
                {(uploadStatus.dataGenerationStatus === 'error' || uploadStatus.dashboardUploadStatus === 'error') && (
                  <Button
                    size="lg"
                    variant="secondary"
                    onClick={() => setUploadStatus(null)}
                    className="flex-1"
                  >
                    Close
                  </Button>
                )}
                {/* Always show cancel button if still in progress */}
                {uploadStatus.dashboardUploadStatus === 'in-progress' && (
                  <Button
                    size="lg"
                    variant="secondary"
                    onClick={() => setUploadStatus(null)}
                    className="flex-1"
                  >
                    Cancel
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    draft: 'bg-gray-800 text-gray-300 border border-gray-700',
    planning: 'bg-blue-900/30 text-blue-400 border border-blue-700',
    locked: 'bg-yellow-900/30 text-yellow-400 border border-yellow-700',
    generated: 'bg-green-900/30 text-green-400 border border-green-700',
    published: 'bg-sentry-purple-900/50 text-sentry-purple-300 border border-sentry-purple-700'
  };

  return (
    <span className={`px-2.5 py-1 rounded-md text-xs font-semibold uppercase tracking-wide ${colors[status] || colors.draft}`}>
      {status}
    </span>
  );
}
