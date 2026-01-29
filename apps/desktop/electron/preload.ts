import { contextBridge, ipcRenderer } from 'electron';

export interface IElectronAPI {
  // Settings
  getSettings: () => Promise<any>;
  updateSettings: (settings: any) => Promise<void>;

  // Projects
  listProjects: () => Promise<any[]>;
  getProject: (projectId: string) => Promise<any>;
  createProject: (project: any) => Promise<any>;
  updateProject: (projectId: string, updates: any) => Promise<any>;
  deleteProject: (projectId: string) => Promise<void>;

  // Chat
  sendChatMessage: (projectId: string, message: string) => Promise<any>;
  generatePlan: (projectId: string) => Promise<any>;

  // Generation
  generateApp: (projectId: string) => Promise<{ success: boolean; outputPath?: string; error?: string }>;
  generateGuide: (projectId: string) => Promise<{ success: boolean; outputPath?: string; error?: string }>;
  generateDashboard: (projectId: string) => Promise<{ success: boolean; outputPath?: string; error?: string }>;
  generateDataScript: (projectId: string) => Promise<{ success: boolean; outputPath?: string; error?: string }>;

  // GitHub
  startGitHubAuth: () => Promise<{ device_code: string; user_code: string; verification_uri: string }>;
  pollGitHubAuth: (deviceCode: string) => Promise<{ success: boolean; error?: string }>;
  getGitHubStatus: () => Promise<{ authenticated: boolean; username?: string }>;
  logoutGitHub: () => Promise<void>;
  createAndPushRepo: (projectId: string, repoName: string, isPrivate: boolean) => Promise<{ success: boolean; repoUrl?: string; error?: string }>;

  // File system
  getOutputPath: (projectId: string) => Promise<string>;

  // Data generation
  runDataGenerator: (projectId: string, config: any) => Promise<{ success: boolean; error?: string }>;
  onDataOutput: (callback: (output: string) => void) => () => void;
  onDataError: (callback: (error: string) => void) => () => void;

  // Deployment
  startDeployment: (projectId: string) => Promise<{ success: boolean; error?: string; status?: any }>;
  stopDeployment: (projectId: string) => Promise<void>;
  getDeploymentStatus: (projectId: string) => Promise<any>;
  onDeployOutput: (callback: (output: string) => void) => () => void;
  onDeployError: (callback: (error: string) => void) => () => void;

  // Expo Snack
  createExpoSnack: (projectId: string) => Promise<{ url: string; embedUrl: string; snackId: string }>;
  updateExpoSnack: (projectId: string) => Promise<{ url: string; embedUrl: string }>;
  getExpoSnackStatus: (projectId: string) => Promise<{ hasSnack: boolean; url?: string; embedUrl?: string }>;
  openExpoUrl: (url: string) => Promise<void>;

  // Code Refinement
  readGeneratedFiles: (projectId: string) => Promise<Record<string, string>>;
  analyzeGeneratedApp: (projectId: string) => Promise<{
    suggestions: Array<{
      file: string;
      suggestion: string;
      priority: 'high' | 'medium' | 'low';
    }>;
  }>;
  refineFile: (projectId: string, filePath: string, refinementRequest: string) => Promise<{ code: string; changes: string }>;
  regenerateArtifacts: (projectId: string) => Promise<{ success: boolean; guideError?: string; dashboardError?: string }>;

  // Events
  onMainProcessMessage: (callback: (message: string) => void) => void;
}

const electronAPI: IElectronAPI = {
  // Settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (settings) => ipcRenderer.invoke('settings:update', settings),

  // Projects
  listProjects: () => ipcRenderer.invoke('projects:list'),
  getProject: (projectId) => ipcRenderer.invoke('projects:get', projectId),
  createProject: (project) => ipcRenderer.invoke('projects:create', project),
  updateProject: (projectId, updates) => ipcRenderer.invoke('projects:update', projectId, updates),
  deleteProject: (projectId) => ipcRenderer.invoke('projects:delete', projectId),

  // Chat
  sendChatMessage: (projectId, message) => ipcRenderer.invoke('chat:send', projectId, message),
  generatePlan: (projectId) => ipcRenderer.invoke('chat:generate-plan', projectId),

  // Generation
  generateApp: (projectId) => ipcRenderer.invoke('generate:app', projectId),
  generateGuide: (projectId) => ipcRenderer.invoke('generate:guide', projectId),
  generateDashboard: (projectId) => ipcRenderer.invoke('generate:dashboard', projectId),
  generateDataScript: (projectId) => ipcRenderer.invoke('generate:data-script', projectId),

  // GitHub
  startGitHubAuth: () => ipcRenderer.invoke('github:start-auth'),
  pollGitHubAuth: (deviceCode) => ipcRenderer.invoke('github:poll-auth', deviceCode),
  getGitHubStatus: () => ipcRenderer.invoke('github:get-status'),
  logoutGitHub: () => ipcRenderer.invoke('github:logout'),
  createAndPushRepo: (projectId, repoName, isPrivate) => ipcRenderer.invoke('github:create-and-push', projectId, repoName, isPrivate),

  // File system
  getOutputPath: (projectId) => ipcRenderer.invoke('fs:get-output-path', projectId),

  // Data generation
  runDataGenerator: (projectId, config) => ipcRenderer.invoke('data:run', projectId, config),
  onDataOutput: (callback) => {
    const listener = (_event: any, output: string) => callback(output);
    ipcRenderer.on('data:output', listener);
    return () => ipcRenderer.removeListener('data:output', listener);
  },
  onDataError: (callback) => {
    const listener = (_event: any, error: string) => callback(error);
    ipcRenderer.on('data:error', listener);
    return () => ipcRenderer.removeListener('data:error', listener);
  },

  // Deployment
  startDeployment: (projectId) => ipcRenderer.invoke('deploy:start', projectId),
  stopDeployment: (projectId) => ipcRenderer.invoke('deploy:stop', projectId),
  getDeploymentStatus: (projectId) => ipcRenderer.invoke('deploy:status', projectId),
  onDeployOutput: (callback) => {
    const listener = (_event: any, output: string) => callback(output);
    ipcRenderer.on('deploy:output', listener);
    return () => ipcRenderer.removeListener('deploy:output', listener);
  },
  onDeployError: (callback) => {
    const listener = (_event: any, error: string) => callback(error);
    ipcRenderer.on('deploy:error', listener);
    return () => ipcRenderer.removeListener('deploy:error', listener);
  },

  // Expo Snack
  createExpoSnack: (projectId) => ipcRenderer.invoke('expo:create-snack', projectId),
  updateExpoSnack: (projectId) => ipcRenderer.invoke('expo:update-snack', projectId),
  getExpoSnackStatus: (projectId) => ipcRenderer.invoke('expo:get-status', projectId),
  openExpoUrl: (url) => ipcRenderer.invoke('expo:open-url', url),

  // Code Refinement
  readGeneratedFiles: (projectId) => ipcRenderer.invoke('refine:read-files', projectId),
  analyzeGeneratedApp: (projectId) => ipcRenderer.invoke('refine:analyze', projectId),
  refineFile: (projectId, filePath, refinementRequest) => ipcRenderer.invoke('refine:update-file', projectId, filePath, refinementRequest),
  regenerateArtifacts: (projectId) => ipcRenderer.invoke('refine:regenerate-artifacts', projectId),

  // Events
  onMainProcessMessage: (callback) => {
    ipcRenderer.on('main-process-message', (_event, message) => callback(message));
  }
};

contextBridge.exposeInMainWorld('electronAPI', electronAPI);
