import { useState, useEffect } from 'react';
import * as Sentry from '@sentry/react';
import { Bot, Github, Telescope, FlaskConical, CheckCircle2, ChevronDown, ChevronRight, LogOut, RefreshCw } from 'lucide-react';
import Button from '../components/Button';
import { Input } from '../components/Input';
import { toast } from '../store/toast-store';

export default function SettingsPage() {
  const [settings, setSettings] = useState<any>({
    llm: { baseUrl: '', apiKey: '', model: 'gpt-4-turbo-preview' },
    github: { accessToken: '', username: '' },
    sentry: { authToken: '', organization: '', project: '' },
  });
  const [loading, setLoading] = useState(true);
  const [sentryAuth, setSentryAuth] = useState<{
    authenticated: boolean;
    user?: { name: string; email: string };
    orgs?: Array<{ slug: string; name: string }>;
  }>({ authenticated: false });
  const [oauthConnecting, setOauthConnecting] = useState(false);
  const [showManualToken, setShowManualToken] = useState(false);

  useEffect(() => {
    loadSettings();
    loadSentryAuthStatus();
  }, []);

  const loadSettings = async () => {
    const data = await window.electronAPI.getSettings();
    setSettings(data);
    setLoading(false);
  };

  const loadSentryAuthStatus = async () => {
    const status = await window.electronAPI.getSentryOAuthStatus();
    setSentryAuth(status);
  };

  const handleSave = async () => {
    try {
      await window.electronAPI.updateSettings(settings);
      toast.success('Settings saved');
    } catch (error) {
      toast.error('Failed to save settings: ' + error);
    }
  };

  const handleSentryConnect = async () => {
    setOauthConnecting(true);
    try {
      const result = await window.electronAPI.startSentryOAuth();
      if (result.success) {
        toast.success('Connected to Sentry!');
        await loadSentryAuthStatus();
        await loadSettings();
      } else {
        toast.error(result.error || 'OAuth failed');
      }
    } catch (err) {
      toast.error('Connection error: ' + err);
    } finally {
      setOauthConnecting(false);
    }
  };

  const handleSentryDisconnect = async () => {
    await window.electronAPI.logoutSentry();
    setSentryAuth({ authenticated: false });
    toast.info('Disconnected from Sentry');
  };

  const handleOrgChange = async (orgSlug: string) => {
    const updated = {
      ...settings,
      sentry: { ...settings.sentry, organization: orgSlug }
    };
    setSettings(updated);
    await window.electronAPI.updateSettings(updated);
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
            value={settings.llm?.baseUrl || ''}
            onChange={e => setSettings({ ...settings, llm: { ...settings.llm, baseUrl: e.target.value } })}
          />
          <Input
            label="API Key"
            type="password"
            placeholder="sk-…"
            value={settings.llm?.apiKey || ''}
            onChange={e => setSettings({ ...settings, llm: { ...settings.llm, apiKey: e.target.value } })}
          />
          <Input
            label="Model"
            placeholder="gpt-4-turbo-preview"
            value={settings.llm?.model || ''}
            onChange={e => setSettings({ ...settings, llm: { ...settings.llm, model: e.target.value } })}
          />
          <p className="text-xs text-white/35">Any OpenAI-compatible endpoint works (OpenAI, Azure OpenAI, etc.)</p>
        </Section>

        {/* GitHub */}
        <Section icon={<Github size={16} />} title="GitHub Configuration">
          {settings.github?.username ? (
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
                value={settings.github?.accessToken || ''}
                onChange={e => setSettings({ ...settings, github: { ...settings.github, accessToken: e.target.value } })}
              />
              {settings.github?.accessToken && (
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
                Create a token at{' '}
                <a href="https://github.com/settings/tokens/new" target="_blank" rel="noopener noreferrer" className="text-sentry-purple-400 hover:underline">
                  github.com/settings/tokens
                </a>{' '}
                with <code className="bg-white/5 px-1 rounded">repo</code> scope.
              </p>
            </>
          )}
        </Section>

        {/* Sentry */}
        <Section icon={<Telescope size={16} />} title="Sentry Connection">
          {sentryAuth.authenticated ? (
            /* Connected state */
            <div className="space-y-3">
              <div className="flex items-center justify-between p-3 rounded-lg bg-green-900/15 border border-green-700/30">
                <div className="flex items-center gap-2">
                  <CheckCircle2 size={14} className="text-green-400" />
                  <div>
                    <p className="text-sm text-green-300">{sentryAuth.user?.name || 'Connected'}</p>
                    {sentryAuth.user?.email && (
                      <p className="text-xs text-white/40">{sentryAuth.user.email}</p>
                    )}
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="ghost" onClick={loadSentryAuthStatus}>
                    <RefreshCw size={13} />
                  </Button>
                  <Button size="sm" variant="ghost" onClick={handleSentryDisconnect}>
                    <LogOut size={13} className="mr-1" /> Disconnect
                  </Button>
                </div>
              </div>

              {sentryAuth.orgs && sentryAuth.orgs.length > 0 && (
                <div>
                  <label className="block text-xs font-medium text-white/55 mb-1.5">Active Organization</label>
                  <select
                    className="w-full bg-sentry-surface border border-sentry-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-sentry-purple-500"
                    value={settings.sentry?.organization || sentryAuth.orgs[0]?.slug || ''}
                    onChange={e => handleOrgChange(e.target.value)}
                  >
                    {sentryAuth.orgs.map(org => (
                      <option key={org.slug} value={org.slug}>{org.name}</option>
                    ))}
                  </select>
                  <p className="text-xs text-white/35 mt-1">Dashboards will be pushed to this organization.</p>
                </div>
              )}
            </div>
          ) : (
            /* Not connected state */
            <div className="space-y-4">
              <Button
                onClick={handleSentryConnect}
                disabled={oauthConnecting}
                className="w-full"
              >
                {oauthConnecting ? 'Opening browser…' : 'Connect with Sentry'}
              </Button>

              {/* Manual token fallback */}
              <div className="border border-sentry-border rounded-lg overflow-hidden">
                <button
                  className="w-full flex items-center justify-between px-4 py-3 text-sm text-white/70 hover:text-white hover:bg-white/5 transition-colors"
                  onClick={() => setShowManualToken(v => !v)}
                >
                  <span>Manual token (fallback)</span>
                  {showManualToken ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </button>
                {showManualToken && (
                  <div className="px-4 pb-4 space-y-3 border-t border-sentry-border">
                    <div className="mt-3">
                      <Input
                        label="Auth Token"
                        type="password"
                        placeholder="sntrys_…"
                        value={settings.sentry?.authToken || ''}
                        onChange={e => setSettings({ ...settings, sentry: { ...settings.sentry, authToken: e.target.value } })}
                      />
                    </div>
                    <Input
                      label="Organization Slug"
                      placeholder="my-org"
                      value={settings.sentry?.organization || ''}
                      onChange={e => setSettings({ ...settings, sentry: { ...settings.sentry, organization: e.target.value } })}
                    />
                    <Input
                      label="Project Slug"
                      placeholder="my-project"
                      value={settings.sentry?.project || ''}
                      onChange={e => setSettings({ ...settings, sentry: { ...settings.sentry, project: e.target.value } })}
                    />
                    {settings.sentry?.authToken && settings.sentry?.organization && (
                      <Button size="sm" variant="secondary" onClick={async () => {
                        try {
                          const result = await window.electronAPI.verifySentryConnection();
                          if (result.success) toast.success(`Connected to: ${result.organization}`);
                          else toast.error('Connection failed: ' + result.error);
                        } catch (error) { toast.error('Error: ' + error); }
                      }}>
                        Verify Connection
                      </Button>
                    )}
                    <p className="text-xs text-white/35">
                      Create a token at{' '}
                      <a href="https://sentry.io/settings/account/api/auth-tokens/" target="_blank" rel="noopener noreferrer" className="text-sentry-purple-400 hover:underline">
                        sentry.io/auth-tokens
                      </a>{' '}
                      with <code className="bg-white/5 px-1 rounded">org:read</code> + <code className="bg-white/5 px-1 rounded">project:write</code> scopes.
                    </p>
                  </div>
                )}
              </div>
            </div>
          )}
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
