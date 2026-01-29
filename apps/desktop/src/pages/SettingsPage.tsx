import { useState, useEffect } from 'react';
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
    return <div className="p-8">Loading...</div>;
  }

  return (
    <div className="p-8 max-w-4xl mx-auto">
      <h1 className="text-3xl font-bold text-gray-900 mb-2">Settings</h1>
      <p className="text-gray-600 mb-8">Configure your SE Copilot preferences</p>

      <div className="space-y-6">
        {/* LLM Settings */}
        <div className="bg-white rounded-lg border border-gray-200 p-6">
          <h2 className="text-xl font-semibold text-gray-900 mb-4">LLM Configuration</h2>
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
            <div className="bg-blue-50 p-4 rounded-lg text-sm text-blue-800">
              <strong>Note:</strong> You can use any OpenAI-compatible API endpoint (OpenAI, Azure OpenAI, or other compatible providers).
            </div>
          </div>
        </div>

        {/* GitHub Settings */}
        <div className="bg-white rounded-lg border border-gray-200 p-6">
          <h2 className="text-xl font-semibold text-gray-900 mb-4">GitHub Configuration</h2>
          <div className="space-y-4">
            {settings.github.username ? (
              <div className="bg-green-50 p-4 rounded-lg">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-medium text-green-800">
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
                <div className="bg-yellow-50 p-4 rounded-lg text-sm text-yellow-800">
                  <strong>Setup Instructions:</strong>
                  <ol className="list-decimal list-inside mt-2 space-y-1">
                    <li>Go to <a href="https://github.com/settings/tokens/new" target="_blank" className="underline">GitHub Token Settings</a></li>
                    <li>Create a token with <code className="bg-yellow-100 px-1 rounded">repo</code> scope</li>
                    <li>Paste the token above and click "Verify Token"</li>
                    <li>Save settings</li>
                  </ol>
                </div>
              </>
            )}
          </div>
        </div>

        {/* Save Button */}
        <div className="flex items-center gap-4">
          <Button onClick={handleSave} size="lg">
            Save Settings
          </Button>
          {saved && (
            <span className="text-green-600 font-medium">✓ Settings saved</span>
          )}
        </div>
      </div>
    </div>
  );
}
