import { useState, useEffect } from 'react';
import * as Sentry from '@sentry/react';
import { Bot, Github, Telescope, FlaskConical, CheckCircle2 } from 'lucide-react';
import Button from '../components/Button';
import { Input } from '../components/Input';
import { toast } from '../store/toast-store';

export default function SettingsPage() {
  const [settings, setSettings] = useState({
    llm: { baseUrl: '', apiKey: '', model: 'gpt-4-turbo-preview' },
    github: { accessToken: '', username: '' },
    sentry: { authToken: '', organization: '', project: '' },
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => { loadSettings(); }, []);

  const loadSettings = async () => {
    const data = await window.electronAPI.getSettings();
    setSettings(data);
    setLoading(false);
  };

  const handleSave = async () => {
    try {
      await window.electronAPI.updateSettings(settings);
      if (settings.github.accessToken && !settings.github.username) {
        try {
          await window.electronAPI.pollGitHubAuth('manual');
          await loadSettings();
        } catch {}
      }
      toast.success('Settings saved');
    } catch (error) {
      toast.error('Failed to save settings: ' + error);
    }
  };

  if (loading) return <div className="p-8 text-white/50 text-sm">Loading…</div>;

  return (
    <div className="p-8 max-w-3xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-white">Settings</h1>
        <p className="text-sm text-white/45 mt-0.5">Configure your SE Copilot preferences</p>
      </div>

      <div className="space-y-4">
        {/* LLM */}
        <Section icon={<Bot size={16} />} title="LLM Configuration">
          <Input
            label="API Base URL"
            placeholder="https://api.openai.com/v1"
            value={settings.llm.baseUrl}
            onChange={e => setSettings({ ...settings, llm: { ...settings.llm, baseUrl: e.target.value } })}
          />
          <Input
            label="API Key"
            type="password"
            placeholder="sk-…"
            value={settings.llm.apiKey}
            onChange={e => setSettings({ ...settings, llm: { ...settings.llm, apiKey: e.target.value } })}
          />
          <Input
            label="Model"
            placeholder="gpt-4-turbo-preview"
            value={settings.llm.model}
            onChange={e => setSettings({ ...settings, llm: { ...settings.llm, model: e.target.value } })}
          />
          <p className="text-xs text-white/35">Any OpenAI-compatible endpoint works (OpenAI, Azure OpenAI, etc.)</p>
        </Section>

        {/* GitHub */}
        <Section icon={<Github size={16} />} title="GitHub Configuration">
          {settings.github.username ? (
            <div className="flex items-center justify-between p-3 rounded-lg bg-green-900/15 border border-green-700/30">
              <div className="flex items-center gap-2 text-sm text-green-300">
                <CheckCircle2 size={14} className="text-green-400" />
                Connected as @{settings.github.username}
              </div>
              <Button size="sm" variant="ghost" onClick={async () => {
                await window.electronAPI.logoutGitHub();
                setSettings({ ...settings, github: { accessToken: '', username: '' } });
                toast.info('GitHub disconnected');
              }}>
                Disconnect
              </Button>
            </div>
          ) : (
            <>
              <Input
                label="Personal Access Token"
                type="password"
                placeholder="ghp_…"
                value={settings.github.accessToken}
                onChange={e => setSettings({ ...settings, github: { ...settings.github, accessToken: e.target.value } })}
              />
              {settings.github.accessToken && (
                <Button size="sm" variant="secondary" onClick={async () => {
                  try {
                    const result = await window.electronAPI.pollGitHubAuth('manual');
                    if (result.success) { await loadSettings(); toast.success('Token verified'); }
                    else toast.error('Verification failed: ' + result.error);
                  } catch (error) { toast.error('Error: ' + error); }
                }}>
                  Verify Token
                </Button>
              )}
              <p className="text-xs text-white/35">
                Create a token at <a href="https://github.com/settings/tokens/new" target="_blank" className="text-sentry-purple-400 hover:underline">github.com/settings/tokens</a> with <code className="bg-white/5 px-1 rounded">repo</code> scope.
              </p>
            </>
          )}
        </Section>

        {/* Sentry */}
        <Section icon={<Telescope size={16} />} title="Sentry API Configuration">
          <Input
            label="Auth Token"
            type="password"
            placeholder="sntrys_…"
            value={settings.sentry.authToken}
            onChange={e => setSettings({ ...settings, sentry: { ...settings.sentry, authToken: e.target.value } })}
          />
          <Input
            label="Organization Slug"
            placeholder="my-org"
            value={settings.sentry.organization}
            onChange={e => setSettings({ ...settings, sentry: { ...settings.sentry, organization: e.target.value } })}
          />
          <Input
            label="Project Slug"
            placeholder="my-project"
            value={settings.sentry.project}
            onChange={e => setSettings({ ...settings, sentry: { ...settings.sentry, project: e.target.value } })}
          />
          {settings.sentry.authToken && settings.sentry.organization && (
            <Button size="sm" variant="secondary" onClick={async () => {
              try {
                const result = await window.electronAPI.verifySentryConnection();
                if (result.success) toast.success(`Connected to organization: ${result.organization}`);
                else toast.error('Connection failed: ' + result.error);
              } catch (error) { toast.error('Error: ' + error); }
            }}>
              Verify Connection
            </Button>
          )}
          <p className="text-xs text-white/35">
            Create a token at <a href="https://sentry.io/settings/account/api/auth-tokens/" target="_blank" rel="noopener noreferrer" className="text-sentry-purple-400 hover:underline">sentry.io/auth-tokens</a> with <code className="bg-white/5 px-1 rounded">org:read</code> + <code className="bg-white/5 px-1 rounded">project:write</code> scopes.
            Your org slug is visible in your Sentry URL.
          </p>
          <p className="text-xs text-sentry-purple-400/70">These credentials are pre-filled when uploading dashboards from Home.</p>
        </Section>

        {/* Save */}
        <div className="pt-2">
          <Button onClick={handleSave} size="lg">Save Settings</Button>
        </div>

        {/* Sentry Testing */}
        <Section icon={<FlaskConical size={16} />} title="Sentry Integration Testing">
          <p className="text-xs text-white/45">Verify that Sentry is capturing events from SE Copilot.</p>
          <div className="flex gap-2 flex-wrap">
            <Button variant="secondary" size="sm" onClick={() => {
              Sentry.captureMessage('Test message from SE Copilot Settings', 'info');
              toast.info('Test message sent to Sentry');
            }}>
              Send Test Message
            </Button>
            <Button variant="danger" size="sm" onClick={() => {
              try { throw new Error('Test error from SE Copilot Settings'); }
              catch (error) {
                Sentry.captureException(error);
                toast.success('Test error sent to Sentry');
              }
            }}>
              Trigger Test Error
            </Button>
            <Button variant="secondary" size="sm" onClick={async () => {
              await Sentry.startSpan({ name: 'Test Transaction', op: 'test' }, async () => {
                await new Promise(resolve => setTimeout(resolve, 500));
              });
              toast.success('Test transaction sent to Sentry');
            }}>
              Test Performance
            </Button>
          </div>
        </Section>
      </div>
    </div>
  );
}

function Section({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="card p-5">
      <div className="flex items-center gap-2 mb-4">
        <span className="text-sentry-purple-400">{icon}</span>
        <h2 className="text-sm font-semibold text-white">{title}</h2>
      </div>
      <div className="space-y-3">{children}</div>
    </div>
  );
}
