import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useNavigate } from 'react-router-dom';
import { CheckCircle2, ExternalLink, Upload, RefreshCw } from 'lucide-react';
import { useProjectStore } from '../store/project-store';
import Button from '../components/Button';
import { Input } from '../components/Input';
import { toast } from '../store/toast-store';

export default function PublishPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const { currentProject, loadProject } = useProjectStore();
  const navigate = useNavigate();

  const [githubStatus, setGithubStatus] = useState<{ authenticated: boolean; username?: string }>({
    authenticated: false
  });

  const [repoConfig, setRepoConfig] = useState({ name: '', isPrivate: true });
  const [publishing, setPublishing] = useState(false);
  const [publishResult, setPublishResult] = useState<{ success: boolean; repoUrl?: string; isUpdate?: boolean } | null>(null);

  // Sentry dashboard push state
  const [sentryAuth, setSentryAuth] = useState<{
    authenticated: boolean;
    user?: { name: string; email: string };
    orgs?: Array<{ slug: string; name: string }>;
  }>({ authenticated: false });
  const [pushOrg, setPushOrg] = useState('');
  const [uploadingDashboard, setUploadingDashboard] = useState(false);
  const [dashboardUrl, setDashboardUrl] = useState('');

  useEffect(() => {
    if (projectId) {
      loadProject(projectId);
      checkGitHubStatus();
      loadSentryAuth();
    }
  }, [projectId]);

  useEffect(() => {
    const interval = setInterval(checkGitHubStatus, 2000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (currentProject) {
      setRepoConfig(c => ({
        ...c,
        name: currentProject.project.githubRepoName || currentProject.project.slug
      }));
    }
  }, [currentProject]);

  const checkGitHubStatus = async () => {
    const status = await window.electronAPI.getGitHubStatus();
    setGithubStatus(status);
  };

  const loadSentryAuth = async () => {
    const status = await window.electronAPI.getSentryOAuthStatus();
    setSentryAuth(status);
    if (status.authenticated && status.orgs?.length) {
      const settings = await window.electronAPI.getSettings();
      const savedOrg = settings?.sentry?.organization;
      const firstOrg = status.orgs[0].slug;
      const org = savedOrg && status.orgs.some((o: any) => o.slug === savedOrg) ? savedOrg : firstOrg;
      setPushOrg(org);
    }
  };

  const hasExistingRepo = currentProject?.project.githubRepoUrl && currentProject?.project.githubRepoName;

  const handlePublish = async () => {
    if (!currentProject || !repoConfig.name.trim()) return;
    setPublishing(true);
    try {
      const result = await window.electronAPI.createAndPushRepo(
        currentProject.id,
        repoConfig.name,
        repoConfig.isPrivate
      );
      if (result.success) {
        setPublishResult({ success: true, repoUrl: result.repoUrl, isUpdate: result.isUpdate });
        await loadProject(currentProject.id);
        toast.success(result.isUpdate ? 'Changes pushed to GitHub' : 'Published to GitHub');
      } else {
        toast.error('GitHub publish failed: ' + result.error);
      }
    } catch (error) {
      toast.error('Error: ' + error);
    } finally {
      setPublishing(false);
    }
  };

  const handleUploadDashboard = async () => {
    if (!currentProject) return;
    setUploadingDashboard(true);
    setDashboardUrl('');
    try {
      const settings = await window.electronAPI.getSettings();
      const credentials = sentryAuth.authenticated
        ? { authToken: settings?.sentryAuth?.accessToken || settings?.sentry?.authToken, organization: pushOrg }
        : undefined;

      const result = await window.electronAPI.createSentryDashboard(
        currentProject.id,
        `${currentProject.project.name} — Performance Dashboard`,
        credentials
      );

      if (result.success && result.dashboardUrl) {
        setDashboardUrl(result.dashboardUrl);
        toast.success('Dashboard pushed to Sentry');
      } else {
        toast.error('Dashboard push failed: ' + result.error);
      }
    } catch (error) {
      toast.error('Error: ' + error);
    } finally {
      setUploadingDashboard(false);
    }
  };

  if (!currentProject) return <div className="p-8 text-white/50 text-sm">Loading…</div>;

  return (
    <div className="p-8 max-w-2xl mx-auto space-y-5">
      <div>
        <h1 className="text-2xl font-semibold text-white">
          {hasExistingRepo ? 'Push Updates' : 'Publish'}
        </h1>
        <p className="text-sm text-white/45 mt-0.5">Share your reference app and dashboard</p>
      </div>

      {/* ── Sentry Dashboard ── */}
      <div className="card p-5">
        <div className="flex items-center gap-2 mb-4">
          <span className="text-sentry-purple-400">
            <Upload size={16} />
          </span>
          <h2 className="text-sm font-semibold text-white">Push Dashboard to Sentry</h2>
        </div>

        {sentryAuth.authenticated ? (
          <div className="space-y-3">
            {/* Org selector */}
            {(sentryAuth.orgs?.length ?? 0) > 1 && (
              <div>
                <label className="block text-xs font-medium text-white/55 mb-1.5">Organization</label>
                <select
                  className="w-full bg-sentry-surface border border-sentry-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-sentry-purple-500"
                  value={pushOrg}
                  onChange={e => setPushOrg(e.target.value)}
                >
                  {sentryAuth.orgs?.map(org => (
                    <option key={org.slug} value={org.slug}>{org.name}</option>
                  ))}
                </select>
              </div>
            )}
            {(sentryAuth.orgs?.length ?? 0) === 1 && (
              <div className="flex items-center gap-2 text-xs text-white/50">
                <CheckCircle2 size={12} className="text-green-400" />
                Pushing to <span className="text-white font-medium">{sentryAuth.orgs![0].name}</span>
              </div>
            )}

            {dashboardUrl ? (
              <div className="flex items-center justify-between p-3 bg-green-900/15 border border-green-700/30 rounded-lg">
                <div className="flex items-center gap-2 text-sm text-green-300">
                  <CheckCircle2 size={14} className="text-green-400" />
                  Dashboard created
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => window.electronAPI.openInChrome(dashboardUrl)}
                >
                  View <ExternalLink size={11} className="ml-1" />
                </Button>
              </div>
            ) : (
              <Button
                size="lg"
                fullWidth
                onClick={handleUploadDashboard}
                disabled={uploadingDashboard}
              >
                {uploadingDashboard ? 'Pushing…' : 'Push Dashboard to Sentry'}
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="text-xs text-white/40 bg-white/3 border border-sentry-border rounded-lg px-3 py-2.5">
              Connect Sentry in Settings for one-click push, or configure a manual token.
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" onClick={() => navigate('/settings')}>
                Go to Settings
              </Button>
              <Button size="sm" variant="ghost" onClick={loadSentryAuth}>
                <RefreshCw size={13} />
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* ── GitHub ── */}
      <div className="card p-5">
        <div className="flex items-center gap-2 mb-4">
          <h2 className="text-sm font-semibold text-white">GitHub</h2>
        </div>

        {githubStatus.authenticated ? (
          <div className="space-y-4">
            <div className="flex items-center justify-between p-3 rounded-lg bg-green-900/15 border border-green-700/30">
              <div className="flex items-center gap-2 text-sm text-green-300">
                <CheckCircle2 size={14} className="text-green-400" />
                @{githubStatus.username}
              </div>
              <Button size="sm" variant="ghost" onClick={async () => {
                await window.electronAPI.logoutGitHub();
                checkGitHubStatus();
                toast.info('GitHub disconnected');
              }}>
                Disconnect
              </Button>
            </div>

            {!publishResult && (
              <>
                {hasExistingRepo ? (
                  <div className="p-3 rounded-lg bg-sentry-purple-500/10 border border-sentry-purple-700/30 text-sm">
                    <p className="text-sentry-purple-200 font-medium">{currentProject.project.githubRepoName}</p>
                    <button
                      onClick={() => window.electronAPI.openInChrome(currentProject.project.githubRepoUrl!)}
                      className="text-xs text-sentry-purple-400 hover:underline mt-0.5"
                    >
                      View on GitHub →
                    </button>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <Input
                      label="Repository Name"
                      value={repoConfig.name}
                      onChange={e => setRepoConfig({ ...repoConfig, name: e.target.value })}
                      placeholder="my-sentry-demo"
                    />
                    <label className="flex items-center gap-2 cursor-pointer text-sm text-white/70">
                      <input
                        type="checkbox"
                        checked={repoConfig.isPrivate}
                        onChange={e => setRepoConfig({ ...repoConfig, isPrivate: e.target.checked })}
                      />
                      Private repository
                    </label>
                  </div>
                )}

                <Button
                  size="lg"
                  fullWidth
                  onClick={handlePublish}
                  disabled={publishing || !repoConfig.name.trim()}
                >
                  {publishing
                    ? (hasExistingRepo ? 'Pushing…' : 'Publishing…')
                    : (hasExistingRepo ? 'Push Update to GitHub' : 'Publish to GitHub')}
                </Button>
              </>
            )}

            {publishResult?.success && (
              <div className="flex items-center justify-between p-3 bg-green-900/15 border border-green-700/30 rounded-lg">
                <div className="flex items-center gap-2 text-sm text-green-300">
                  <CheckCircle2 size={14} className="text-green-400" />
                  {publishResult.isUpdate ? 'Pushed successfully' : 'Published successfully'}
                </div>
                <div className="flex gap-2">
                  {publishResult.repoUrl && (
                    <Button size="sm" variant="ghost" onClick={() => window.electronAPI.openInChrome(publishResult.repoUrl!)}>
                      View <ExternalLink size={11} className="ml-1" />
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => setPublishResult(null)}>
                    Push Again
                  </Button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="text-xs text-white/40 bg-white/3 border border-sentry-border rounded-lg px-3 py-2.5">
              Add a GitHub Personal Access Token in Settings to publish repositories.
            </div>
            <Button size="sm" variant="secondary" onClick={() => navigate('/settings')}>
              Go to Settings
            </Button>
          </div>
        )}
      </div>

      {/* ── Export ── */}
      <div className="card p-5">
        <h2 className="text-sm font-semibold text-white mb-3">Export Demo Package</h2>
        <p className="text-xs text-white/40 mb-3">Bundle the repo link, implementation guide, and dashboard config into a shareable package.</p>
        <Button
          variant="secondary"
          size="sm"
          onClick={async () => {
            const result = await window.electronAPI.exportDemoPackage(currentProject.id);
            if (result.success) toast.success('Package exported to ' + result.outputPath);
            else toast.error('Export failed: ' + result.error);
          }}
        >
          Export Package
        </Button>
      </div>
    </div>
  );
}
