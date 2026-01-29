import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { StorageService } from './storage';

export interface DataGenConfig {
  frontendDsn?: string;
  backendDsn?: string;
  numTraces: number;
  numErrors: number;
  environment: string;
}

export class DataRunnerService {
  private storage: StorageService;

  constructor(storage: StorageService) {
    this.storage = storage;
  }

  async runDataGenerator(
    projectId: string,
    config: DataGenConfig,
    onOutput: (data: string) => void,
    onError: (error: string) => void
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const project = this.storage.getProject(projectId);
      const outputPath = this.storage.getOutputPath(projectId);
      const scriptPath = path.join(outputPath, 'generate_data.py');

      // Check if script exists
      if (!fs.existsSync(scriptPath)) {
        throw new Error('Data generation script not found. Please generate it first.');
      }

      // Check if Python is installed
      const pythonCommand = await this.getPythonCommand();
      if (!pythonCommand) {
        throw new Error('Python is not installed. Please install Python 3.7+ to run data generation.');
      }

      onOutput(`✓ Found Python: ${pythonCommand}\n`);

      // Create .env file with configuration
      const envPath = path.join(outputPath, '.env');
      const envContent = `SENTRY_DSN_FRONTEND=${config.frontendDsn || ''}
SENTRY_DSN_BACKEND=${config.backendDsn || ''}
NUM_TRACES=${config.numTraces}
NUM_ERRORS=${config.numErrors}
SENTRY_ENVIRONMENT=${config.environment}
`;
      fs.writeFileSync(envPath, envContent);
      onOutput('✓ Configuration saved\n\n');

      // Always install/upgrade dependencies to ensure they're available
      const requirementsPath = path.join(outputPath, 'requirements.txt');
      if (fs.existsSync(requirementsPath)) {
        onOutput('📦 Installing Python dependencies...\n');
        onOutput('(This may take a minute on first run)\n\n');
        
        // Install dependencies with better error handling
        const installSuccess = await this.installDependenciesRobust(pythonCommand, outputPath, onOutput, onError);
        
        if (!installSuccess) {
          return { 
            success: false, 
            error: 'Failed to install Python dependencies. Please check the output above for details.' 
          };
        }
        
        onOutput('\n✅ All dependencies ready!\n\n');
      }

      // Run the Python script
      return new Promise((resolve) => {
        onOutput('\n🚀 Starting data generation...\n\n');

        const pythonProcess = spawn(pythonCommand, [scriptPath], {
          cwd: outputPath,
          env: { ...process.env, PYTHONUNBUFFERED: '1' }
        });

        pythonProcess.stdout.on('data', (data) => {
          onOutput(data.toString());
        });

        pythonProcess.stderr.on('data', (data) => {
          const errorText = data.toString();
          // Some stderr output might just be warnings, not errors
          if (errorText.includes('Error') || errorText.includes('Exception')) {
            onError(errorText);
          } else {
            onOutput(errorText);
          }
        });

        pythonProcess.on('close', (code) => {
          if (code === 0) {
            onOutput('\n✅ Data generation completed successfully!\n');
            resolve({ success: true });
          } else {
            const error = `Process exited with code ${code}`;
            onError(error);
            resolve({ success: false, error });
          }
        });

        pythonProcess.on('error', (error) => {
          onError(error.message);
          resolve({ success: false, error: error.message });
        });
      });
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  private async getPythonCommand(): Promise<string | null> {
    // Try different Python commands
    const commands = ['python3', 'python'];

    for (const cmd of commands) {
      try {
        const result = await this.execCommand(cmd, ['--version']);
        if (result.includes('Python 3')) {
          return cmd;
        }
      } catch (error) {
        continue;
      }
    }

    return null;
  }

  private async installDependenciesRobust(
    pythonCommand: string,
    outputPath: string,
    onOutput: (data: string) => void,
    onError: (error: string) => void
  ): Promise<boolean> {
    // Try multiple installation methods
    const methods = [
      // Method 1: pip install with --user flag (most reliable)
      {
        name: 'pip with --user',
        args: ['-m', 'pip', 'install', '--user', '--upgrade', '-r', 'requirements.txt']
      },
      // Method 2: pip install without --user
      {
        name: 'pip standard',
        args: ['-m', 'pip', 'install', '--upgrade', '-r', 'requirements.txt']
      },
      // Method 3: pip3 directly
      {
        name: 'pip3 direct',
        command: 'pip3',
        args: ['install', '--user', '--upgrade', '-r', 'requirements.txt']
      }
    ];

    for (const method of methods) {
      onOutput(`Trying: ${method.name}...\n`);
      
      const success = await new Promise<boolean>((resolve) => {
        const cmd = method.command || pythonCommand;
        const proc = spawn(cmd, method.args, {
          cwd: outputPath,
          shell: true // Use shell to ensure PATH is available
        });

        let output = '';
        let errorOutput = '';

        proc.stdout.on('data', (data) => {
          const text = data.toString();
          output += text;
          // Only show important messages to avoid clutter
          if (text.includes('Installing') || text.includes('Successfully')) {
            onOutput(text);
          }
        });

        proc.stderr.on('data', (data) => {
          const text = data.toString();
          errorOutput += text;
          // stderr often contains warnings, not just errors
          if (!text.includes('WARNING') && !text.includes('DEPRECATION')) {
            onOutput(text);
          }
        });

        proc.on('close', (code) => {
          if (code === 0) {
            onOutput(`✓ ${method.name} succeeded!\n`);
            resolve(true);
          } else {
            onOutput(`✗ ${method.name} failed (exit code ${code})\n`);
            if (errorOutput) {
              onError(errorOutput);
            }
            resolve(false);
          }
        });

        proc.on('error', (err) => {
          onOutput(`✗ ${method.name} error: ${err.message}\n`);
          resolve(false);
        });

        // Timeout after 2 minutes
        setTimeout(() => {
          proc.kill();
          onOutput(`✗ ${method.name} timed out\n`);
          resolve(false);
        }, 120000);
      });

      if (success) {
        // Verify packages are actually installed
        const verified = await this.verifyPackages(pythonCommand, outputPath, onOutput);
        if (verified) {
          return true;
        } else {
          onOutput('Packages installed but verification failed, trying next method...\n');
        }
      }
    }

    // All methods failed
    onError('All installation methods failed. Please install manually:\n');
    onError(`cd ${outputPath}\n`);
    onError(`pip3 install --user sentry-sdk faker requests python-dotenv\n`);
    return false;
  }

  private async verifyPackages(
    pythonCommand: string,
    outputPath: string,
    onOutput: (data: string) => void
  ): Promise<boolean> {
    onOutput('Verifying packages...\n');
    
    const packages = ['sentry_sdk', 'faker', 'requests', 'dotenv'];
    
    for (const pkg of packages) {
      const result = await this.checkPackage(pythonCommand, pkg);
      if (!result) {
        onOutput(`✗ Package '${pkg}' not found\n`);
        return false;
      }
    }
    
    onOutput('✓ All packages verified!\n');
    return true;
  }

  private async checkPackage(pythonCommand: string, packageName: string): Promise<boolean> {
    return new Promise((resolve) => {
      const proc = spawn(pythonCommand, ['-c', `import ${packageName}`]);
      
      proc.on('close', (code) => {
        resolve(code === 0);
      });

      proc.on('error', () => {
        resolve(false);
      });

      // Timeout after 5 seconds
      setTimeout(() => {
        proc.kill();
        resolve(false);
      }, 5000);
    });
  }

  private execCommand(command: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn(command, args);
      let output = '';

      proc.stdout.on('data', (data) => {
        output += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve(output);
        } else {
          reject(new Error(`Command failed with code ${code}`));
        }
      });

      proc.on('error', reject);
    });
  }
}
