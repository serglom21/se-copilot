import { app, BrowserWindow, ipcMain, shell } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { StorageService } from './services/storage';
import { LLMService } from './services/llm';
import { GeneratorService } from './services/generator';
import { GitHubService } from './services/github';
import { DataRunnerService } from './services/data-runner';
import { DeploymentService } from './services/deployment';
import { ExpoDeployService } from './services/expo-deploy';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

process.env.DIST = path.join(__dirname, '../dist');
process.env.VITE_PUBLIC = app.isPackaged
  ? process.env.DIST
  : path.join(process.env.DIST, '../public');

let win: BrowserWindow | null = null;
const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL'];

// Initialize services
let storage: StorageService;
let llmService: LLMService;
let generatorService: GeneratorService;
let githubService: GitHubService;
let dataRunnerService: DataRunnerService;
let deploymentService: DeploymentService;
let expoDeployService: ExpoDeployService;

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    icon: path.join(process.env.VITE_PUBLIC, 'electron-vite.svg'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  // Test active push message to Renderer-process.
  win.webContents.on('did-finish-load', () => {
    win?.webContents.send('main-process-message', new Date().toLocaleString());
  });

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL);
    win.webContents.openDevTools();
  } else {
    win.loadFile(path.join(process.env.DIST, 'index.html'));
  }
}

app.whenReady().then(async () => {
  // Initialize services
  const userDataPath = app.getPath('userData');
  storage = new StorageService(path.join(userDataPath, 'data'));
  llmService = new LLMService(storage);
  generatorService = new GeneratorService(storage);
  githubService = new GitHubService(storage);
  dataRunnerService = new DataRunnerService(storage);
  deploymentService = new DeploymentService(storage);
  expoDeployService = new ExpoDeployService(storage);

  setupIpcHandlers();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
    win = null;
  }
});

function setupIpcHandlers() {
  // Settings
  ipcMain.handle('settings:get', async () => {
    return storage.getSettings();
  });

  ipcMain.handle('settings:update', async (_, settings) => {
    return storage.updateSettings(settings);
  });

  // Projects
  ipcMain.handle('projects:list', async () => {
    return storage.listProjects();
  });

  ipcMain.handle('projects:get', async (_, projectId: string) => {
    return storage.getProject(projectId);
  });

  ipcMain.handle('projects:create', async (_, project) => {
    return storage.createProject(project);
  });

  ipcMain.handle('projects:update', async (_, projectId: string, updates) => {
    return storage.updateProject(projectId, updates);
  });

  ipcMain.handle('projects:delete', async (_, projectId: string) => {
    return storage.deleteProject(projectId);
  });

  // Chat
  ipcMain.handle('chat:send', async (_, projectId: string, message: string) => {
    return llmService.chat(projectId, message);
  });

  ipcMain.handle('chat:generate-plan', async (_, projectId: string) => {
    const project = storage.getProject(projectId);
    return llmService.generateInstrumentationPlan(project);
  });

  // Generation
  ipcMain.handle('generate:app', async (_, projectId: string) => {
    const project = storage.getProject(projectId);
    return generatorService.generateReferenceApp(project);
  });

  ipcMain.handle('generate:guide', async (_, projectId: string) => {
    const project = storage.getProject(projectId);
    return generatorService.generateImplementationGuide(project);
  });

  ipcMain.handle('generate:dashboard', async (_, projectId: string) => {
    const project = storage.getProject(projectId);
    return generatorService.generateDashboard(project);
  });

  ipcMain.handle('generate:data-script', async (_, projectId: string) => {
    const project = storage.getProject(projectId);
    return generatorService.generateDataScript(project);
  });

  // Data generation
  ipcMain.handle('data:run', async (event, projectId: string, config: any) => {
    return dataRunnerService.runDataGenerator(
      projectId,
      config,
      (output) => {
        event.sender.send('data:output', output);
      },
      (error) => {
        event.sender.send('data:error', error);
      }
    );
  });

  // GitHub
  ipcMain.handle('github:start-auth', async () => {
    return githubService.startDeviceFlow();
  });

  ipcMain.handle('github:poll-auth', async (_, deviceCode: string) => {
    return githubService.pollForAuth(deviceCode);
  });

  ipcMain.handle('github:get-status', async () => {
    return githubService.getAuthStatus();
  });

  ipcMain.handle('github:logout', async () => {
    return githubService.logout();
  });

  ipcMain.handle('github:create-and-push', async (_, projectId: string, repoName: string, isPrivate: boolean) => {
    const project = storage.getProject(projectId);
    return githubService.createRepoAndPush(project, repoName, isPrivate);
  });

  // File system
  ipcMain.handle('fs:get-output-path', async (_, projectId: string) => {
    return storage.getOutputPath(projectId);
  });

  // Deployment
  ipcMain.handle('deploy:start', async (event, projectId: string) => {
    return deploymentService.deployApp(
      projectId,
      (output) => {
        event.sender.send('deploy:output', output);
      },
      (error) => {
        event.sender.send('deploy:error', error);
      }
    );
  });

  ipcMain.handle('deploy:stop', async (_, projectId: string) => {
    return deploymentService.stopApp(projectId);
  });

  ipcMain.handle('deploy:status', async (_, projectId: string) => {
    return deploymentService.getStatus(projectId);
  });

  // Expo Snack
  ipcMain.handle('expo:create-snack', async (_, projectId: string) => {
    return expoDeployService.createSnack(projectId);
  });

  ipcMain.handle('expo:update-snack', async (_, projectId: string) => {
    return expoDeployService.updateSnack(projectId);
  });

  ipcMain.handle('expo:get-status', async (_, projectId: string) => {
    return expoDeployService.getSnackStatus(projectId);
  });

  ipcMain.handle('expo:open-url', async (_, url: string) => {
    await shell.openExternal(url);
  });

  // Code Refinement Handlers
  ipcMain.handle('refine:read-files', async (_, projectId: string) => {
    return generatorService.readGeneratedFiles(projectId);
  });

  ipcMain.handle('refine:analyze', async (_, projectId: string) => {
    const files = generatorService.readGeneratedFiles(projectId);
    const project = storage.getProject(projectId);
    return llmService.analyzeGeneratedApp(project, files);
  });

  ipcMain.handle('refine:update-file', async (_, projectId: string, filePath: string, refinementRequest: string) => {
    const files = generatorService.readGeneratedFiles(projectId);
    const existingCode = files[filePath];
    
    if (!existingCode) {
      throw new Error(`File not found: ${filePath}`);
    }
    
    const project = storage.getProject(projectId);
    const result = await llmService.refineGeneratedCode(
      project,
      filePath,
      existingCode,
      refinementRequest
    );
    
    generatorService.updateGeneratedFile(projectId, filePath, result.code);
    return result;
  });

  // Regenerate artifacts after refinement
  ipcMain.handle('refine:regenerate-artifacts', async (_, projectId: string) => {
    const project = storage.getProject(projectId);
    
    // Regenerate guide and dashboard with updated code
    const guideResult = await generatorService.generateImplementationGuide(project);
    const dashboardResult = await generatorService.generateDashboardJSON(project);
    
    return {
      success: guideResult.success && dashboardResult.success,
      guideError: guideResult.error,
      dashboardError: dashboardResult.error
    };
  });
}

// Cleanup on app quit
app.on('before-quit', () => {
  if (deploymentService) {
    deploymentService.stopAll();
  }
});
