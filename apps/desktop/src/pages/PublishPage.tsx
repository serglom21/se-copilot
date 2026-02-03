import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useProjectStore } from '../store/project-store';
import Button from '../components/Button';
import { Input } from '../components/Input';

export default function PublishPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const { currentProject, loadProject } = useProjectStore();
  
  const [githubStatus, setGithubStatus] = useState<{ authenticated: boolean; username?: string }>({
    authenticated: false
  });
  
  const [repoConfig, setRepoConfig] = useState({
    name: '',
    isPrivate: true
  });

  const [publishing, setPublishing] = useState(false);
  const [publishResult, setPublishResult] = useState<{ success: boolean; repoUrl?: string; isUpdate?: boolean } | null>(null);
  const [authInProgress, setAuthInProgress] = useState(false);

  const [exporting, setExporting] = useState(false);
  const [uploadingDashboard, setUploadingDashboard] = useState(false);
  const [dashboardResult, setDashboardResult] = useState<{ success: boolean; dashboardUrl?: string; error?: string } | null>(null);
  const [sentryConnected, setSentryConnected] = useState<boolean | null>(null);

  useEffect(() => {
    if (projectId) {
      loadProject(projectId);
      checkGitHubStatus();
      checkSentryConnection();
    }
  }, [projectId]);

  // Refresh GitHub status when page becomes visible
  useEffect(() => {
    const interval = setInterval(() => {
      checkGitHubStatus();
    }, 2000); // Check every 2 seconds

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

  const hasExistingRepo = currentProject?.project.githubRepoUrl && currentProject?.project.githubRepoName;

  const checkGitHubStatus = async () => {
    const status = await window.electronAPI.getGitHubStatus();
    setGithubStatus(status);
  };

  const handleGitHubAuth = async () => {
    setAuthInProgress(true);
    try {
      const { verification_uri } = await window.electronAPI.startGitHubAuth();
      
      // Open GitHub token creation page
      window.open(verification_uri, '_blank');
      
      alert('Please create a Personal Access Token on GitHub with "repo" scope, then paste it in Settings.');
      
      // Poll for auth completion
      // In a real implementation, this would poll the device flow endpoint
      // For MVP, we just tell user to go to settings
      setAuthInProgress(false);
    } catch (error) {
      alert('Error starting GitHub auth: ' + error);
      setAuthInProgress(false);
    }
  };

  const handlePublish = async () => {
    if (!currentProject) return;

    if (!repoConfig.name.trim()) {
      alert('Please enter a repository name');
      return;
    }

    const isUpdate = hasExistingRepo;
    const confirmMessage = isUpdate
      ? `Push changes to existing GitHub repository "${repoConfig.name}"?\n\nThis will commit and push your latest changes.`
      : `Create GitHub repository "${repoConfig.name}" and push code?`;

    if (!confirm(confirmMessage)) {
      return;
    }

    setPublishing(true);
    try {
      const result = await window.electronAPI.createAndPushRepo(
        currentProject.id,
        repoConfig.name,
        repoConfig.isPrivate
      );

      if (result.success) {
        setPublishResult({
          success: true,
          repoUrl: result.repoUrl,
          isUpdate: result.isUpdate
        });

        // Reload project to get updated GitHub URL
        await loadProject(currentProject.id);
      } else {
        throw new Error(result.error);
      }
    } catch (error) {
      alert('Error publishing to GitHub: ' + error);
    } finally {
      setPublishing(false);
    }
  };

  const checkSentryConnection = async () => {
    try {
      const result = await window.electronAPI.verifySentryConnection();
      setSentryConnected(result.success);
    } catch (error) {
      setSentryConnected(false);
    }
  };

  const handleUploadDashboard = async () => {
    if (!currentProject) return;

    if (!confirm('Upload dashboard to Sentry?\n\nThis will create a new dashboard in your Sentry organization with all the custom widgets for your instrumented spans.')) {
      return;
    }

    setUploadingDashboard(true);
    setDashboardResult(null);

    try {
      const result = await window.electronAPI.createSentryDashboard(
        currentProject.id,
        `${currentProject.project.name} - Performance Dashboard`
      );

      setDashboardResult(result);

      if (result.success) {
        // Success message will be shown in the UI
      } else {
        alert(`Error uploading dashboard: ${result.error}`);
      }
    } catch (error) {
      alert('Error uploading dashboard: ' + error);
      setDashboardResult({ success: false, error: String(error) });
    } finally {
      setUploadingDashboard(false);
    }
  };

  const handleExportDemoPackage = async () => {
    if (!currentProject) return;

    setExporting(true);

    try {
      const result = await window.electronAPI.exportDemoPackage(currentProject.id);

      if (result.success) {
        alert(`✅ Demo package exported successfully!\n\nLocation: ${result.outputPath}\n\nThis package includes:\n• GitHub repo link\n• Implementation guide\n• Dashboard configuration\n• Quick start instructions`);
      } else {
        throw new Error(result.error);
      }
    } catch (error) {
      alert('Error exporting demo package: ' + error);
    } finally {
      setExporting(false);
    }
  };

  if (!currentProject) {
    return <div className="p-8 text-white">Loading...</div>;
  }

  return (
    <div className="p-8 max-w-3xl mx-auto">
      <div className="mb-8">
        <div className="flex items-start justify-between">
          <div className="flex-1">
            <h1 className="text-4xl font-bold text-white mb-2">
              {hasExistingRepo ? 'Push Updates to GitHub' : 'Publish to GitHub'}
            </h1>
            <p className="text-gray-400 text-lg">
              {hasExistingRepo
                ? 'Push your latest changes to the existing GitHub repository'
                : 'Push your generated reference app to a new GitHub repository'}
            </p>
            {hasExistingRepo && currentProject?.project.githubRepoUrl && (
              <button
                onClick={(e) => {
                  e.preventDefault();
                  window.electronAPI.openInChrome(currentProject.project.githubRepoUrl!);
                }}
                className="text-sentry-purple-400 hover:text-sentry-purple-300 hover:underline text-sm mt-1 inline-block cursor-pointer bg-transparent border-none p-0"
              >
                Current repo: {currentProject.project.githubRepoName} →
              </button>
            )}
          </div>
          {hasExistingRepo && currentProject?.project.githubRepoUrl && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => window.electronAPI.openInChrome(currentProject.project.githubRepoUrl!)}
            >
              📂 View Repo
            </Button>
          )}
        </div>
      </div>

      {/* Sentry Dashboard Upload */}
      <div className="card p-6 mb-6">
        <h2 className="text-2xl font-semibold text-white mb-4 flex items-center gap-2">
          <span className="text-2xl">🔮</span> Upload Dashboard to Sentry
        </h2>

        {sentryConnected === false ? (
          <div className="bg-yellow-900/20 p-4 rounded-lg border border-yellow-700/50">
            <div className="text-yellow-100 font-medium mb-2">
              ⚠️ Sentry not configured
            </div>
            <p className="text-sm text-yellow-300 mb-4">
              You need to configure your Sentry credentials to upload dashboards. Go to Settings to add your auth token and organization.
            </p>
            <div className="flex gap-2">
              <Button onClick={() => window.location.href = '/#/settings'}>
                Go to Settings
              </Button>
              <Button variant="secondary" onClick={checkSentryConnection}>
                🔄 Refresh Status
              </Button>
            </div>
          </div>
        ) : sentryConnected === true ? (
          <>
            {dashboardResult?.success ? (
              <div className="bg-green-900/20 rounded-lg border border-green-700/50 p-4 mb-4">
                <div className="flex items-start gap-4">
                  <div className="text-4xl">🎉</div>
                  <div className="flex-1">
                    <h3 className="text-xl font-semibold text-green-100 mb-2">
                      Dashboard Uploaded Successfully!
                    </h3>
                    <p className="text-green-300 mb-4">
                      Your custom dashboard with all instrumented spans has been created in Sentry.
                    </p>
                    {dashboardResult.dashboardUrl && (
                      <Button
                        onClick={() => window.electronAPI.openInChrome(dashboardResult.dashboardUrl!)}
                      >
                        View Dashboard in Sentry →
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="bg-green-900/20 p-4 rounded-lg border border-green-700/50">
                  <div className="text-green-100 font-medium mb-2">
                    ✓ Sentry Connected
                  </div>
                  <p className="text-sm text-green-300">
                    Ready to upload your custom dashboard with all instrumented spans and performance widgets.
                  </p>
                </div>

                <div className="bg-blue-900/20 p-4 rounded-lg text-sm text-blue-300 border border-blue-700/50">
                  <strong className="text-blue-100">What will be uploaded:</strong>
                  <ul className="list-disc list-inside mt-2 space-y-1">
                    <li>Custom widgets for each instrumented span</li>
                    <li>Performance metrics and trends</li>
                    <li>Transaction throughput visualizations</li>
                    <li>Error rate tracking</li>
                  </ul>
                </div>

                <Button
                  size="lg"
                  onClick={handleUploadDashboard}
                  disabled={uploadingDashboard}
                  fullWidth
                >
                  {uploadingDashboard ? '⏳ Uploading Dashboard...' : '🚀 Upload Dashboard to Sentry'}
                </Button>
              </div>
            )}
          </>
        ) : (
          <div className="text-gray-400">Checking connection...</div>
        )}
      </div>

      {/* GitHub Status */}
      <div className="card p-6 mb-6">
        <h2 className="text-2xl font-semibold text-white mb-4 flex items-center gap-2">
          <span className="text-2xl">🐙</span> GitHub Connection
        </h2>
        
        {githubStatus.authenticated ? (
          <div className="flex items-center justify-between bg-green-900/20 p-4 rounded-lg border border-green-700/50">
            <div>
              <div className="text-green-100 font-medium">
                ✓ Connected as @{githubStatus.username}
              </div>
              <div className="text-sm text-green-300 mt-1">
                Ready to create repositories
              </div>
            </div>
            <Button
              size="sm"
              variant="secondary"
              onClick={async () => {
                await window.electronAPI.logoutGitHub();
                checkGitHubStatus();
              }}
            >
              Disconnect
            </Button>
          </div>
        ) : (
          <div className="bg-yellow-900/20 p-4 rounded-lg border border-yellow-700/50">
            <div className="text-yellow-100 font-medium mb-2">
              ⚠️ GitHub not connected
            </div>
            <p className="text-sm text-yellow-300 mb-4">
              You need to connect your GitHub account to publish repositories. Go to Settings to add your Personal Access Token.
            </p>
            <div className="flex gap-2">
              <Button onClick={() => window.location.href = '/#/settings'}>
                Go to Settings
              </Button>
              <Button variant="secondary" onClick={checkGitHubStatus}>
                🔄 Refresh Status
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Repository Configuration */}
      {githubStatus.authenticated && !publishResult && (
        <div className="card p-6 mb-6">
          <h2 className="text-2xl font-semibold text-white mb-4">
            {hasExistingRepo ? 'Repository' : 'Repository Configuration'}
          </h2>

          <div className="space-y-4">
            {hasExistingRepo ? (
              <div className="bg-sentry-purple-900/20 border border-sentry-purple-700/50 rounded-lg p-4">
                <div className="flex items-start gap-3">
                  <div className="text-2xl">🔗</div>
                  <div className="flex-1">
                    <div className="font-medium text-sentry-purple-100 mb-1">
                      Existing Repository: {repoConfig.name}
                    </div>
                    <p className="text-sm text-sentry-purple-300 mb-2">
                      This project is already connected to a GitHub repository. Clicking "Push Update" will commit and push your latest changes.
                    </p>
                    <button
                      onClick={(e) => {
                        e.preventDefault();
                        window.electronAPI.openInChrome(currentProject?.project.githubRepoUrl!);
                      }}
                      className="text-sm text-sentry-purple-400 hover:text-sentry-purple-300 hover:underline cursor-pointer bg-transparent border-none p-0"
                    >
                      View on GitHub →
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <>
                <Input
                  label="Repository Name"
                  value={repoConfig.name}
                  onChange={e => setRepoConfig({ ...repoConfig, name: e.target.value })}
                  placeholder="my-sentry-demo"
                />

                <div>
                  <label className="flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      checked={repoConfig.isPrivate}
                      onChange={e => setRepoConfig({ ...repoConfig, isPrivate: e.target.checked })}
                      className="mr-2 cursor-pointer"
                    />
                    <span className="text-sm font-medium text-gray-300">
                      Private repository
                    </span>
                  </label>
                </div>
              </>
            )}

            <div className="bg-blue-900/20 p-4 rounded-lg text-sm text-blue-300 border border-blue-700/50">
              <strong className="text-blue-100">What will be {hasExistingRepo ? 'updated' : 'included'}:</strong>
              <ul className="list-disc list-inside mt-2 space-y-1">
                <li>Reference application (frontend + backend)</li>
                <li>IMPLEMENTATION_GUIDE.md</li>
                <li>sentry-dashboard.json</li>
                <li>README with setup instructions</li>
              </ul>
            </div>
          </div>
        </div>
      )}

      {/* Publish Result */}
      {publishResult && publishResult.success && (
        <div className="bg-green-900/20 rounded-lg border border-green-700/50 p-6 mb-6">
          <div className="flex items-start gap-4">
            <div className="text-4xl">{publishResult.isUpdate ? '✅' : '🎉'}</div>
            <div className="flex-1">
              <h3 className="text-2xl font-semibold text-green-100 mb-2">
                {publishResult.isUpdate ? 'Updates Pushed Successfully!' : 'Published Successfully!'}
              </h3>
              <p className="text-green-300 mb-4">
                {publishResult.isUpdate
                  ? 'Your latest changes have been committed and pushed to GitHub.'
                  : 'Your reference app has been pushed to GitHub.'}
              </p>
              <div className="flex gap-3 flex-wrap">
                {publishResult.repoUrl && (
                  <Button
                    onClick={() => window.electronAPI.openInChrome(publishResult.repoUrl!)}
                  >
                    View on GitHub →
                  </Button>
                )}
                <Button
                  variant="secondary"
                  onClick={handleExportDemoPackage}
                  disabled={exporting}
                >
                  {exporting ? '⏳ Exporting...' : '📦 Export Package'}
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => setPublishResult(null)}
                >
                  Push Another Update
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Actions */}
      {githubStatus.authenticated && !publishResult && (
        <div className="flex gap-4">
          <Button
            size="lg"
            onClick={handlePublish}
            disabled={publishing || !repoConfig.name.trim()}
            className="flex-1"
          >
            {publishing
              ? (hasExistingRepo ? '⏳ Pushing Update...' : '⏳ Publishing...')
              : (hasExistingRepo ? '🔄 Push Update to GitHub' : '🚀 Publish to GitHub')}
          </Button>
        </div>
      )}
    </div>
  );
}
