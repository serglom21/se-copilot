import { spawn, ChildProcess, exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import puppeteer, { Browser, Page } from 'puppeteer';
import { StorageService } from './storage';
import { EngagementSpec } from '../../src/types/spec';
import { LLMService } from './llm';
import { SentryAPIService } from './sentry-api';

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
  /** Spec span names this flow is responsible for triggering */
  coversSpans?: string[];
  /** Flow names that must run before this flow (preconditions, e.g. add-to-cart before checkout) */
  dependsOn?: string[];
}

export interface FlowStep {
  action: 'navigate' | 'click' | 'type' | 'wait' | 'scroll' | 'select' | 'submit' | 'error' | 'api_call';
  selector?: string;
  value?: string;
  url?: string;
  duration?: number;
  description?: string;
  method?: string;
  body?: Record<string, any>;
}

/**
 * Merge flow corrections from four validation agents.
 * Priority order: topology (highest) → route coherence → deduplication → widget coverage (lowest).
 * A corrected version is accepted only if the agent returned a valid array of the same length.
 */
function mergeFlowCorrections(
  original: UserFlow[],
  topological: UserFlow[],
  coherent: UserFlow[],
  deduplicated: UserFlow[],
  widgetCovered: UserFlow[]
): UserFlow[] {
  const accept = (candidate: UserFlow[], base: UserFlow[]): UserFlow[] =>
    Array.isArray(candidate) && candidate.length === base.length ? candidate : base;

  const afterTopology = accept(topological, original);
  const afterCoherence = accept(coherent, afterTopology);
  const afterDedup = accept(deduplicated, afterCoherence);
  return accept(widgetCovered, afterDedup);
}

export class LiveDataGeneratorService {
  private storage: StorageService;
  private backendProcess: ChildProcess | null = null;
  private frontendProcess: ChildProcess | null = null;
  private browser: Browser | null = null;
  private isRunning: boolean = false;
  private llmService: LLMService | null = null;
  private sentryService: SentryAPIService | null = null;
  private _runStartTime: number = 0;

  // Default ports
  private readonly BACKEND_PORT = 3001;
  private readonly FRONTEND_PORT = 3000;

  constructor(storage: StorageService, llmService?: LLMService, sentryService?: SentryAPIService) {
    this.storage = storage;
    this.llmService = llmService || null;
    this.sentryService = sentryService || null;
  }

  async runLiveDataGenerator(
    projectId: string,
    config: LiveDataGenConfig,
    onOutput: (data: string) => void,
    onError: (error: string) => void,
    traceIngestService: import('./trace-ingest').TraceIngestService
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

      // Always regenerate flows — never use stale cache
      if (fs.existsSync(flowsPath)) {
        fs.unlinkSync(flowsPath);
      }

      // Try LLM-based intelligent generation, fall back to heuristics
      this._runStartTime = Math.floor(Date.now() / 1000);
      if (this.llmService) {
        try {
          onOutput('🤖 Generating intelligent user flows...\n');
          userFlows = await this.generateIntelligentFlows(project, appPath, onOutput);
          onOutput(`   ✓ Generated ${userFlows.length} intelligent flows\n\n`);
        } catch (err) {
          onOutput(`   ⚠️ LLM flow generation failed, using heuristics: ${err}\n\n`);
          userFlows = this.generateDefaultFlows(project);
        }
      } else {
        userFlows = this.generateDefaultFlows(project);
      }
      fs.writeFileSync(flowsPath, JSON.stringify(userFlows, null, 2));

      onOutput('🚀 Starting Live Data Generator\n');
      onOutput('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n');

      // Step 1: Configure environment — route through local proxy at 100% sample rate
      onOutput('📝 Step 1: Configuring Sentry DSNs (local proxy)...\n');
      const localDsn = traceIngestService.getLocalDsn();
      await this.configureDsns(appPath, config, project, true, localDsn);
      onOutput(`   ✓ DSNs configured → ${localDsn}\n\n`);

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

      // Step 7: Execute flows — telemetry goes to local proxy
      onOutput(`📊 Step 7: Executing ${config.numTraces} trace iterations...\n`);
      onOutput('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
      traceIngestService.clear();

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

        await this.delay(500 + Math.random() * 1000);
      }

      onOutput('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
      onOutput('⏳ Waiting for traces to settle...\n');
      let traces = await traceIngestService.waitForAllQuiet(2000);
      onOutput(`   ✓ ${traces.length} traces captured\n\n`);

      // Step 8: Validate → Repair loop
      onOutput('🔍 Step 8: Validating trace structure...\n');
      const settings = this.storage.getSettings();
      const llmConfig = { baseUrl: settings.llm.baseUrl, apiKey: settings.llm.apiKey, model: settings.llm.model };
      const MAX_ATTEMPTS = 4;

      let repairedTraces = traces;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const { validateTraces, summarizeIssues } = await import('./trace-validator');
        const { repairTraces, getRepairedSpanIds } = await import('./trace-repairer');
        const { surgicalRepair, getFlowsToRerun } = await import('./surgical-repairer');

        const issues = validateTraces(repairedTraces, project, userFlows);
        if (issues.length === 0) {
          onOutput(`   ✅ All traces valid (attempt ${attempt})\n\n`);
          break;
        }

        const warnings = issues.filter(i => i.severity === 'warning');
        const errors = issues.filter(i => i.severity !== 'warning');
        onOutput(`   Attempt ${attempt}/${MAX_ATTEMPTS}: ${errors.length} errors, ${warnings.length} warnings — ${summarizeIssues(errors)}\n`);

        // Auto-repair fixable issues in-memory
        const fixable = issues.filter(i => i.fixable);
        if (fixable.length > 0) {
          repairedTraces = repairTraces(repairedTraces, fixable, project);
          onOutput(`   🔧 Auto-repaired ${fixable.length} issues\n`);
        }

        // Surgical repair for non-fixable errors (skip on last attempt)
        const nonFixable = errors.filter(i => !i.fixable);
        if (nonFixable.length > 0 && attempt < MAX_ATTEMPTS) {
          // Group issues by repairTarget so each file is patched once with ALL
          // its issues in a single LLM call (avoids "LLM returned no changes"
          // from patching the same file multiple times in sequence).
          const byTarget = new Map<string, typeof nonFixable>();
          for (const issue of nonFixable) {
            if (issue.repairTarget === 'flows') continue;
            const key = issue.repairTarget;
            if (!byTarget.has(key)) byTarget.set(key, []);
            byTarget.get(key)!.push(issue);
          }

          let needsBackendRestart = false;
          let needsFrontendRestart = false;

          for (const [, issueGroup] of byTarget) {
            const patched = await surgicalRepair(
              issueGroup, attempt, appPath, project, userFlows, llmConfig, onOutput,
              this.llmService ?? undefined
            );
            if (patched.length > 0) {
              if (patched.some(f => f.includes('backend') || f.endsWith('.py'))) needsBackendRestart = true;
              if (patched.some(f => f.includes('frontend') || f.includes('sentry.client'))) needsFrontendRestart = true;
            }
          }

          // Restart servers once after all patches are applied
          if (needsBackendRestart) {
            onOutput('   🔄 Restarting backend...\n');
            await this.restartBackend(appPath, project, onOutput, onError);
          }
          if (needsFrontendRestart && project.stack.type !== 'backend-only') {
            onOutput('   🔄 Restarting frontend...\n');
            await this.restartFrontend(appPath, project, onOutput, onError);
          }

          // Re-run targeted flows to capture the missing spans.
          // Clear the trace buffer first so each attempt validates a fresh set
          // of traces — otherwise error counts grow unboundedly as traces accumulate.
          const flowsToRerun = getFlowsToRerun(nonFixable, userFlows);
          if (flowsToRerun.length > 0) {
            onOutput(`   🔁 Re-running ${flowsToRerun.length} flows: ${flowsToRerun.map(f => f.name).join(', ')}\n`);
            traceIngestService.clear(); // ← fresh slate for this attempt
            for (const flow of flowsToRerun) {
              try {
                await this.executeFlow(flow, false, project, onOutput);
              } catch (err) {
                onOutput(`   ⚠️ Re-run flow error: ${err}\n`);
              }
              await this.delay(500);
            }

            onOutput('   ⏳ Waiting for new traces to settle...\n');
            const freshTraces = await traceIngestService.waitForAllQuiet(2000);
            repairedTraces = repairTraces(freshTraces, fixable, project);
          }
        } else if (nonFixable.length > 0 && attempt === MAX_ATTEMPTS) {
          onOutput(`   ⚠ ${nonFixable.length} issues unresolved after ${MAX_ATTEMPTS} attempts:\n`);
          nonFixable.forEach(i => onOutput(`     • ${i.kind}: ${i.detail}\n`));
        }
      }

      // Step 9: Forward validated traces to real Sentry
      onOutput('\n📤 Step 9: Forwarding validated traces to Sentry...\n');
      const { repairTraces: rt, getRepairedSpanIds: grs } = await import('./trace-repairer');
      const { forwardTracesToSentry } = await import('./trace-forwarder');
      const { validateTraces: vt } = await import('./trace-validator');

      const finalIssues = vt(repairedTraces, project, userFlows);
      const finalFixable = finalIssues.filter(i => i.fixable);
      const fullyRepaired = finalFixable.length > 0
        ? rt(repairedTraces, finalFixable, project)
        : repairedTraces;

      const originalTraces = traceIngestService.getTraces();
      const repairedIds = grs(originalTraces, fullyRepaired);
      const allRawEnvelopes = traceIngestService.getAllRawEnvelopes();

      const { forwarded, errors: fwdErrors } = await forwardTracesToSentry(
        fullyRepaired,
        allRawEnvelopes,
        config.frontendDsn,
        config.backendDsn,
        repairedIds,
        onOutput
      );
      onOutput(`   ✓ Forwarded ${forwarded} envelopes to Sentry\n`);
      if (fwdErrors.length > 0) {
        fwdErrors.forEach(e => onOutput(`   ⚠ ${e}\n`));
      }

      // Step 10: Verify coverage in Sentry
      onOutput('\n🔍 Step 10: Verifying span coverage in Sentry...\n');
      onOutput('   ⏳ Waiting 15s for Sentry ingestion...\n');
      await this.delay(15000);
      await this.verifyCoverage(project, onOutput);

      onOutput('\n✅ Live data generation complete!\n');
      onOutput('   • Traces validated and repaired locally\n');
      onOutput('   • Forwarded to Sentry with full fidelity\n');
      onOutput('   • Dashboard should be ready to view\n');

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

  private async configureDsns(
    appPath: string,
    config: LiveDataGenConfig,
    project: EngagementSpec,
    useLocalProxy = false,
    localDsn = ''
  ): Promise<void> {
    const isBackendOnly = project.stack.type === 'backend-only';
    const isPythonBackend = project.stack.backend === 'flask' || project.stack.backend === 'fastapi';

    // During local capture phase: route all telemetry through local proxy at 100% sample rate.
    // During forward phase: this method is not called (DSNs are already set).
    const feDsn = useLocalProxy ? localDsn : config.frontendDsn;
    const beDsn = useLocalProxy ? localDsn : config.backendDsn;
    const sampleRate = useLocalProxy ? '1.0' : '1.0'; // always 1.0 — sampling happens at forward time

    if (!isBackendOnly) {
      const frontendEnvPath = path.join(appPath, 'frontend', '.env.local');
      const frontendEnv = `NEXT_PUBLIC_SENTRY_DSN=${feDsn}
NEXT_PUBLIC_SENTRY_ENVIRONMENT=${config.environment}
NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE=${sampleRate}
NEXT_PUBLIC_API_URL=http://localhost:${this.BACKEND_PORT}
`;
      fs.writeFileSync(frontendEnvPath, frontendEnv);
    }

    const backendPath = path.join(appPath, isPythonBackend ? '' : 'backend');
    const backendEnvPath = path.join(backendPath, '.env');
    const backendEnv = `SENTRY_DSN=${beDsn}
SENTRY_ENVIRONMENT=${config.environment}
SENTRY_TRACES_SAMPLE_RATE=${sampleRate}
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

    // Kill anything already on the backend port before binding
    await this.killPort(this.BACKEND_PORT);

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

      // Use shell:false + detached so we can kill the entire process group
      this.backendProcess = spawn(command, args, {
        cwd,
        env: { ...process.env, PORT: String(this.BACKEND_PORT) },
        shell: false,
        detached: false,
      });

      let started = false;

      const checkStarted = (data: string) => {
        const output = data.toLowerCase();
        if (output.includes('eaddrinuse')) {
          if (!started) { started = true; reject(new Error(`Port ${this.BACKEND_PORT} still in use`)); }
          return;
        }
        if (!started && (output.includes('listening') || output.includes('running') || output.includes('uvicorn') || output.includes('started'))) {
          started = true;
          resolve();
        }
      };

      this.backendProcess.stdout?.on('data', (d) => checkStarted(d.toString()));
      this.backendProcess.stderr?.on('data', (d) => checkStarted(d.toString()));

      this.backendProcess.on('error', (error) => {
        if (!started) { started = true; reject(new Error(`Failed to start backend: ${error.message}`)); }
      });

      // Timeout after 30 seconds
      setTimeout(() => {
        if (!started) { started = true; resolve(); }
      }, 30000);
    });
  }

  private async restartBackend(
    appPath: string,
    project: EngagementSpec,
    onOutput: (data: string) => void,
    onError: (error: string) => void
  ): Promise<void> {
    if (this.backendProcess) {
      try { process.kill(-this.backendProcess.pid!, 'SIGTERM'); } catch {}
      this.backendProcess = null;
    }
    await this.delay(1000);
    await this.startBackend(appPath, project, onOutput, onError);
    await this.waitForServers(project);
  }

  private async restartFrontend(
    appPath: string,
    project: EngagementSpec,
    onOutput: (data: string) => void,
    onError: (error: string) => void
  ): Promise<void> {
    if (this.frontendProcess) {
      try { process.kill(-this.frontendProcess.pid!, 'SIGTERM'); } catch {}
      this.frontendProcess = null;
    }
    await this.delay(1000);
    await this.startFrontend(appPath, project, onOutput, onError);
    await this.waitForServers(project);
  }

  private async startFrontend(
    appPath: string,
    project: EngagementSpec,
    onOutput: (data: string) => void,
    onError: (error: string) => void
  ): Promise<void> {
    const frontendPath = path.join(appPath, 'frontend');

    // Kill anything already on the frontend port before binding
    await this.killPort(this.FRONTEND_PORT);

    return new Promise((resolve, reject) => {
      this.frontendProcess = spawn('npm', ['run', 'dev'], {
        cwd: frontendPath,
        env: { ...process.env, PORT: String(this.FRONTEND_PORT) },
        shell: false,
        detached: false,
      });

      let started = false;

      const checkStarted = (data: string) => {
        const output = data;
        if (output.toLowerCase().includes('eaddrinuse')) {
          if (!started) { started = true; reject(new Error(`Port ${this.FRONTEND_PORT} still in use`)); }
          return;
        }
        if (!started && (output.includes('Ready') || output.includes('localhost') || output.includes('started'))) {
          started = true;
          resolve();
        }
      };

      this.frontendProcess.stdout?.on('data', (d) => checkStarted(d.toString()));
      this.frontendProcess.stderr?.on('data', (d) => checkStarted(d.toString()));

      this.frontendProcess.on('error', (error) => {
        if (!started) { started = true; reject(new Error(`Failed to start frontend: ${error.message}`)); }
      });

      // Timeout after 60 seconds (Next.js can take a while to compile)
      setTimeout(() => {
        if (!started) { started = true; resolve(); }
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

      case 'api_call': {
        if (step.url) {
          const fullUrl = step.url.startsWith('http')
            ? step.url
            : `http://localhost:${this.BACKEND_PORT}${step.url}`;
          try {
            // Wrap in a Sentry span so sentry-trace header is propagated to the backend.
            // Without this, api_call fetches made after pageload settles have no active
            // transaction and arrive at the backend as orphan spans.
            await page.evaluate(
              async (params: { url: string; method: string; body: any; spanName: string }) => {
                const win = window as any;
                const makeRequest = async () => {
                  const opts: RequestInit = { method: params.method };
                  if (params.method !== 'GET') {
                    opts.body = JSON.stringify(params.body || {});
                    opts.headers = { 'Content-Type': 'application/json' };
                  }
                  await fetch(params.url, opts).then(r => r.json()).catch(() => null);
                };
                if (win.Sentry?.startSpan) {
                  await win.Sentry.startSpan(
                    { name: params.spanName, op: 'http.client' },
                    makeRequest
                  );
                } else {
                  await makeRequest();
                }
              },
              {
                url: fullUrl,
                method: step.method || 'POST',
                body: step.body || {},
                spanName: step.description || `${step.method || 'POST'} ${step.url}`
              }
            );
          } catch {
            // api_call failures are non-fatal — the navigate already generated a trace
          }
        }
        break;
      }
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
   * Generate user flows using LLM with code-grounded prompting and reflection loop.
   */
  private async generateIntelligentFlows(
    project: EngagementSpec,
    appPath: string,
    onOutput: (data: string) => void
  ): Promise<UserFlow[]> {
    // Read actual backend routes code for code-grounded prompting
    const backendRoutesCode = this.readBackendRoutesCode(appPath, project);

    // Scan actual frontend pages
    const frontendPages = this.scanGeneratedPageRoutes(appPath, project);

    // Extract widget filter conditions for attribute seeding
    const widgetFilters = this.extractWidgetFilters(project);

    // Generate run ID for post-run verification
    const runId = `${project.id.substring(0, 8)}-${Date.now()}`;

    // Delegate to LLM service
    let flows = await this.llmService!.generateUserFlows(
      project,
      backendRoutesCode,
      frontendPages,
      widgetFilters,
      runId
    );

    // Run 4-agent validation pipeline in parallel
    onOutput('🔍 Running flow validation pipeline...\n');
    try {
      const [coherent, deduplicated, topological, widgetCovered] = await Promise.all([
        this.llmService!.validateFlowRouteCoherence(flows, backendRoutesCode),
        this.llmService!.eliminateDuplicateSpanFlows(flows, frontendPages),
        this.llmService!.validateFlowSpanTopology(flows, project),
        this.llmService!.validateWidgetDataCoverage(flows, project),
      ]);
      flows = mergeFlowCorrections(flows, topological, coherent, deduplicated, widgetCovered);
      onOutput('   ✓ Route coherence validated\n');
      onOutput('   ✓ Duplicate spans eliminated\n');
      onOutput('   ✓ Span topology validated\n');
      onOutput('   ✓ Widget data coverage validated\n');
    } catch (err) {
      onOutput(`   ⚠️ Flow validation pipeline failed (non-fatal): ${err}\n`);
    }

    // Persist run ID so verifyAndRetry can filter by it
    (this as any)._currentRunId = runId;
    (this as any)._runIdTimestamp = this._runStartTime;

    // Always append an error flow
    const errorPage = frontendPages[0] || '/';
    flows.push({
      name: 'Error Scenario',
      description: 'Triggers a JS error captured by Sentry',
      steps: [
        { action: 'navigate', url: errorPage },
        { action: 'wait', duration: 1000 },
        { action: 'error' }
      ]
    });

    return flows;
  }

  /**
   * After flows run, query Sentry once to report which spec spans appeared.
   */
  private async verifyCoverage(
    project: EngagementSpec,
    onOutput: (data: string) => void
  ): Promise<void> {
    if (!this.sentryService) {
      onOutput('   ℹ️ Sentry service not available, skipping verification\n');
      return;
    }

    const specSpanNames = project.instrumentation.spans.map(s => s.name);
    if (specSpanNames.length === 0) return;

    try {
      const { found, missing } = await this.sentryService.querySpansByName(
        specSpanNames,
        this._runStartTime
      );

      if (found.length > 0) onOutput(`   ✓ Verified: ${found.join(', ')}\n`);

      if (missing.length === 0) {
        onOutput('   ✅ All spec spans verified in Sentry!\n');
      } else {
        onOutput(`   ⚠️ Missing spans: ${missing.join(', ')}\n`);
        onOutput('   💡 Check that DSNs are set and SDK is initialized before route handlers\n');
      }
    } catch (err) {
      onOutput(`   ⚠️ Verification error (non-fatal): ${err}\n`);
    }
  }

  /**
   * Read the actual backend routes file content for code-grounded LLM prompting.
   */
  private readBackendRoutesCode(appPath: string, project: EngagementSpec): string {
    const isPython = project.stack.backend === 'flask' || project.stack.backend === 'fastapi';

    const candidates = isPython
      ? [
          path.join(appPath, 'main.py'),
          path.join(appPath, 'app.py'),
          path.join(appPath, 'routes.py'),
        ]
      : [
          path.join(appPath, 'backend', 'src', 'routes', 'api.ts'),
          path.join(appPath, 'backend', 'src', 'routes', 'index.ts'),
          path.join(appPath, 'backend', 'src', 'index.ts'),
          path.join(appPath, 'backend', 'routes', 'api.js'),
          path.join(appPath, 'backend', 'index.js'),
        ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        try {
          return fs.readFileSync(candidate, 'utf-8');
        } catch {
          // try next
        }
      }
    }

    return '// routes file not found';
  }

  /**
   * Extract dashboard widget filter conditions to seed api_call bodies with
   * attribute values that match the widget queries.
   */
  private extractWidgetFilters(project: EngagementSpec): Array<{ spanName: string; conditions: string }> {
    const filters: Array<{ spanName: string; conditions: string }> = [];
    const widgets: any[] = (project as any).dashboard?.widgets || [];

    for (const widget of widgets) {
      const queries: any[] = widget.queries || [];
      for (const query of queries) {
        let conditions: string = query.conditions || '';
        if (!conditions) continue;

        // Sanitize: has:error does not work in Sentry span widgets — replace with success:false
        if (conditions.includes('has:error')) {
          conditions = conditions.replace(/\bhas:error\b/g, 'success:false');
          query.conditions = conditions;
        }
        if (conditions.includes('!has:error')) {
          conditions = conditions.replace(/!has:error\b/g, 'success:true');
          query.conditions = conditions;
        }

        for (const span of project.instrumentation.spans) {
          if (conditions.includes(span.name) || conditions.includes(span.op)) {
            filters.push({ spanName: span.name, conditions });
            break;
          }
        }
      }
    }

    return filters;
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
      const spansToUse = project.instrumentation.spans.slice(0, 8);
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

    // Kill by port — reliable even when the child is a grandchild of a shell wrapper
    await this.killPort(this.FRONTEND_PORT);
    this.frontendProcess = null;
    onOutput('   ✓ Frontend stopped\n');

    await this.killPort(this.BACKEND_PORT);
    this.backendProcess = null;
    onOutput('   ✓ Backend stopped\n');
  }

  async stop(): Promise<void> {
    await this.cleanup(() => {});
    this.isRunning = false;
  }

  getIsRunning(): boolean {
    return this.isRunning;
  }

  /**
   * Kill any process listening on the given TCP port.
   * Waits 300ms after sending SIGKILL so the port is fully released before returning.
   */
  async killPort(port: number): Promise<void> {
    return new Promise(resolve => {
      exec(`lsof -ti tcp:${port}`, (err, stdout) => {
        const pids = (stdout || '').trim().split('\n').filter(Boolean);
        if (pids.length === 0) { resolve(); return; }
        exec(`kill -9 ${pids.join(' ')}`, () => setTimeout(resolve, 300));
      });
    });
  }

  /**
   * Kill all processes that have files open inside the given directory
   * (covers zombie servers whose CWD is inside that directory).
   */
  async killProcessesInDirectory(dirPath: string): Promise<void> {
    return new Promise(resolve => {
      if (!fs.existsSync(dirPath)) { resolve(); return; }
      exec(`lsof +D "${dirPath}" -t 2>/dev/null`, (err, stdout) => {
        const pids = [...new Set((stdout || '').trim().split('\n').filter(Boolean))];
        if (pids.length === 0) { resolve(); return; }
        exec(`kill -9 ${pids.join(' ')}`, () => setTimeout(resolve, 300));
      });
    });
  }
}
