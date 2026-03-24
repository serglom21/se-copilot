import http from 'http';
import { exec } from 'child_process';
import { shell } from 'electron';
import { StorageService } from './storage';

const OAUTH_PORT = 54321;
const PROXY_REDIRECT_URI = 'https://demo-workbench.sergio-lombana.workers.dev';
const INTEGRATION_SLUG = 'demo-workbench';

export class SentryAuthService {
  private storage: StorageService;
  private activeServer: http.Server | null = null;

  constructor(storage: StorageService) {
    this.storage = storage;
  }

  private killPort(): Promise<void> {
    return new Promise(resolve => {
      exec(`lsof -ti tcp:${OAUTH_PORT}`, (_, stdout) => {
        const pids = (stdout || '').trim().split('\n').filter(Boolean);
        if (pids.length === 0) { resolve(); return; }
        exec(`kill -9 ${pids.join(' ')}`, () => setTimeout(resolve, 300));
      });
    });
  }

  async startOAuthFlow(): Promise<{ success: boolean; error?: string }> {
    const clientId = process.env.SENTRY_CLIENT_ID?.trim();
    const clientSecret = process.env.SENTRY_CLIENT_SECRET?.trim();

    if (!clientId || !clientSecret) {
      return {
        success: false,
        error: 'Sentry OAuth credentials not found. Ensure SENTRY_CLIENT_ID and SENTRY_CLIENT_SECRET are set in the .env file.'
      };
    }

    // Close any lingering server from a previous attempt
    if (this.activeServer) {
      this.activeServer.close();
      this.activeServer = null;
    }
    await this.killPort();

    return new Promise((resolve) => {
      const server = http.createServer(async (req, res) => {
        const urlObj = new URL(req.url!, `http://localhost:${OAUTH_PORT}`);
        if (urlObj.pathname !== '/callback') {
          res.writeHead(404);
          res.end('Not found');
          return;
        }

        const code = urlObj.searchParams.get('code');
        const installationId = urlObj.searchParams.get('installationId');
        const oauthError = urlObj.searchParams.get('error');

        const closePage = (title: string, body: string) => {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`<!doctype html><html><head><title>${title}</title>
            <style>body{font-family:system-ui,sans-serif;background:#1a1625;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
            .card{background:#2a2438;border:1px solid #3d3450;border-radius:12px;padding:40px;text-align:center;max-width:400px}
            h2{margin:0 0 8px}p{color:#aaa;margin:0}</style></head>
            <body><div class="card"><h2>${title}</h2><p>${body}</p></div></body></html>`);
        };

        if (oauthError || !code || !installationId) {
          closePage('Authentication cancelled', 'You can close this tab and return to SE Copilot.');
          server.close();
          resolve({ success: false, error: oauthError || 'No authorization code received' });
          return;
        }

        try {
          // Exchange code for token using the installation-specific endpoint
          const tokenRes = await fetch(
            `https://sentry.io/api/0/sentry-app-installations/${installationId}/authorizations/`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                grant_type: 'authorization_code',
                code,
                client_id: clientId,
                client_secret: clientSecret,
              })
            }
          );

          if (!tokenRes.ok) {
            const errText = await tokenRes.text();
            throw new Error(`Token exchange failed (${tokenRes.status}): ${errText}`);
          }

          const tokenData = await tokenRes.json();
          console.log('[SentryAuth] Token exchange response:', JSON.stringify({ ...tokenData, token: tokenData.token ? '[REDACTED]' : undefined, access_token: tokenData.access_token ? '[REDACTED]' : undefined }));
          const accessToken: string = tokenData.token || tokenData.access_token || '';
          if (!accessToken) {
            throw new Error(`Token exchange succeeded but no token in response. Keys: ${Object.keys(tokenData).join(', ')}`);
          }

          // Fetch authenticated user info
          let user = { name: 'Sentry User', email: '' };
          try {
            const userRes = await fetch('https://sentry.io/api/0/users/me/', {
              headers: { 'Authorization': `Bearer ${accessToken}` }
            });
            if (userRes.ok) {
              const u = await userRes.json();
              user = { name: u.name || u.username || 'Sentry User', email: u.email || '' };
            }
          } catch { /* non-fatal */ }

          // Get the org from the installation (more reliable than fetchOrgs,
          // since the installation token only has access to the installed org)
          let orgs: Array<{ slug: string; name: string }> = [];
          try {
            const installRes = await fetch(
              `https://sentry.io/api/0/sentry-app-installations/${installationId}/`,
              { headers: { 'Authorization': `Bearer ${accessToken}` } }
            );
            if (installRes.ok) {
              const installData = await installRes.json();
              const org = installData.organization;
              if (org?.slug) orgs = [{ slug: org.slug, name: org.name || org.slug }];
            }
          } catch { /* fall back */ }
          if (orgs.length === 0) orgs = await this.fetchOrgs(accessToken);

          // Persist OAuth state
          this.storage.updateSettings({
            sentryAuth: {
              accessToken,
              refreshToken: tokenData.refreshToken || '',
              installationId,
              user,
              orgs
            }
          } as any);

          // Keep sentry.authToken in sync for backward compatibility
          const currentSentry = (this.storage.getSettings() as any).sentry || {};
          this.storage.updateSettings({
            sentry: {
              ...currentSentry,
              authToken: accessToken,
              organization: orgs[0]?.slug || currentSentry.organization || ''
            }
          } as any);

          console.log('[SentryAuth] OAuth complete. Stored accessToken length:', accessToken.length, 'org:', orgs[0]?.slug);
          closePage('✅ Connected to Sentry!', 'Authentication successful. You can close this tab.');
          server.close();
          resolve({ success: true });
        } catch (err) {
          closePage('Connection failed', String(err));
          server.close();
          resolve({ success: false, error: String(err) });
        }
      });

      server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          resolve({ success: false, error: `Port ${OAUTH_PORT} is already in use. Close other apps using this port and try again.` });
        } else {
          resolve({ success: false, error: `OAuth server error: ${err.message}` });
        }
      });

      server.listen(OAUTH_PORT, () => {
        // Sentry Public Integration install URL — no redirect_uri or scope params needed,
        // Sentry uses the registered Redirect URL automatically
        const authUrl = `https://sentry.io/sentry-apps/${INTEGRATION_SLUG}/external-install/`;
        shell.openExternal(authUrl);
      });

      // Timeout after 10 minutes
      setTimeout(() => {
        server.close();
        resolve({ success: false, error: 'Authentication timed out after 10 minutes' });
      }, 600000);
    });
  }

  getAuthStatus(): {
    authenticated: boolean;
    user?: { name: string; email: string };
    orgs?: Array<{ slug: string; name: string }>;
  } {
    const settings = this.storage.getSettings() as any;
    const auth = settings.sentryAuth || {};
    console.log('[SentryAuth] getAuthStatus — sentryAuth keys:', Object.keys(auth), 'hasToken:', !!auth.accessToken, 'tokenLen:', auth.accessToken?.length ?? 0);
    if (!auth.accessToken) return { authenticated: false };
    return {
      authenticated: true,
      user: auth.user,
      orgs: auth.orgs || []
    };
  }

  async listOrganizations(): Promise<Array<{ slug: string; name: string }>> {
    let token = this.getAccessToken();
    if (!token) throw new Error('Not authenticated with Sentry');
    const orgs = await this.fetchOrgs(token);
    if (orgs.length === 0) {
      // May have been a 401 — try refreshing
      const refreshed = await this.refreshAccessToken();
      if (refreshed) return this.fetchOrgs(refreshed);
    }
    return orgs;
  }

  async listProjects(orgSlug: string): Promise<Array<{ slug: string; name: string; platform?: string }>> {
    let token = this.getAccessToken();
    if (!token) throw new Error('Not authenticated with Sentry');

    let res = await fetch(`https://sentry.io/api/0/organizations/${orgSlug}/projects/`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    // Token expired — try to refresh once and retry
    if (res.status === 401) {
      token = await this.refreshAccessToken() ?? token;
      res = await fetch(`https://sentry.io/api/0/organizations/${orgSlug}/projects/`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
    }

    // 404/403 means the integration isn't installed in this org — return empty rather than throw
    if (res.status === 404 || res.status === 403) return [];
    if (!res.ok) throw new Error(`Failed to list projects: ${res.status}`);
    const data = await res.json();
    return data.map((p: any) => ({ slug: p.slug, name: p.name, platform: p.platform }));
  }

  async getProjectDsn(orgSlug: string, projectSlug: string): Promise<{ publicDsn: string } | null> {
    let token = this.getAccessToken();
    if (!token) return null;

    const url = `https://sentry.io/api/0/projects/${orgSlug}/${projectSlug}/keys/`;
    let res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
    if (res.status === 401) {
      token = await this.refreshAccessToken() ?? token;
      res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
    }
    if (!res.ok) return null;
    const keys = await res.json();
    const publicDsn = keys[0]?.dsn?.public;
    return publicDsn ? { publicDsn } : null;
  }

  logout(): void {
    this.storage.updateSettings({ sentryAuth: {} } as any);
  }

  private getAccessToken(): string {
    const settings = this.storage.getSettings() as any;
    return settings.sentryAuth?.accessToken || settings.sentry?.authToken || '';
  }

  /** Refresh the OAuth access token using the stored refresh token. Returns the new token, or null on failure. */
  private async refreshAccessToken(): Promise<string | null> {
    const clientId = process.env.SENTRY_CLIENT_ID?.trim();
    const clientSecret = process.env.SENTRY_CLIENT_SECRET?.trim();
    if (!clientId || !clientSecret) return null;

    const settings = this.storage.getSettings() as any;
    const auth = settings.sentryAuth || {};
    const { refreshToken, installationId } = auth;
    if (!refreshToken || !installationId) {
      console.warn('[SentryAuth] Cannot refresh — no refreshToken or installationId stored');
      return null;
    }

    try {
      console.log('[SentryAuth] Refreshing access token…');
      const res = await fetch(
        `https://sentry.io/api/0/sentry-app-installations/${installationId}/authorizations/`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: clientId,
            client_secret: clientSecret,
          })
        }
      );

      if (!res.ok) {
        console.error('[SentryAuth] Token refresh failed:', res.status);
        return null;
      }

      const data = await res.json();
      const newAccessToken: string = data.token || data.access_token || '';
      const newRefreshToken: string = data.refreshToken || data.refresh_token || refreshToken;
      if (!newAccessToken) return null;

      // Persist the new tokens
      this.storage.updateSettings({
        sentryAuth: { ...auth, accessToken: newAccessToken, refreshToken: newRefreshToken }
      } as any);
      const currentSentry = (this.storage.getSettings() as any).sentry || {};
      this.storage.updateSettings({
        sentry: { ...currentSentry, authToken: newAccessToken }
      } as any);

      console.log('[SentryAuth] Token refreshed successfully');
      return newAccessToken;
    } catch (err) {
      console.error('[SentryAuth] Token refresh error:', err);
      return null;
    }
  }

  private async fetchOrgs(token: string): Promise<Array<{ slug: string; name: string }>> {
    try {
      const res = await fetch('https://sentry.io/api/0/organizations/', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!res.ok) return [];
      const data = await res.json();
      return data.map((o: any) => ({ slug: o.slug, name: o.name || o.slug }));
    } catch {
      return [];
    }
  }
}
