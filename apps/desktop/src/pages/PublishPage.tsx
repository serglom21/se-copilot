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

  useEffect(() => {
    if (projectId) {
      loadProject(projectId);
      checkGitHubStatus();
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

  if (!currentProject) {
    return <div className="p-8">Loading...</div>;
  }

  return (
    <div className="p-8 max-w-3xl mx-auto">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900 mb-2">
          {hasExistingRepo ? 'Push Updates to GitHub' : 'Publish to GitHub'}
        </h1>
        <p className="text-gray-600">
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
            className="text-purple-600 hover:underline text-sm mt-1 inline-block cursor-pointer bg-transparent border-none p-0"
          >
            Current repo: {currentProject.project.githubRepoName} →
          </button>
        )}
      </div>

      {/* GitHub Status */}
      <div className="bg-white rounded-lg border border-gray-200 p-6 mb-6">
        <h2 className="text-xl font-semibold mb-4">GitHub Connection</h2>
        
        {githubStatus.authenticated ? (
          <div className="flex items-center justify-between bg-green-50 p-4 rounded-lg">
            <div>
              <div className="text-green-800 font-medium">
                ✓ Connected as @{githubStatus.username}
              </div>
              <div className="text-sm text-green-600 mt-1">
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
          <div className="bg-yellow-50 p-4 rounded-lg">
            <div className="text-yellow-800 font-medium mb-2">
              ⚠️ GitHub not connected
            </div>
            <p className="text-sm text-yellow-700 mb-4">
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
        <div className="bg-white rounded-lg border border-gray-200 p-6 mb-6">
          <h2 className="text-xl font-semibold mb-4">
            {hasExistingRepo ? 'Repository' : 'Repository Configuration'}
          </h2>

          <div className="space-y-4">
            {hasExistingRepo ? (
              <div className="bg-purple-50 border border-purple-200 rounded-lg p-4">
                <div className="flex items-start gap-3">
                  <div className="text-2xl">🔗</div>
                  <div className="flex-1">
                    <div className="font-medium text-purple-900 mb-1">
                      Existing Repository: {repoConfig.name}
                    </div>
                    <p className="text-sm text-purple-800 mb-2">
                      This project is already connected to a GitHub repository. Clicking "Push Update" will commit and push your latest changes.
                    </p>
                    <button
                      onClick={(e) => {
                        e.preventDefault();
                        window.electronAPI.openInChrome(currentProject?.project.githubRepoUrl!);
                      }}
                      className="text-sm text-purple-600 hover:underline cursor-pointer bg-transparent border-none p-0"
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
                  <label className="flex items-center">
                    <input
                      type="checkbox"
                      checked={repoConfig.isPrivate}
                      onChange={e => setRepoConfig({ ...repoConfig, isPrivate: e.target.checked })}
                      className="mr-2"
                    />
                    <span className="text-sm font-medium text-gray-700">
                      Private repository
                    </span>
                  </label>
                </div>
              </>
            )}

            <div className="bg-blue-50 p-4 rounded-lg text-sm text-blue-800">
              <strong>What will be {hasExistingRepo ? 'updated' : 'included'}:</strong>
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
        <div className="bg-green-50 rounded-lg border border-green-200 p-6 mb-6">
          <div className="flex items-start gap-4">
            <div className="text-4xl">{publishResult.isUpdate ? '✅' : '🎉'}</div>
            <div className="flex-1">
              <h3 className="text-xl font-semibold text-green-900 mb-2">
                {publishResult.isUpdate ? 'Updates Pushed Successfully!' : 'Published Successfully!'}
              </h3>
              <p className="text-green-800 mb-4">
                {publishResult.isUpdate
                  ? 'Your latest changes have been committed and pushed to GitHub.'
                  : 'Your reference app has been pushed to GitHub.'}
              </p>
              <div className="flex gap-3">
                {publishResult.repoUrl && (
                  <button
                    onClick={() => window.electronAPI.openInChrome(publishResult.repoUrl!)}
                    className="inline-block bg-green-600 text-white px-4 py-2 rounded-lg hover:bg-green-700 transition-colors cursor-pointer border-none"
                  >
                    View on GitHub →
                  </button>
                )}
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
