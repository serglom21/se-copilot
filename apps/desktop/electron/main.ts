import * as Sentry from '@sentry/electron/main';
import { config as loadEnv } from 'dotenv';

// Load .env (looks in process.cwd() = apps/desktop during dev, app root when packaged)
loadEnv();

// Initialize Sentry at the very top

import { app, BrowserWindow, ipcMain, shell } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import { StorageService } from './services/storage';
import { LLMService } from './services/llm';
import { GeneratorService } from './services/generator';
import { GitHubService } from './services/github';
import { DataRunnerService } from './services/data-runner';
import { LiveDataGeneratorService } from './services/live-data-generator';
import { DeploymentService } from './services/deployment';
import { ExpoDeployService } from './services/expo-deploy';
import { SentryAPIService } from './services/sentry-api';
import { SentryAuthService } from './services/sentry-auth';
import { ExportService } from './services/export';
import { TraceIngestService } from './services/trace-ingest';
import { TrainingRunnerService, BUILTIN_SPECS } from './services/training-runner';
import { RulesBankService } from './services/rules-bank';

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
let liveDataGeneratorService: LiveDataGeneratorService;
let deploymentService: DeploymentService;
let expoDeployService: ExpoDeployService;
let sentryAPIService: SentryAPIService;
let sentryAuthService: SentryAuthService;
let exportService: ExportService;
let traceIngestService: TraceIngestService;
let trainingRunner: TrainingRunnerService;
let rulesBank: RulesBankService;

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
  generatorService = new GeneratorService(storage, llmService);
  githubService = new GitHubService(storage);
  dataRunnerService = new DataRunnerService(storage);
  sentryAPIService = new SentryAPIService(storage);
  sentryAuthService = new SentryAuthService(storage);
  liveDataGeneratorService = new LiveDataGeneratorService(storage, llmService, sentryAPIService);
  deploymentService = new DeploymentService(storage);
  expoDeployService = new ExpoDeployService(storage);
  exportService = new ExportService(storage);
  traceIngestService = new TraceIngestService(9999);
  // Auto-start the local trace ingest server on app launch
  traceIngestService.start().catch(e => console.warn('[TraceIngest] Auto-start failed (port in use?):', e.message));
  // Backup dir: ~/Documents/SE Copilot/ — outside app userData, survives crashes/reinstalls
  const backupDir = path.join(app.getPath('documents'), 'Pawprint');
  rulesBank = new RulesBankService(userDataPath, backupDir);
  llmService.setRulesBank(rulesBank);
  // Re-create GeneratorService with rulesBank so static generators are also rule-aware
  generatorService = new GeneratorService(storage, llmService, rulesBank);
  trainingRunner = new TrainingRunnerService(
    storage, llmService, generatorService, liveDataGeneratorService, traceIngestService, rulesBank
  );

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
    // Kill any zombie server processes running from the project's output directory
    const outputPath = storage.resolveOutputPath(projectId);
    if (outputPath) {
      await liveDataGeneratorService.killProcessesInDirectory(outputPath);
    }
    // Delete output folder on disk, then the project spec
    await storage.deleteProjectOutput(projectId);
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

  ipcMain.handle('chat:suggest-custom-spans', async (_, projectId: string) => {
    return llmService.suggestCustomSpans(projectId);
  });

  // Generation
  ipcMain.handle('generate:app', async (_, projectId: string) => {
    const project = storage.getProject(projectId);
    return generatorService.generateReferenceApp(
      project,
      (pct, label) => { win?.webContents.send('generate:progress', { pct, label }); },
      (line) => { win?.webContents.send('generate:output', line); }
    );
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

  // Data generation (Python script mode)
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

  // Live data generation (Puppeteer mode with real SDKs)
  ipcMain.handle('data:run-live', async (event, projectId: string, config: any) => {
    return liveDataGeneratorService.runLiveDataGenerator(
      projectId,
      config,
      (output) => {
        event.sender.send('data:output', output);
      },
      (error) => {
        event.sender.send('data:error', error);
      },
      traceIngestService
    );
  });

  // Stop live data generation
  ipcMain.handle('data:stop-live', async () => {
    return liveDataGeneratorService.stop();
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

  // Sentry API
  ipcMain.handle('sentry:verify-connection', async () => {
    return sentryAPIService.verifyConnection();
  });

  ipcMain.handle('sentry:create-dashboard', async (_, projectId: string, dashboardTitle?: string, credentials?: { authToken: string; organization: string }) => {
    return sentryAPIService.createDashboard(projectId, dashboardTitle, credentials);
  });

  ipcMain.handle('sentry:list-dashboards', async () => {
    return sentryAPIService.listDashboards();
  });

  ipcMain.handle('sentry:list-recent-trace-ids', async (_, projectSlug?: string) => {
    return sentryAPIService.listRecentTraceIds(projectSlug);
  });

  ipcMain.handle('sentry:fetch-trace-spans', async (_, traceIds: string[]) => {
    return sentryAPIService.fetchTraceSpans(traceIds);
  });

  // Sentry OAuth
  ipcMain.handle('sentry:start-oauth', async () => {
    return sentryAuthService.startOAuthFlow();
  });

  ipcMain.handle('sentry:get-oauth-status', async () => {
    return sentryAuthService.getAuthStatus();
  });

  ipcMain.handle('sentry:list-orgs', async () => {
    return sentryAuthService.listOrganizations();
  });

  ipcMain.handle('sentry:list-projects', async (_, orgSlug: string) => {
    return sentryAuthService.listProjects(orgSlug);
  });

  ipcMain.handle('sentry:get-project-dsn', async (_, orgSlug: string, projectSlug: string) => {
    return sentryAuthService.getProjectDsn(orgSlug, projectSlug);
  });

  ipcMain.handle('sentry:oauth-logout', async () => {
    return sentryAuthService.logout();
  });

  // File system
  ipcMain.handle('fs:get-output-path', async (_, projectId: string) => {
    return storage.getOutputPath(projectId);
  });

  ipcMain.handle('fs:read-file', async (_, filePath: string) => {
    const fs = await import('fs');
    return fs.readFileSync(filePath, 'utf-8');
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

  // Export Demo Package
  ipcMain.handle('export:demo-package', async (_, projectId: string) => {
    return exportService.generateDemoPackage(projectId);
  });

  // Browser
  ipcMain.handle('browser:open-in-chrome', async (_, url: string) => {
    return new Promise((resolve, reject) => {
      const command = process.platform === 'darwin'
        ? `open -a "Google Chrome" "${url}"`
        : process.platform === 'win32'
        ? `start chrome "${url}"`
        : `google-chrome "${url}"`;

      exec(command, (error) => {
        if (error) {
          console.error('Failed to open in Chrome:', error);
          // Fallback to default browser
          shell.openExternal(url);
        }
        resolve();
      });
    });
  });

  // Local Trace Ingest
  ipcMain.handle('trace:start-ingest', async () => {
    try {
      await traceIngestService.start();
      return { success: true, port: 9999, dsn: traceIngestService.getLocalDsn() };
    } catch (e: any) {
      return { success: false, error: String(e) };
    }
  });

  ipcMain.handle('trace:stop-ingest', async () => {
    traceIngestService.stop();
    return { success: true };
  });

  ipcMain.handle('trace:get-traces', async () => {
    return traceIngestService.getTraces();
  });

  ipcMain.handle('trace:clear', async () => {
    traceIngestService.clear();
    return { success: true };
  });

  ipcMain.handle('trace:status', async () => {
    return { running: traceIngestService.isRunning(), dsn: traceIngestService.getLocalDsn() };
  });

  // Training
  ipcMain.handle('training:get-specs', async () => {
    return BUILTIN_SPECS;
  });

  ipcMain.handle('training:start', async (event, config: any) => {
    if (trainingRunner.isRunning()) {
      return { success: false, error: 'Training already in progress' };
    }
    // Run async — results stream via events
    trainingRunner.runTraining(
      config,
      (msg) => event.sender.send('training:log', msg),
      (result) => event.sender.send('training:spec-result', result),
      (results) => event.sender.send('training:complete', results)
    ).catch(e => {
      event.sender.send('training:log', `❌ Fatal error: ${e.message}\n`);
      event.sender.send('training:complete', []);
    });
    return { success: true };
  });

  ipcMain.handle('training:stop', async () => {
    trainingRunner.stop();
    return { success: true };
  });

  ipcMain.handle('training:status', async () => {
    return { running: trainingRunner.isRunning() };
  });

  // Rules Bank
  ipcMain.handle('rules:list', async () => {
    return rulesBank.listRules();
  });

  ipcMain.handle('rules:delete', async (_, id: string) => {
    rulesBank.removeRule(id);
    return { success: true };
  });

  ipcMain.handle('rules:clear', async () => {
    rulesBank.clearAll();
    return { success: true };
  });
}

// Cleanup on app quit
app.on('before-quit', async () => {
  if (deploymentService) {
    deploymentService.stopAll();
  }
  if (liveDataGeneratorService) {
    await liveDataGeneratorService.stop();
  }
});
