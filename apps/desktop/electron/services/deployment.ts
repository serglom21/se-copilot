import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { StorageService } from './storage';
import { shell } from 'electron';

interface DeploymentStatus {
  frontend: {
    running: boolean;
    url: string;
    port: number;
  };
  backend: {
    running: boolean;
    url: string;
    port: number;
  };
}

interface RunningProcess {
  frontend?: ChildProcess;
  backend?: ChildProcess;
  frontendReady: boolean;
  backendReady: boolean;
}

export class DeploymentService {
  private storage: StorageService;
  private runningApps: Map<string, RunningProcess> = new Map();

  constructor(storage: StorageService) {
    this.storage = storage;
  }

  async deployApp(
    projectId: string,
    onOutput: (data: string) => void,
    onError: (error: string) => void
  ): Promise<{ success: boolean; error?: string; status?: DeploymentStatus }> {
    try {
      const project = this.storage.getProject(projectId);
      const outputPath = this.storage.getOutputPath(projectId);
      const appPath = path.join(outputPath, 'reference-app');

      if (!fs.existsSync(appPath)) {
        throw new Error('Reference app not found. Please generate it first.');
      }

      // Check if already running
      if (this.runningApps.has(projectId)) {
        onOutput('⚠️  App is already running. Stopping first...\n');
        await this.stopApp(projectId);
      }

      const runningProcess: RunningProcess = {
        frontendReady: false,
        backendReady: false
      };
      this.runningApps.set(projectId, runningProcess);

      // Check if this is a Python backend-only project
      const isPythonBackend = project.stack.type === 'backend-only';

      if (isPythonBackend) {
        return await this.deployPythonBackend(projectId, appPath, onOutput, onError);
      }

      // Web or mobile app with Express backend
      const frontendPath = path.join(appPath, 'frontend');
      const backendPath = path.join(appPath, 'backend');

      // Install dependencies
      onOutput('📦 Installing dependencies...\n\n');

      // Backend dependencies
      onOutput('Installing backend dependencies...\n');
      const backendInstallSuccess = await this.installDependencies(backendPath, onOutput);
      if (!backendInstallSuccess) {
        throw new Error('Failed to install backend dependencies');
      }
      onOutput('✅ Backend dependencies installed!\n\n');

      // Frontend dependencies
      onOutput('Installing frontend dependencies...\n');
      const frontendInstallSuccess = await this.installDependencies(frontendPath, onOutput);
      if (!frontendInstallSuccess) {
        throw new Error('Failed to install frontend dependencies');
      }
      onOutput('✅ Frontend dependencies installed!\n\n');

      // Start servers
      onOutput('🚀 Starting servers...\n\n');

      const backendPort = 3001;
      const frontendPort = 3000;

      // Start backend first
      await this.startBackend(projectId, backendPath, backendPort, onOutput, onError);
      onOutput('✅ Backend server started on port 3001\n\n');

      // Start frontend
      await this.startFrontend(projectId, frontendPath, frontendPort, backendPort, onOutput, onError);
      onOutput('✅ Frontend server started on port 3000\n\n');

      const status: DeploymentStatus = {
        backend: {
          running: true,
          url: `http://localhost:${backendPort}`,
          port: backendPort
        },
        frontend: {
          running: true,
          url: `http://localhost:${frontendPort}`,
          port: frontendPort
        }
      };

      onOutput('🎉 Deployment complete!\n');
      onOutput(`🌐 Frontend: ${status.frontend.url}\n`);
      onOutput(`🔧 Backend: ${status.backend.url}\n\n`);
      onOutput('Opening browser...\n');

      // Auto-open frontend in browser
      setTimeout(() => {
        shell.openExternal(status.frontend.url);
      }, 2000);

      return { success: true, status };
    } catch (error) {
      onError(String(error));
      return { success: false, error: String(error) };
    }
  }

  private async deployPythonBackend(
    projectId: string,
    appPath: string,
    onOutput: (data: string) => void,
    onError: (error: string) => void
  ): Promise<{ success: boolean; error?: string; status?: DeploymentStatus }> {
    try {
      const project = this.storage.getProject(projectId);
      const port = project.stack.backend === 'flask' ? 5000 : 8000;

      onOutput('📦 Installing Python dependencies...\n\n');
      const installSuccess = await this.installPythonDependencies(appPath, onOutput);
      if (!installSuccess) {
        throw new Error('Failed to install Python dependencies');
      }
      onOutput('✅ Python dependencies installed!\n\n');

      onOutput('🚀 Starting Python server...\n\n');
      await this.startPythonBackend(projectId, appPath, port, project.stack.backend, onOutput, onError);
      onOutput(`✅ Python server started on port ${port}\n\n`);

      const status: DeploymentStatus = {
        backend: {
          running: true,
          url: `http://localhost:${port}`,
          port: port
        },
        frontend: {
          running: false,
          url: '',
          port: 0
        }
      };

      onOutput('🎉 Deployment complete!\n');
      onOutput(`🐍 Python Backend: ${status.backend.url}\n`);
      if (project.stack.backend === 'fastapi') {
        onOutput(`📚 API Docs: ${status.backend.url}/docs\n`);
      }
      onOutput('\nOpening API in browser...\n');

      // Auto-open backend in browser
      const openUrl = project.stack.backend === 'fastapi' 
        ? `${status.backend.url}/docs`
        : status.backend.url;
      
      setTimeout(() => {
        shell.openExternal(openUrl);
      }, 2000);

      return { success: true, status };
    } catch (error) {
      onError(String(error));
      return { success: false, error: String(error) };
    }
  }

  private async installPythonDependencies(appPath: string, onOutput: (data: string) => void): Promise<boolean> {
    return new Promise((resolve) => {
      // Check if Python is installed
      const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
      
      onOutput(`Checking for Python installation...\n`);
      const checkPython = spawn(pythonCmd, ['--version'], { shell: true });
      
      checkPython.on('error', () => {
        onOutput('❌ Python not found. Please install Python 3.9+ first.\n');
        resolve(false);
      });

      checkPython.on('close', (code) => {
        if (code !== 0) {
          onOutput('❌ Python not found. Please install Python 3.9+ first.\n');
          resolve(false);
          return;
        }

        onOutput('Installing requirements...\n');
        const proc = spawn(pythonCmd, ['-m', 'pip', 'install', '-r', 'requirements.txt'], {
          cwd: appPath,
          shell: true
        });

        proc.stdout.on('data', (data) => {
          const text = data.toString();
          if (text.includes('Successfully installed') || text.includes('Requirement already satisfied')) {
            onOutput(text);
          }
        });

        proc.stderr.on('data', (data) => {
          const text = data.toString();
          if (!text.includes('WARNING')) {
            onOutput(text);
          }
        });

        proc.on('close', (code) => {
          resolve(code === 0);
        });

        proc.on('error', () => {
          resolve(false);
        });
      });
    });
  }

  private async startPythonBackend(
    projectId: string,
    appPath: string,
    port: number,
    framework: 'flask' | 'fastapi',
    onOutput: (data: string) => void,
    onError: (error: string) => void
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
      let args: string[];
      
      if (framework === 'fastapi') {
        args = ['-m', 'uvicorn', 'main:app', '--reload', '--host', '0.0.0.0', '--port', String(port)];
      } else {
        args = ['run.py'];
      }

      const proc = spawn(pythonCmd, args, {
        cwd: appPath,
        env: {
          ...process.env,
          PORT: String(port),
          PYTHONUNBUFFERED: '1'
        },
        shell: true
      });

      const runningProcess = this.runningApps.get(projectId);
      if (runningProcess) {
        runningProcess.backend = proc;
      }

      proc.stdout.on('data', (data) => {
        const text = data.toString();
        onOutput(`[Python] ${text}`);

        // Detect when server is ready
        if (text.includes('Uvicorn running') || 
            text.includes('Application startup complete') ||
            text.includes('Running on')) {
          const runningProcess = this.runningApps.get(projectId);
          if (runningProcess) {
            runningProcess.backendReady = true;
            resolve();
          }
        }
      });

      proc.stderr.on('data', (data) => {
        const text = data.toString();
        onOutput(`[Python] ${text}`);
      });

      proc.on('error', (error) => {
        onError(`Python server error: ${error.message}`);
        reject(error);
      });

      // Timeout after 30 seconds
      setTimeout(() => {
        const runningProcess = this.runningApps.get(projectId);
        if (runningProcess && !runningProcess.backendReady) {
          onOutput('[Python] Server started (timeout reached, assuming ready)\n');
          resolve();
        }
      }, 30000);
    });
  }

  async stopApp(projectId: string): Promise<void> {
    const runningProcess = this.runningApps.get(projectId);
    if (!runningProcess) {
      return;
    }

    if (runningProcess.frontend) {
      runningProcess.frontend.kill('SIGTERM');
    }

    if (runningProcess.backend) {
      runningProcess.backend.kill('SIGTERM');
    }

    this.runningApps.delete(projectId);
  }

  async getStatus(projectId: string): Promise<DeploymentStatus | null> {
    const runningProcess = this.runningApps.get(projectId);
    if (!runningProcess) {
      return null;
    }

    return {
      backend: {
        running: !!runningProcess.backend && !runningProcess.backend.killed,
        url: 'http://localhost:3001',
        port: 3001
      },
      frontend: {
        running: !!runningProcess.frontend && !runningProcess.frontend.killed,
        url: 'http://localhost:3000',
        port: 3000
      }
    };
  }

  stopAll(): void {
    for (const projectId of this.runningApps.keys()) {
      this.stopApp(projectId);
    }
  }

  private async installDependencies(appPath: string, onOutput: (data: string) => void): Promise<boolean> {
    return new Promise((resolve) => {
      const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      const proc = spawn(npmCmd, ['install'], {
        cwd: appPath,
        shell: true
      });

      proc.stdout.on('data', (data) => {
        const text = data.toString();
        // Only show important messages
        if (text.includes('added') || text.includes('packages')) {
          onOutput(text);
        }
      });

      proc.stderr.on('data', (data) => {
        const text = data.toString();
        if (!text.includes('npm WARN')) {
          onOutput(text);
        }
      });

      proc.on('close', (code) => {
        resolve(code === 0);
      });

      proc.on('error', () => {
        resolve(false);
      });
    });
  }

  private async startBackend(
    projectId: string,
    backendPath: string,
    port: number,
    onOutput: (data: string) => void,
    onError: (error: string) => void
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      const proc = spawn(npmCmd, ['run', 'dev'], {
        cwd: backendPath,
        env: {
          ...process.env,
          PORT: String(port)
        },
        shell: true
      });

      const runningProcess = this.runningApps.get(projectId);
      if (runningProcess) {
        runningProcess.backend = proc;
      }

      proc.stdout.on('data', (data) => {
        const text = data.toString();
        onOutput(`[Backend] ${text}`);

        // Detect when backend is ready
        if (text.includes('running on port') || text.includes('listening on')) {
          const runningProcess = this.runningApps.get(projectId);
          if (runningProcess) {
            runningProcess.backendReady = true;
            resolve();
          }
        }
      });

      proc.stderr.on('data', (data) => {
        const text = data.toString();
        onOutput(`[Backend] ${text}`);
      });

      proc.on('error', (error) => {
        onError(`Backend error: ${error.message}`);
        reject(error);
      });

      // Timeout after 30 seconds
      setTimeout(() => {
        const runningProcess = this.runningApps.get(projectId);
        if (runningProcess && !runningProcess.backendReady) {
          onOutput('[Backend] Server started (timeout reached, assuming ready)\n');
          resolve();
        }
      }, 30000);
    });
  }

  private async startFrontend(
    projectId: string,
    frontendPath: string,
    frontendPort: number,
    backendPort: number,
    onOutput: (data: string) => void,
    onError: (error: string) => void
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      const proc = spawn(npmCmd, ['run', 'dev'], {
        cwd: frontendPath,
        env: {
          ...process.env,
          PORT: String(frontendPort),
          NEXT_PUBLIC_API_URL: `http://localhost:${backendPort}`
        },
        shell: true
      });

      const runningProcess = this.runningApps.get(projectId);
      if (runningProcess) {
        runningProcess.frontend = proc;
      }

      proc.stdout.on('data', (data) => {
        const text = data.toString();
        onOutput(`[Frontend] ${text}`);

        // Detect when frontend is ready
        if (text.includes('Local:') || text.includes('ready')) {
          const runningProcess = this.runningApps.get(projectId);
          if (runningProcess) {
            runningProcess.frontendReady = true;
            resolve();
          }
        }
      });

      proc.stderr.on('data', (data) => {
        const text = data.toString();
        onOutput(`[Frontend] ${text}`);
      });

      proc.on('error', (error) => {
        onError(`Frontend error: ${error.message}`);
        reject(error);
      });

      // Timeout after 60 seconds (Next.js can take longer)
      setTimeout(() => {
        const runningProcess = this.runningApps.get(projectId);
        if (runningProcess && !runningProcess.frontendReady) {
          onOutput('[Frontend] Server started (timeout reached, assuming ready)\n');
          resolve();
        }
      }, 60000);
    });
  }
}
