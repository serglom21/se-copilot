import { spawn, ChildProcess, exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import puppeteer, { Browser, Page } from 'puppeteer';
import { StorageService } from './storage';
import { EngagementSpec } from '../../src/types/spec';

export interface LiveDataGenConfig {
  frontendDsn: string;
  backendDsn: string;
  numTraces: number;
  numErrors: number;
  environment: string;
}

export interface UserFlow {
  name: string;
  description: string;
  steps: FlowStep[];
}

export interface FlowStep {
  action: 'navigate' | 'click' | 'type' | 'wait' | 'scroll' | 'select' | 'submit' | 'error';
  selector?: string;
  value?: string;
  url?: string;
  duration?: number;
  description?: string;
}

export class LiveDataGeneratorService {
  private storage: StorageService;
  private backendProcess: ChildProcess | null = null;
  private frontendProcess: ChildProcess | null = null;
  private browser: Browser | null = null;
  private isRunning: boolean = false;

  // Default ports
  private readonly BACKEND_PORT = 3001;
  private readonly FRONTEND_PORT = 3000;

  constructor(storage: StorageService) {
    this.storage = storage;
  }

  async runLiveDataGenerator(
    projectId: string,
    config: LiveDataGenConfig,
    onOutput: (data: string) => void,
    onError: (error: string) => void
  ): Promise<{ success: boolean; error?: string }> {
    if (this.isRunning) {
      return { success: false, error: 'Data generator is already running' };
    }

    this.isRunning = true;

    try {
      const project = this.storage.getProject(projectId);
      const outputPath = this.storage.getOutputPath(projectId);
      const appPath = path.join(outputPath, 'reference-app');

      // Check if reference app exists
      if (!fs.existsSync(appPath)) {
        throw new Error('Reference app not found. Please generate the app first.');
      }

      // Load user flows
      const flowsPath = path.join(outputPath, 'user-flows.json');
      let userFlows: UserFlow[];
      
      if (fs.existsSync(flowsPath)) {
        userFlows = JSON.parse(fs.readFileSync(flowsPath, 'utf-8'));
      } else {
        // Generate default flows based on project type
        userFlows = this.generateDefaultFlows(project);
        fs.writeFileSync(flowsPath, JSON.stringify(userFlows, null, 2));
      }

      onOutput('🚀 Starting Live Data Generator\n');
      onOutput('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n');

      // Step 1: Configure environment with DSNs
      onOutput('📝 Step 1: Configuring Sentry DSNs...\n');
      await this.configureDsns(appPath, config, project);
      onOutput('   ✓ DSNs configured\n\n');

      // Step 2: Install dependencies if needed
      onOutput('📦 Step 2: Checking dependencies...\n');
      await this.ensureDependencies(appPath, project, onOutput);
      onOutput('   ✓ Dependencies ready\n\n');

      // Step 3: Start backend server
      onOutput('🖥️  Step 3: Starting backend server...\n');
      await this.startBackend(appPath, project, onOutput, onError);
      onOutput(`   ✓ Backend running on port ${this.BACKEND_PORT}\n\n`);

      // Step 4: Start frontend server (if not backend-only)
      if (project.stack.type !== 'backend-only') {
        onOutput('🌐 Step 4: Starting frontend server...\n');
        await this.startFrontend(appPath, project, onOutput, onError);
        onOutput(`   ✓ Frontend running on port ${this.FRONTEND_PORT}\n\n`);
      }

      // Step 5: Wait for servers to be ready
      onOutput('⏳ Step 5: Waiting for servers to be ready...\n');
      await this.waitForServers(project);
      onOutput('   ✓ Servers are ready\n\n');

      // Step 6: Launch Puppeteer and execute flows
      onOutput('🎭 Step 6: Launching browser automation...\n');
      await this.launchBrowser();
      onOutput('   ✓ Browser launched\n\n');

      // Step 7: Execute user flows
      onOutput(`📊 Step 7: Executing ${config.numTraces} trace iterations...\n`);
      onOutput('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

      const errorRate = config.numErrors / config.numTraces;
      
      for (let i = 0; i < config.numTraces; i++) {
        const flowIndex = i % userFlows.length;
        const flow = userFlows[flowIndex];
        const shouldError = Math.random() < errorRate;

        onOutput(`\n[${i + 1}/${config.numTraces}] Running: ${flow.name}${shouldError ? ' (with error)' : ''}\n`);
        
        try {
          await this.executeFlow(flow, shouldError, project, onOutput);
          onOutput(`   ✓ Completed\n`);
        } catch (error) {
          onOutput(`   ⚠️ Flow error (this generates error telemetry): ${error}\n`);
        }

        // Small delay between iterations to spread out the data
        await this.delay(500 + Math.random() * 1000);
      }

      onOutput('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
      onOutput('✅ Live data generation completed!\n\n');
      onOutput('📈 Your Sentry dashboard should now show:\n');
      onOutput('   • Connected distributed traces (FE ↔ BE)\n');
      onOutput('   • Real SDK automatic instrumentation\n');
      onOutput('   • Web Vitals and performance metrics\n');
      onOutput('   • Custom spans with attributes\n');

      return { success: true };

    } catch (error) {
      onError(String(error));
      return { success: false, error: String(error) };
    } finally {
      // Cleanup
      await this.cleanup(onOutput);
      this.isRunning = false;
    }
  }

  private async configureDsns(appPath: string, config: LiveDataGenConfig, project: EngagementSpec): Promise<void> {
    const isBackendOnly = project.stack.type === 'backend-only';
    const isPythonBackend = project.stack.backend === 'flask' || project.stack.backend === 'fastapi';

    if (!isBackendOnly) {
      // Frontend .env
      const frontendEnvPath = path.join(appPath, 'frontend', '.env.local');
      const frontendEnv = `NEXT_PUBLIC_SENTRY_DSN=${config.frontendDsn}
NEXT_PUBLIC_SENTRY_ENVIRONMENT=${config.environment}
NEXT_PUBLIC_API_URL=http://localhost:${this.BACKEND_PORT}
`;
      fs.writeFileSync(frontendEnvPath, frontendEnv);
    }

    // Backend .env
    const backendPath = path.join(appPath, isPythonBackend ? '' : 'backend');
    const backendEnvPath = path.join(backendPath, '.env');
    const backendEnv = `SENTRY_DSN=${config.backendDsn}
SENTRY_ENVIRONMENT=${config.environment}
PORT=${this.BACKEND_PORT}
`;
    fs.writeFileSync(backendEnvPath, backendEnv);
  }

  private async ensureDependencies(
    appPath: string, 
    project: EngagementSpec, 
    onOutput: (data: string) => void
  ): Promise<void> {
    const isBackendOnly = project.stack.type === 'backend-only';
    const isPythonBackend = project.stack.backend === 'flask' || project.stack.backend === 'fastapi';

    // Check/install backend dependencies
    if (isPythonBackend) {
      const requirementsPath = path.join(appPath, 'requirements.txt');
      if (fs.existsSync(requirementsPath)) {
        onOutput('   Installing Python dependencies...\n');
        await this.runCommand('pip3', ['install', '-r', 'requirements.txt', '-q'], appPath);
      }
    } else {
      const backendPath = path.join(appPath, 'backend');
      const nodeModulesPath = path.join(backendPath, 'node_modules');
      if (!fs.existsSync(nodeModulesPath)) {
        onOutput('   Installing backend dependencies...\n');
        await this.runCommand('npm', ['install'], backendPath);
      }
    }

    // Check/install frontend dependencies
    if (!isBackendOnly) {
      const frontendPath = path.join(appPath, 'frontend');
      const nodeModulesPath = path.join(frontendPath, 'node_modules');
      if (!fs.existsSync(nodeModulesPath)) {
        onOutput('   Installing frontend dependencies...\n');
        await this.runCommand('npm', ['install'], frontendPath);
      }
    }
  }

  private async startBackend(
    appPath: string,
    project: EngagementSpec,
    onOutput: (data: string) => void,
    onError: (error: string) => void
  ): Promise<void> {
    const isPythonBackend = project.stack.backend === 'flask' || project.stack.backend === 'fastapi';
    
    return new Promise((resolve, reject) => {
      let command: string;
      let args: string[];
      let cwd: string;

      if (isPythonBackend) {
        cwd = appPath;
        if (project.stack.backend === 'fastapi') {
          command = 'uvicorn';
          args = ['main:app', '--host', '0.0.0.0', '--port', String(this.BACKEND_PORT)];
        } else {
          command = 'python3';
          args = ['app.py'];
        }
      } else {
        cwd = path.join(appPath, 'backend');
        command = 'npm';
        args = ['run', 'dev'];
      }

      this.backendProcess = spawn(command, args, {
        cwd,
        env: { ...process.env, PORT: String(this.BACKEND_PORT) },
        shell: true
      });

      let started = false;

      this.backendProcess.stdout?.on('data', (data) => {
        const output = data.toString().toLowerCase();
        if (!started && (output.includes('listening') || output.includes('running') || output.includes('uvicorn') || output.includes('started'))) {
          started = true;
          resolve();
        }
      });

      this.backendProcess.stderr?.on('data', (data) => {
        const output = data.toString().toLowerCase();
        // Some frameworks output to stderr for info messages
        if (output.includes('listening') || output.includes('running') || output.includes('uvicorn') || output.includes('started')) {
          if (!started) {
            started = true;
            resolve();
          }
        }
      });

      this.backendProcess.on('error', (error) => {
        reject(new Error(`Failed to start backend: ${error.message}`));
      });

      // Timeout after 30 seconds
      setTimeout(() => {
        if (!started) {
          started = true;
          // Assume it's running even without explicit message
          resolve();
        }
      }, 30000);
    });
  }

  private async startFrontend(
    appPath: string,
    project: EngagementSpec,
    onOutput: (data: string) => void,
    onError: (error: string) => void
  ): Promise<void> {
    const frontendPath = path.join(appPath, 'frontend');

    return new Promise((resolve, reject) => {
      this.frontendProcess = spawn('npm', ['run', 'dev'], {
        cwd: frontendPath,
        env: { ...process.env, PORT: String(this.FRONTEND_PORT) },
        shell: true
      });

      let started = false;

      this.frontendProcess.stdout?.on('data', (data) => {
        const output = data.toString();
        if (!started && (output.includes('Ready') || output.includes('localhost') || output.includes('started'))) {
          started = true;
          resolve();
        }
      });

      this.frontendProcess.stderr?.on('data', (data) => {
        // Next.js outputs some info to stderr
        const output = data.toString();
        if (!started && (output.includes('Ready') || output.includes('localhost'))) {
          started = true;
          resolve();
        }
      });

      this.frontendProcess.on('error', (error) => {
        reject(new Error(`Failed to start frontend: ${error.message}`));
      });

      // Timeout after 60 seconds (Next.js can take a while to compile)
      setTimeout(() => {
        if (!started) {
          started = true;
          resolve();
        }
      }, 60000);
    });
  }

  private async waitForServers(project: EngagementSpec): Promise<void> {
    const maxAttempts = 30;
    const delay = 1000;

    // Wait for backend
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const response = await fetch(`http://localhost:${this.BACKEND_PORT}/health`);
        if (response.ok) break;
      } catch {
        // Server not ready yet
      }
      await this.delay(delay);
    }

    // Wait for frontend (if applicable)
    if (project.stack.type !== 'backend-only') {
      for (let i = 0; i < maxAttempts; i++) {
        try {
          const response = await fetch(`http://localhost:${this.FRONTEND_PORT}`);
          if (response.ok) break;
        } catch {
          // Server not ready yet
        }
        await this.delay(delay);
      }
    }
  }

  private async launchBrowser(): Promise<void> {
    this.browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    });
  }

  private async executeFlow(
    flow: UserFlow, 
    shouldError: boolean,
    project: EngagementSpec,
    onOutput: (data: string) => void
  ): Promise<void> {
    if (!this.browser) {
      throw new Error('Browser not initialized');
    }

    const page = await this.browser.newPage();

    try {
      // Set a realistic viewport
      await page.setViewport({ width: 1280, height: 800 });

      // Set user agent
      await page.setUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      );

      // Execute each step in the flow, but don't fail the whole flow on step errors
      for (const step of flow.steps) {
        // Skip error step if we shouldn't generate errors
        if (step.action === 'error' && !shouldError) {
          continue;
        }

        try {
          await this.executeStep(page, step, project, onOutput);
        } catch (stepError) {
          // Log but continue - we still want to capture traces
          // The pageload itself generates valuable telemetry
        }
      }

      // If we should inject an error and no error step was defined
      if (shouldError && !flow.steps.some(s => s.action === 'error')) {
        await this.injectError(page, project);
      }

      // Wait for Sentry to flush data
      await this.delay(2000);

    } finally {
      await page.close();
    }
  }

  private async executeStep(
    page: Page, 
    step: FlowStep,
    project: EngagementSpec,
    onOutput: (data: string) => void
  ): Promise<void> {
    const baseUrl = project.stack.type === 'backend-only' 
      ? `http://localhost:${this.BACKEND_PORT}`
      : `http://localhost:${this.FRONTEND_PORT}`;

    switch (step.action) {
      case 'navigate':
        const url = step.url?.startsWith('http') ? step.url : `${baseUrl}${step.url || '/'}`;
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        break;

      case 'click':
        if (step.selector) {
          await this.safeClick(page, step.selector);
        }
        break;

      case 'type':
        if (step.selector && step.value) {
          await this.safeType(page, step.selector, step.value);
        }
        break;

      case 'wait':
        await this.delay(step.duration || 1000);
        break;

      case 'scroll':
        await page.evaluate(() => {
          window.scrollTo(0, document.body.scrollHeight / 2);
        });
        break;

      case 'select':
        if (step.selector && step.value) {
          const element = await page.$(step.selector);
          if (element) {
            await page.select(step.selector, step.value);
          }
        }
        break;

      case 'submit':
        if (step.selector) {
          await this.safeClick(page, step.selector);
          // Wait for navigation if it happens
          await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 5000 }).catch(() => {});
        }
        break;

      case 'error':
        await this.injectError(page, project);
        break;
    }

    // Small delay between steps
    await this.delay(200 + Math.random() * 300);
  }

  /**
   * Safely click an element, trying multiple selector strategies
   */
  private async safeClick(page: Page, selector: string): Promise<boolean> {
    // Split selector by comma to try multiple options
    const selectors = selector.split(',').map(s => s.trim());
    
    for (const sel of selectors) {
      try {
        // Skip jQuery-style :contains selectors, use XPath instead
        if (sel.includes(':contains(')) {
          const match = sel.match(/:contains\(["']?([^"')]+)["']?\)/);
          if (match) {
            const text = match[1];
            const baseSelector = sel.split(':contains')[0].trim() || '*';
            const elements = await page.$x(`//${baseSelector === '*' ? '*' : baseSelector.replace(/[[\]]/g, '')}[contains(text(), "${text}")]`);
            if (elements.length > 0) {
              await (elements[0] as any).click();
              return true;
            }
          }
          continue;
        }
        
        const element = await page.$(sel);
        if (element) {
          await element.click();
          return true;
        }
      } catch (e) {
        // Try next selector
      }
    }
    
    // Fallback: try to find any clickable element (button or link)
    try {
      const fallbackElement = await page.$('button, a[href], [role="button"]');
      if (fallbackElement) {
        await fallbackElement.click();
        return true;
      }
    } catch (e) {
      // Ignore
    }
    
    return false;
  }

  /**
   * Safely type into an input, trying multiple selector strategies
   */
  private async safeType(page: Page, selector: string, value: string): Promise<boolean> {
    const selectors = selector.split(',').map(s => s.trim());
    
    for (const sel of selectors) {
      try {
        const element = await page.$(sel);
        if (element) {
          await element.type(value, { delay: 30 });
          return true;
        }
      } catch (e) {
        // Try next selector
      }
    }
    
    // Fallback: find any visible input
    try {
      const inputs = await page.$$('input:not([type="hidden"]):not([type="submit"]):not([type="button"])');
      if (inputs.length > 0) {
        await inputs[0].type(value, { delay: 30 });
        return true;
      }
    } catch (e) {
      // Ignore
    }
    
    return false;
  }

  private async injectError(page: Page, project: EngagementSpec): Promise<void> {
    // Build project-relevant error messages from the span definitions
    const spanNames = project.instrumentation.spans.map(s => s.name);
    const projectName = project.project.name;

    const errorPool = [
      { type: 'Error', message: `Failed to complete operation in ${projectName}` },
      { type: 'TypeError', message: "Cannot read properties of undefined (reading 'data')" },
      { type: 'Error', message: 'Network request failed: 503 Service Unavailable' },
      { type: 'Error', message: 'Unexpected server response during processing' },
    ];

    // Add span-specific errors so they appear tied to the instrumented operations
    for (const name of spanNames.slice(0, 3)) {
      errorPool.push({ type: 'Error', message: `${name} failed: unexpected state` });
    }

    const error = errorPool[Math.floor(Math.random() * errorPool.length)];

    await page.evaluate((errorInfo) => {
      const err = new Error(errorInfo.message);
      err.name = errorInfo.type;
      if ((window as any).Sentry) {
        (window as any).Sentry.captureException(err);
      } else {
        throw err;
      }
    }, error);
  }

  /**
   * Generate user flows derived from the project's instrumentation spans and
   * the actual page routes that were generated. Falls back to scanning the
   * filesystem if the flows file doesn't exist yet.
   */
  private generateDefaultFlows(project: EngagementSpec): UserFlow[] {
    const isBackendOnly = project.stack.type === 'backend-only';
    const frontendSpans = project.instrumentation.spans.filter(s => s.layer === 'frontend');
    const backendSpans = project.instrumentation.spans.filter(s => s.layer === 'backend');

    // Try to scan actual page routes from the generated app
    const outputPath = this.storage.getOutputPath(project.id);
    const appPath = path.join(outputPath, 'reference-app');
    const pageRoutes = this.scanGeneratedPageRoutes(appPath, project);

    const flows: UserFlow[] = [];

    if (isBackendOnly) {
      for (const span of backendSpans.slice(0, 5)) {
        const route = this.deriveRouteFromSpan(span.name, span.op, []);
        flows.push({
          name: this.humanizeName(span.name),
          description: span.description || `Exercise ${span.name}`,
          steps: [
            { action: 'navigate', url: route, description: `Call ${route}` },
            { action: 'wait', duration: 1000 }
          ]
        });
      }
      if (flows.length === 0) {
        flows.push({ name: 'API Health Check', description: 'Check API', steps: [{ action: 'navigate', url: '/health' }, { action: 'wait', duration: 1000 }] });
      }
    } else if (frontendSpans.length > 0 || (!isBackendOnly && backendSpans.length > 0)) {
      // Use frontend spans when available; fall back to backend spans for web projects
      // (backend spans on a web project are triggered by frontend form actions)
      const spansToUse = frontendSpans.length > 0 ? frontendSpans : backendSpans.slice(0, 5);
      for (const span of spansToUse) {
        const route = this.deriveRouteFromSpan(span.name, span.op, pageRoutes);
        const steps: FlowStep[] = [
          { action: 'navigate', url: route, description: `Navigate to ${route}` },
          { action: 'wait', duration: 1500 }
        ];

        const isFormAction = ['login', 'logout', 'register', 'signup', 'submit', 'validate',
          'reset', 'create', 'update', 'delete', 'search', 'upload', 'checkout', 'pay',
          'verify', 'confirm', 'auth'].some(kw =>
          span.op.toLowerCase().includes(kw) || span.name.toLowerCase().includes(kw)
        );

        if (isFormAction) {
          steps.push(...this.buildFormSteps(span));
        } else {
          steps.push({ action: 'scroll', description: 'Scroll page' });
          steps.push({ action: 'wait', duration: 1500 });
        }

        flows.push({
          name: this.humanizeName(span.name),
          description: span.description || `Exercise ${span.name}`,
          steps
        });
      }
    } else if (pageRoutes.length > 0) {
      for (const route of pageRoutes.slice(0, 5)) {
        const label = route === '/' ? 'Home' : route.replace(/^\//, '').replace(/-/g, ' ');
        flows.push({
          name: `Browse ${label.charAt(0).toUpperCase() + label.slice(1)}`,
          description: `User visits ${route}`,
          steps: [
            { action: 'navigate', url: route, description: `Go to ${route}` },
            { action: 'wait', duration: 2500 },
            { action: 'scroll', description: 'Scroll page' },
            { action: 'wait', duration: 1500 }
          ]
        });
      }
    } else {
      flows.push({
        name: 'Homepage Visit',
        description: 'User visits the homepage',
        steps: [
          { action: 'navigate', url: '/', description: 'Go to homepage' },
          { action: 'wait', duration: 2500 },
          { action: 'scroll' },
          { action: 'wait', duration: 1500 }
        ]
      });
    }

    // Error scenario
    const errorPage = pageRoutes[0] || '/';
    flows.push({
      name: 'Error Scenario',
      description: 'Triggers an error for Sentry error tracking',
      steps: [
        { action: 'navigate', url: errorPage, description: `Go to ${errorPage}` },
        { action: 'wait', duration: 1000 },
        { action: 'error', description: 'Inject JS error captured by Sentry' }
      ]
    });

    return flows;
  }

  private scanGeneratedPageRoutes(appPath: string, project: EngagementSpec): string[] {
    const routes: string[] = [];
    if (project.stack.type === 'backend-only') return routes;

    const pagesDir = path.join(appPath, 'frontend', 'app');
    if (!fs.existsSync(pagesDir)) return routes;

    const scanDir = (dir: string, prefix: string) => {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (entry.name.startsWith('_') || entry.name.startsWith('.') ||
            ['globals.css', 'layout.tsx', 'loading.tsx', 'error.tsx', 'not-found.tsx'].includes(entry.name)) continue;
        if (entry.name.startsWith('[')) continue; // skip dynamic segments
        if (entry.isDirectory()) {
          const pageFile = path.join(dir, entry.name, 'page.tsx');
          if (fs.existsSync(pageFile)) routes.push(`${prefix}/${entry.name}`);
          scanDir(path.join(dir, entry.name), `${prefix}/${entry.name}`);
        } else if (entry.name === 'page.tsx' && prefix === '') {
          routes.unshift('/');
        } else if (entry.name.endsWith('.page.tsx')) {
          // Handle flat .page.tsx naming convention sometimes generated by LLM
          const routeName = entry.name.replace('.page.tsx', '');
          if (routeName === 'index') {
            routes.unshift('/');
          } else {
            routes.push(`${prefix}/${routeName}`);
          }
        }
      }
    };

    scanDir(pagesDir, '');
    return [...new Set(routes)];
  }

  private deriveRouteFromSpan(spanName: string, op: string, knownRoutes: string[]): string {
    const keyword = op.toLowerCase().replace(/[^a-z0-9]/g, '');
    const nameParts = spanName.toLowerCase().split('.');

    const keywordRoutes: Record<string, string> = {
      login: '/login', signin: '/login', auth: '/login',
      logout: '/logout', signout: '/logout',
      register: '/', signup: '/', registration: '/', validate: '/', validation: '/', input: '/',
      reset: '/password-reset', forgot: '/forgot-password',
      checkout: '/checkout', payment: '/checkout', pay: '/checkout',
      cart: '/cart', products: '/products', product: '/products', catalog: '/products',
      search: '/search', dashboard: '/dashboard', home: '/',
      profile: '/profile', account: '/profile', settings: '/settings', upload: '/upload',
    };

    if (keywordRoutes[keyword]) {
      const c = keywordRoutes[keyword];
      if (knownRoutes.length === 0 || knownRoutes.includes(c)) return c;
    }

    for (const part of [...nameParts].reverse()) {
      const clean = part.replace(/[^a-z0-9]/g, '');
      if (keywordRoutes[clean]) {
        const c = keywordRoutes[clean];
        if (knownRoutes.length === 0 || knownRoutes.includes(c)) return c;
      }
      const matched = knownRoutes.find(r => r.replace(/^\//, '').replace(/-/g, '') === clean);
      if (matched) return matched;
    }

    return '/';
  }

  private buildFormSteps(span: { attributes: Record<string, string>; pii: { keys: string[] }; op: string; name: string }): FlowStep[] {
    const steps: FlowStep[] = [];
    const allKeys = [...Object.keys(span.attributes), ...span.pii.keys];
    const seen = new Set<string>();

    const addType = (selector: string, value: string) => {
      if (!seen.has(selector)) {
        seen.add(selector);
        steps.push({ action: 'type', selector, value, description: `Fill ${selector}` });
      }
    };

    for (const key of allKeys) {
      const k = key.toLowerCase();
      if (k.includes('email')) {
        addType('input[type="email"], input[name="email"]', 'testuser@example.com');
      } else if (k.includes('confirm') && k.includes('password')) {
        addType('input[name="confirmPassword"], input[name="confirm_password"], input[placeholder*="onfirm"]', 'TestPassword123!');
      } else if (k.includes('password')) {
        addType('input[type="password"]', 'TestPassword123!');
      } else if (k.includes('username') || k === 'user') {
        addType('input[name="username"], input[placeholder*="sername"]', 'testuser');
      } else if (k.includes('name') && !k.includes('user')) {
        addType('input[name="name"], input[placeholder*="ame"]', 'Test User');
      } else if (k.includes('phone')) {
        addType('input[type="tel"], input[name="phone"]', '555-0100');
      } else if (k.includes('amount') || k.includes('price') || k.includes('value')) {
        addType('input[name="amount"], input[type="number"]', '100');
      } else if (k.includes('search') || k.includes('query')) {
        addType('input[type="search"], input[name="q"]', 'test query');
      }
    }

    steps.push({ action: 'submit', selector: 'button[type="submit"], form button:last-of-type', description: 'Submit form' });
    steps.push({ action: 'wait', duration: 2000 });
    return steps;
  }

  private humanizeName(spanName: string): string {
    return spanName.split('.').map(p =>
      p.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
    ).join(' ');
  }

  private async runCommand(command: string, args: string[], cwd: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(command, args, { cwd, shell: true });
      
      proc.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Command failed with code ${code}`));
        }
      });

      proc.on('error', reject);

      // Timeout after 5 minutes
      setTimeout(() => {
        proc.kill();
        reject(new Error('Command timed out'));
      }, 300000);
    });
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private async cleanup(onOutput: (data: string) => void): Promise<void> {
    onOutput('\n🧹 Cleaning up...\n');

    // Close browser
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      onOutput('   ✓ Browser closed\n');
    }

    // Stop frontend
    if (this.frontendProcess) {
      this.frontendProcess.kill('SIGTERM');
      this.frontendProcess = null;
      onOutput('   ✓ Frontend stopped\n');
    }

    // Stop backend
    if (this.backendProcess) {
      this.backendProcess.kill('SIGTERM');
      this.backendProcess = null;
      onOutput('   ✓ Backend stopped\n');
    }
  }

  async stop(): Promise<void> {
    await this.cleanup(() => {});
    this.isRunning = false;
  }
}
