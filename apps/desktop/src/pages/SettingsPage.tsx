import { useState, useEffect } from 'react';
import * as Sentry from '@sentry/react';
import Button from '../components/Button';
import { Input } from '../components/Input';

export default function SettingsPage() {
  const [settings, setSettings] = useState({
    llm: {
      baseUrl: '',
      apiKey: '',
      model: 'gpt-4-turbo-preview'
    },
    github: {
      accessToken: '',
      username: ''
    },
    sentry: {
      authToken: '',
      organization: '',
      project: ''
    }
  });

  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    const data = await window.electronAPI.getSettings();
    setSettings(data);
    setLoading(false);
  };

  const handleSave = async () => {
    try {
      await window.electronAPI.updateSettings(settings);
      
      // If GitHub token was added, verify it
      if (settings.github.accessToken && !settings.github.username) {
        try {
          // This will verify the token and store the username
          await window.electronAPI.pollGitHubAuth('manual');
          // Reload settings to get the updated username
          await loadSettings();
        } catch (error) {
          console.error('Token verification failed:', error);
        }
      }
      
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (error) {
      alert('Error saving settings: ' + error);
    }
  };

  if (loading) {
    return <div className="p-8 text-white">Loading...</div>;
  }

  return (
    <div className="p-8 max-w-4xl mx-auto">
      <div className="mb-8">
        <h1 className="text-4xl font-bold text-white mb-2">Settings</h1>
        <p className="text-gray-400 text-lg">Configure your SE Copilot preferences</p>
      </div>

      <div className="space-y-6">
        {/* LLM Settings */}
        <div className="card p-6">
          <h2 className="text-2xl font-semibold text-white mb-4 flex items-center gap-2">
            <span className="text-2xl">🤖</span> LLM Configuration
          </h2>
          <div className="space-y-4">
            <Input
              label="API Base URL"
              placeholder="https://api.openai.com/v1"
              value={settings.llm.baseUrl}
              onChange={e => setSettings({
                ...settings,
                llm: { ...settings.llm, baseUrl: e.target.value }
              })}
            />
            <Input
              label="API Key"
              type="password"
              placeholder="sk-..."
              value={settings.llm.apiKey}
              onChange={e => setSettings({
                ...settings,
                llm: { ...settings.llm, apiKey: e.target.value }
              })}
            />
            <Input
              label="Model"
              placeholder="gpt-4-turbo-preview"
              value={settings.llm.model}
              onChange={e => setSettings({
                ...settings,
                llm: { ...settings.llm, model: e.target.value }
              })}
            />
            <div className="bg-blue-900/20 p-4 rounded-lg text-sm text-blue-300 border border-blue-700/50">
              <strong className="text-blue-100">Note:</strong> You can use any OpenAI-compatible API endpoint (OpenAI, Azure OpenAI, or other compatible providers).
            </div>
          </div>
        </div>

        {/* GitHub Settings */}
        <div className="card p-6">
          <h2 className="text-2xl font-semibold text-white mb-4 flex items-center gap-2">
            <span className="text-2xl">🐙</span> GitHub Configuration
          </h2>
          <div className="space-y-4">
            {settings.github.username ? (
              <div className="bg-green-900/20 p-4 rounded-lg border border-green-700/50">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-semibold text-green-100">
                      ✓ Connected as @{settings.github.username}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={async () => {
                      await window.electronAPI.logoutGitHub();
                      setSettings({
                        ...settings,
                        github: { accessToken: '', username: '' }
                      });
                    }}
                  >
                    Disconnect
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <Input
                  label="GitHub Personal Access Token"
                  type="password"
                  placeholder="ghp_..."
                  value={settings.github.accessToken}
                  onChange={e => setSettings({
                    ...settings,
                    github: { ...settings.github, accessToken: e.target.value }
                  })}
                />
                {settings.github.accessToken && (
                  <Button
                    size="sm"
                    onClick={async () => {
                      try {
                        const result = await window.electronAPI.pollGitHubAuth('manual');
                        if (result.success) {
                          await loadSettings();
                          alert('✓ Token verified successfully!');
                        } else {
                          alert('✗ Token verification failed: ' + result.error);
                        }
                      } catch (error) {
                        alert('Error verifying token: ' + error);
                      }
                    }}
                  >
                    Verify Token
                  </Button>
                )}
                <div className="bg-yellow-900/20 p-4 rounded-lg text-sm text-yellow-300 border border-yellow-700/50">
                  <strong className="text-yellow-100">Setup Instructions:</strong>
                  <ol className="list-decimal list-inside mt-2 space-y-1">
                    <li>Go to <a href="https://github.com/settings/tokens/new" target="_blank" className="text-yellow-100 underline hover:text-yellow-200">GitHub Token Settings</a></li>
                    <li>Create a token with <code className="bg-yellow-800/50 px-2 py-0.5 rounded text-yellow-100">repo</code> scope</li>
                    <li>Paste the token above and click "Verify Token"</li>
                    <li>Save settings</li>
                  </ol>
                </div>
              </>
            )}
          </div>
        </div>

        {/* Sentry API Settings */}
        <div className="card p-6">
          <h2 className="text-2xl font-semibold text-white mb-4 flex items-center gap-2">
            <span className="text-2xl">🔮</span> Sentry API Configuration
          </h2>
          <div className="space-y-4">
            <Input
              label="Auth Token"
              type="password"
              placeholder="sntrys_..."
              value={settings.sentry.authToken}
              onChange={e => setSettings({
                ...settings,
                sentry: { ...settings.sentry, authToken: e.target.value }
              })}
            />
            <Input
              label="Organization Slug"
              placeholder="my-org"
              value={settings.sentry.organization}
              onChange={e => setSettings({
                ...settings,
                sentry: { ...settings.sentry, organization: e.target.value }
              })}
            />
            <Input
              label="Project Slug"
              placeholder="my-project"
              value={settings.sentry.project}
              onChange={e => setSettings({
                ...settings,
                sentry: { ...settings.sentry, project: e.target.value }
              })}
            />
            {settings.sentry.authToken && settings.sentry.organization && (
              <Button
                size="sm"
                onClick={async () => {
                  try {
                    const result = await window.electronAPI.verifySentryConnection();
                    if (result.success) {
                      alert(`✓ Connected to organization: ${result.organization}`);
                    } else {
                      alert('✗ Connection failed: ' + result.error);
                    }
                  } catch (error) {
                    alert('Error verifying connection: ' + error);
                  }
                }}
              >
                Verify Connection
              </Button>
            )}
            <div className="bg-sentry-purple-900/20 p-4 rounded-lg text-sm text-sentry-purple-300 border border-sentry-purple-700/50">
              <strong className="text-sentry-purple-100">Setup Instructions:</strong>
              <ol className="list-decimal list-inside mt-2 space-y-1">
                <li>Go to <a href="https://sentry.io/settings/account/api/auth-tokens/" target="_blank" rel="noopener noreferrer" className="text-sentry-purple-100 underline hover:text-sentry-purple-200">Sentry Auth Tokens</a></li>
                <li>Create a token with <code className="bg-sentry-purple-800/50 px-2 py-0.5 rounded text-sentry-purple-100">org:read</code> and <code className="bg-sentry-purple-800/50 px-2 py-0.5 rounded text-sentry-purple-100">project:write</code> scopes</li>
                <li>Paste the token above</li>
                <li>Enter your organization slug (from your Sentry URL: sentry.io/organizations/<strong className="text-sentry-purple-100">org-slug</strong>/)</li>
                <li>Enter your project slug (from your Sentry URL: sentry.io/organizations/org-slug/projects/<strong className="text-sentry-purple-100">project-slug</strong>/)</li>
                <li>Click "Verify Connection" to test</li>
                <li>Save settings</li>
              </ol>
            </div>
          </div>
        </div>

        {/* Save Button */}
        <div className="flex items-center gap-4 pt-4">
          <Button onClick={handleSave} size="lg">
            <span className="mr-2">💾</span> Save Settings
          </Button>
          {saved && (
            <span className="text-green-400 font-semibold flex items-center gap-2">
              <span className="text-xl">✓</span> Settings saved
            </span>
          )}
        </div>

        {/* Sentry Testing */}
        <div className="card p-6">
          <h2 className="text-2xl font-semibold text-white mb-4 flex items-center gap-2">
            <span className="text-2xl">🔮</span> Sentry Testing
          </h2>
          <div className="space-y-4">
            <div className="bg-blue-900/20 p-4 rounded-lg text-sm text-blue-300 border border-blue-700/50">
              <p className="font-semibold text-blue-100 mb-2">Test Sentry Integration</p>
              <p>Click the buttons below to test that Sentry is properly capturing errors and events from SE Copilot.</p>
            </div>

            <div className="flex gap-3 flex-wrap">
              <Button
                variant="secondary"
                onClick={() => {
                  Sentry.captureMessage('Test message from SE Copilot Settings', 'info');
                  alert('✅ Test message sent to Sentry! Check your Sentry dashboard.');
                }}
              >
                📤 Send Test Message
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  try {
                    throw new Error('Test error from SE Copilot Settings');
                  } catch (error) {
                    Sentry.captureException(error);
                    alert('✅ Test error sent to Sentry! Check your Sentry dashboard.');
                  }
                }}
              >
                ⚠️ Trigger Test Error
              </Button>
              <Button
                variant="secondary"
                onClick={async () => {
                  await Sentry.startSpan(
                    { name: 'Test Transaction', op: 'test' },
                    async () => {
                      await new Promise(resolve => setTimeout(resolve, 500));
                    }
                  );
                  alert('✅ Test transaction sent to Sentry! Check your Performance page.');
                }}
              >
                🚀 Test Performance
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
