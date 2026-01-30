import fs from 'fs';
import path from 'path';
import simpleGit, { SimpleGit } from 'simple-git';
import { StorageService } from './storage';
import { EngagementSpec } from '../../src/types/spec';

const GITHUB_CLIENT_ID = ''; // Public OAuth app client ID (to be configured)
const GITHUB_API_BASE = 'https://api.github.com';

export class GitHubService {
  private storage: StorageService;

  constructor(storage: StorageService) {
    this.storage = storage;
  }

  async startDeviceFlow(): Promise<{ device_code: string; user_code: string; verification_uri: string }> {
    // Note: For production, you'll need to create a GitHub OAuth App and use its client ID
    // For now, we'll use a placeholder that requires manual token input
    
    // Real device flow implementation:
    // const response = await fetch('https://github.com/login/device/code', {
    //   method: 'POST',
    //   headers: {
    //     'Content-Type': 'application/json',
    //     'Accept': 'application/json'
    //   },
    //   body: JSON.stringify({
    //     client_id: GITHUB_CLIENT_ID,
    //     scope: 'repo'
    //   })
    // });

    // For MVP, return a mock response that tells user to create a PAT
    return {
      device_code: 'mock_device_code',
      user_code: 'MOCK-CODE',
      verification_uri: 'https://github.com/settings/tokens/new?scopes=repo&description=SE%20Copilot'
    };
  }

  async pollForAuth(deviceCode: string): Promise<{ success: boolean; error?: string }> {
    // In a real implementation, this would poll GitHub's token endpoint
    // For MVP, we'll just check if user has manually entered a token
    
    const settings = this.storage.getSettings();
    if (settings.github.accessToken) {
      // Verify token by fetching user info
      try {
        const userInfo = await this.getUserInfo(settings.github.accessToken);
        
        // Update settings with username
        this.storage.updateSettings({
          github: {
            accessToken: settings.github.accessToken,
            username: userInfo.login
          }
        });
        
        console.log('GitHub token verified successfully:', userInfo.login);
        return { success: true };
      } catch (error) {
        console.error('GitHub token verification failed:', error);
        return { success: false, error: 'Invalid access token. Please check your token and try again.' };
      }
    }
    
    return { success: false, error: 'No token provided' };
  }

  async getAuthStatus(): Promise<{ authenticated: boolean; username?: string }> {
    const settings = this.storage.getSettings();
    if (settings.github.accessToken && settings.github.username) {
      return {
        authenticated: true,
        username: settings.github.username
      };
    }
    return { authenticated: false };
  }

  async logout(): Promise<void> {
    this.storage.updateSettings({
      github: {
        accessToken: undefined,
        username: undefined
      }
    });
  }

  async createRepoAndPush(
    project: EngagementSpec,
    repoName: string,
    isPrivate: boolean
  ): Promise<{ success: boolean; repoUrl?: string; error?: string; isUpdate?: boolean }> {
    try {
      const settings = this.storage.getSettings();
      if (!settings.github.accessToken) {
        throw new Error('Not authenticated with GitHub');
      }

      // Get app path
      const outputPath = this.storage.getOutputPath(project.id);
      const appPath = path.join(outputPath, 'reference-app');

      if (!fs.existsSync(appPath)) {
        throw new Error('Reference app not generated yet');
      }

      // Copy implementation guide and dashboard to repo root
      const guidePath = path.join(outputPath, 'IMPLEMENTATION_GUIDE.md');
      const dashboardPath = path.join(outputPath, 'sentry-dashboard.json');

      if (fs.existsSync(guidePath)) {
        fs.copyFileSync(guidePath, path.join(appPath, 'IMPLEMENTATION_GUIDE.md'));
      }
      if (fs.existsSync(dashboardPath)) {
        fs.copyFileSync(dashboardPath, path.join(appPath, 'sentry-dashboard.json'));
      }

      let repo: any;
      let isUpdate = false;
      let repoUrl: string;

      // Check if project already has a GitHub repo
      if (project.project.githubRepoUrl && project.project.githubRepoName) {
        console.log('Project already has a GitHub repo, pushing update...');
        isUpdate = true;
        repoUrl = project.project.githubRepoUrl;

        // Verify repo still exists
        try {
          await this.getRepo(project.project.githubRepoName, settings.github.accessToken);
          console.log('✓ Existing repo verified');
        } catch (error) {
          console.warn('Existing repo not found, will create new one');
          isUpdate = false;
        }
      }

      // Create new repo if needed
      if (!isUpdate) {
        console.log('Creating new GitHub repository...');

        // Check if repo with this name already exists
        try {
          const existingRepo = await this.getRepo(repoName, settings.github.accessToken);
          // Repo exists - ask user if they want to use it
          console.log('⚠️  Repo with this name already exists on GitHub');
          repoUrl = existingRepo.html_url;
          isUpdate = true;
          repo = existingRepo;

          // Update project to link to existing repo
          this.storage.updateProject(project.id, {
            project: {
              ...project.project,
              githubRepoUrl: repoUrl,
              githubRepoName: repoName
            }
          });
        } catch (error) {
          // Repo doesn't exist, create it
          repo = await this.createRepo(repoName, isPrivate, settings.github.accessToken);
          repoUrl = repo.html_url;
        }
      }

      // Initialize git and push
      const git: SimpleGit = simpleGit(appPath);
      const gitDir = path.join(appPath, '.git');

      if (isUpdate && fs.existsSync(gitDir)) {
        // Update existing repo
        console.log('Updating existing repository...');

        // Make sure we're on main branch
        try {
          await git.checkout('main');
        } catch {
          await git.checkoutLocalBranch('main');
        }

        // Add all changes
        await git.add('.');

        // Check if there are changes to commit
        const status = await git.status();
        if (status.files.length > 0) {
          const commitMessage = `Update: ${new Date().toISOString().split('T')[0]} - Regenerated with latest changes`;
          await git.commit(commitMessage);

          // Push updates
          await git.push('origin', 'main');
          console.log('✓ Changes pushed to existing repo');
        } else {
          console.log('No changes to push');
        }
      } else {
        // Initial push (new repo or repo without local git)
        console.log('Initializing repository...');

        // Clean up any existing .git directory
        if (fs.existsSync(gitDir)) {
          fs.rmSync(gitDir, { recursive: true, force: true });
        }

        await git.init();
        await git.addConfig('user.name', settings.github.username || 'SE Copilot');
        await git.addConfig('user.email', 'secopilot@sentry.io');

        // Create and checkout main branch
        await git.checkoutLocalBranch('main');

        await git.add('.');
        await git.commit(`Initial commit: ${project.project.name}\n\nGenerated by SE Copilot with Sentry instrumentation`);

        // Add remote - use https URL with token for push
        const remoteUrl = `https://${settings.github.accessToken}@github.com/${settings.github.username}/${repoName}.git`;
        await git.addRemote('origin', remoteUrl);

        // Push to main branch (force if repo already exists on GitHub)
        if (isUpdate) {
          await git.push(['-u', 'origin', 'main', '--force']);
          console.log('✓ Force pushed to existing repo');
        } else {
          await git.push(['-u', 'origin', 'main']);
          console.log('✓ Initial commit pushed');
        }
      }

      // Update project with repo info
      this.storage.updateProject(project.id, {
        project: {
          ...project.project,
          githubRepoUrl: repoUrl!,
          githubRepoName: repoName
        },
        status: 'published'
      });

      return {
        success: true,
        repoUrl: repoUrl!,
        isUpdate
      };
    } catch (error) {
      console.error('Error creating/pushing repo:', error);
      return {
        success: false,
        error: String(error)
      };
    }
  }

  private async getRepo(repoName: string, token: string): Promise<any> {
    const response = await fetch(`${GITHUB_API_BASE}/repos/${this.storage.getSettings().github.username}/${repoName}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    });

    if (!response.ok) {
      throw new Error(`Repo not found: ${response.status}`);
    }

    return response.json();
  }

  private async createRepo(name: string, isPrivate: boolean, token: string): Promise<any> {
    const response = await fetch(`${GITHUB_API_BASE}/user/repos`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      body: JSON.stringify({
        name,
        private: isPrivate,
        description: 'Reference app generated by SE Copilot',
        auto_init: false
      })
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to create repo: ${response.status} ${error}`);
    }

    return response.json();
  }

  private async getUserInfo(token: string): Promise<any> {
    const response = await fetch(`${GITHUB_API_BASE}/user`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    });

    if (!response.ok) {
      throw new Error('Failed to fetch user info');
    }

    return response.json();
  }
}
