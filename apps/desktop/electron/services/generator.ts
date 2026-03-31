import fs from 'fs';
import path from 'path';
import { StorageService } from './storage';
import { LLMService, InstrumentationDeclaration } from './llm';
import { RulesBankService } from './rules-bank';
import { validateGeneratedApp } from './app-validator';
import { EngagementSpec, SpanDefinition } from '../../src/types/spec';
import { checkPageSyntax, formatSyntaxErrorsForLLM } from './page-syntax-validator';
import { injectInstrumentation, assertInjectionCorrectness, assertNoInventedTraceFunctions, removeForeignMarkers, fillMissingMarkersFromRoutes, normaliseTraceFunctionNames } from './instrumentation-injector';
import { extractDOMManifest } from './dom-extractor';
import { deriveRouteContract, RouteContract } from './route-contract';
import { TraceTopologyContract, loadTopologyContract, loadFreshTopologyContract, hashBrief } from './trace-topology-contract';
import { injectContractUrls } from './route-url-injector';
import { normaliseSpanNames } from './span-name-normaliser';
import { checkPageUIStructure, buildUIRepairPrompt } from './ui-structure-validator';
import { runStaticTopologyValidation, TopologyIssue } from './static-topology-validator';
import { classifyRepair, applyDeterministicFix, postGenerationCheck, validateInstrumentationDeclaration } from './generation-state';
import { surgicalRepair } from './surgical-repairer';
// ---------------------------------------------------------------------------
// Complexity-scaled attempt budget
// ---------------------------------------------------------------------------


export class GeneratorService {
  private storage: StorageService;
  private llm: LLMService;
  private rulesBank: RulesBankService | null = null;
  private templatesDir: string;

  constructor(storage: StorageService, llm: LLMService, rulesBank?: RulesBankService) {
    this.storage = storage;
    this.llm = llm;
    this.rulesBank = rulesBank || null;
    this.templatesDir = path.join(__dirname, '../../../../templates/reference-app');
  }

  async generateReferenceApp(
    project: EngagementSpec,
    onProgress?: (pct: number, label: string) => void,
    onOutput?: (line: string) => void
  ): Promise<{ success: boolean; outputPath?: string; error?: string }> {
    let currentPct = 0;
    const progress = (pct: number, label: string) => {
      currentPct = pct;
      console.log(`[generate] ${pct}% — ${label}`);
      onProgress?.(pct, label);
    };

    // Forward LLM token progress to the UI without changing the current percentage
    this.llm.streamProgressCallback = (tokens, label) => {
      onProgress?.(currentPct, label);
    };

    try {
      const outputPath = this.storage.getOutputPath(project.id);
      const appPath = path.join(outputPath, 'reference-app');

      progress(5, 'Reading project spec…');

      // Log active rules so it's visible that generation is rule-aware
      if (this.rulesBank) {
        const rules = this.rulesBank.listRules();
        if (rules.length > 0) {
          console.log(`\n📚 Applying ${rules.length} training rule(s) to generation:`);
          for (const r of rules) {
            console.log(`   [${r.category}] ${r.title}`);
          }
        } else {
          console.log('📚 No training rules yet — run training to improve generation quality');
        }
      }

      // Route contract — derived before code generation, used in health check after validation
      let routeContract: RouteContract | undefined;

      // Trace Topology Contract — frozen by Architect agent before any code generation.
      // If already generated (plan phase), load it; otherwise generate now.
      let topologyContract: TraceTopologyContract | null = null;

      // Create app structure based on stack type
      if (project.stack.type === 'backend-only') {
        progress(15, 'Scaffolding backend…');
        this.createPythonDirectoryStructure(appPath);
        progress(30, 'Generating backend code…');
        this.generatePythonBackend(appPath, project);
        progress(80, 'Backend ready');
      } else if (project.stack.type === 'mobile') {
        progress(15, 'Scaffolding mobile app…');
        this.createMobileDirectoryStructure(appPath);
        progress(25, 'Generating React Native app…');
        await this.generateReactNativeApp(appPath, project);
        progress(75, 'Generating Express backend…');
        await this.generateBackend(appPath, project);
        progress(82, 'Backend ready');
      } else {
        progress(15, 'Scaffolding directories…');
        this.createDirectoryStructure(appPath);

        // Derive the route contract ONCE before any code generation.
        // Both frontend and backend LLM calls receive the same contract — neither derives paths independently.
        progress(18, 'Deriving route contract…');
        routeContract = deriveRouteContract(project, outputPath);

        // Phase 1 — Architect: produce/load frozen Trace Topology Contract.
        // If already written to disk (from a prior plan step), load it; otherwise generate now.
        // Use loadFreshTopologyContract to discard stale contracts when the brief has changed.
        try {
          const currentBriefHash = hashBrief({
            vertical: project.project.vertical,
            notes: project.project.notes,
            stackType: project.stack.type,
          });
          topologyContract = loadFreshTopologyContract(outputPath, currentBriefHash);
          if (topologyContract) {
            onOutput?.(`🐾 Loaded frozen topology contract (${topologyContract.spans.length} spans)\n`);
          }
        } catch { /* will generate below */ }

        if (!topologyContract) {
          progress(20, '🐾 Architect: building Trace Topology Contract…');
          onOutput?.('🐾 Architect agent: building Trace Topology Contract…\n');
          try {
            topologyContract = await this.llm.generateTraceTopologyContract(project, outputPath);
            onOutput?.(`🐾 Contract frozen — ${topologyContract.spans.length} spans, ${topologyContract.transactions.length} transactions\n`);
          } catch (contractErr: any) {
            onOutput?.(`⚠ Contract generation failed (${contractErr?.message}) — proceeding with spec-based instrumentation\n`);
            console.warn('[generator] Topology contract failed:', contractErr);
          }
        }

        progress(22, 'Generating instrumentation wrappers…');
        await this.generateFrontend(appPath, project, progress, routeContract, topologyContract);
        progress(65, 'Generating Express backend…');
        await this.generateBackend(appPath, project, progress, routeContract, topologyContract);

        // Normalise backend api.ts marker names — LLM often drops the namespace prefix
        // (e.g. "validate_user_input" instead of "backend.validate_user_input").
        // Run the same normalise→removeForeign pipeline used for frontend pages.
        if (topologyContract) {
          const apiPath = path.join(appPath, 'backend', 'src', 'routes', 'api.ts');
          if (fs.existsSync(apiPath)) {
            normaliseSpanNames([apiPath], topologyContract);
            const beSpanNames = topologyContract.spans
              .filter(s => s.layer === 'backend')
              .map(s => s.name);
            removeForeignMarkers(apiPath, beSpanNames);
          }
        }

        progress(82, 'Backend ready');

        // Phase 4 — Static topology validation against the frozen contract.
        // Runs deterministic checks on generated source files before the build.
        if (topologyContract) {
          progress(84, '🐾 Static topology validation…');
          onOutput?.('\n🐾 Running static topology validation…\n');
          const staticResult = runStaticTopologyValidation(topologyContract, appPath);

          if (staticResult.passed) {
            onOutput?.(`   ✓ All topology checks passed (${topologyContract.spans.length} spans verified)\n`);
          } else {
            onOutput?.(`   ⚠ ${staticResult.errors.length} error(s), ${staticResult.warnings.length} warning(s) found\n`);

            // Repair loop — deterministic first, then LLM targeted/rewrite
            const settings = this.storage.getSettings();
            const llmConfig = { baseUrl: settings.llm.baseUrl, apiKey: settings.llm.apiKey, model: settings.llm.model };
            const repairableErrors = [...staticResult.errors];
            const accumulatedDiffs = new Map<string, string>();
            let repairAttempt = 0;
            const MAX_REPAIR_ATTEMPTS = 3;

            while (repairableErrors.length > 0 && repairAttempt < MAX_REPAIR_ATTEMPTS) {
              repairAttempt++;
              onOutput?.(`\n   🔧 Repair pass ${repairAttempt}/${MAX_REPAIR_ATTEMPTS} (${repairableErrors.length} issue(s))…\n`);

              const resolved: TopologyIssue[] = [];

              // Group errors by file for efficient batching
              const byFile = new Map<string, TopologyIssue[]>();
              for (const issue of repairableErrors) {
                const key = issue.file;
                if (!byFile.has(key)) byFile.set(key, []);
                byFile.get(key)!.push(issue);
              }

              for (const [, fileIssues] of byFile) {
                for (const issue of fileIssues) {
                  const strategy = classifyRepair(issue, fileIssues.length, repairAttempt - 1);

                  if (strategy === 'contract_violation') {
                    onOutput?.(`   ⚠ Contract violation (invented span "${issue.spanName}") — skipping, contract is frozen\n`);
                    resolved.push(issue);
                    continue;
                  }

                  if (strategy === 'deterministic') {
                    const fixed = applyDeterministicFix(issue);
                    if (fixed) {
                      onOutput?.(`   ✓ Deterministic fix applied for ${issue.type}\n`);
                      resolved.push(issue);
                    }
                    continue;
                  }

                  // missing_marker: deterministic approach — use fillMissingMarkersFromRoutes
                  // on the correct file before falling back to LLM.
                  if (issue.type === 'missing_marker' && issue.spanName && routeContract) {
                    const span = topologyContract.spans.find(s => s.name === issue.spanName);
                    if (span) {
                      let targetFile: string | null = null;
                      if (span.layer === 'frontend') {
                        const frontendAppDir = path.join(appPath, 'frontend', 'app');
                        const prefix = issue.spanName.split('.')[0];
                        // For spans like "pageload" (no dot), try all page files and
                        // pick the first one that already has other markers — it's likely
                        // the page where this span should be.
                        const noDot = !issue.spanName.includes('.');
                        const candidates = noDot
                          ? (() => {
                              const found: string[] = [];
                              const walkForPage = (dir: string) => {
                                for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                                  const full = path.join(dir, e.name);
                                  if (e.isDirectory() && e.name !== 'node_modules') walkForPage(full);
                                  else if (e.isFile() && e.name === 'page.tsx') found.push(full);
                                }
                              };
                              if (fs.existsSync(frontendAppDir)) walkForPage(frontendAppDir);
                              // Prefer pages that already have other INSTRUMENT markers
                              found.sort((a, b) => {
                                const hasMarkersA = fs.readFileSync(a, 'utf-8').includes('// INSTRUMENT:') ? 1 : 0;
                                const hasMarkersB = fs.readFileSync(b, 'utf-8').includes('// INSTRUMENT:') ? 1 : 0;
                                return hasMarkersB - hasMarkersA;
                              });
                              return found;
                            })()
                          : [
                              path.join(frontendAppDir, prefix, 'page.tsx'),
                              path.join(frontendAppDir, prefix, 'page.ts'),
                              path.join(frontendAppDir, 'page.tsx'),
                            ];
                        for (const candidate of candidates) {
                          if (fs.existsSync(candidate)) { targetFile = candidate; break; }
                        }
                      } else {
                        // Backend: marker goes in api.ts
                        const candidate = path.join(appPath, 'backend', 'src', 'routes', 'api.ts');
                        if (fs.existsSync(candidate)) targetFile = candidate;
                      }

                      if (targetFile) {
                        const added = fillMissingMarkersFromRoutes(targetFile, [{ name: issue.spanName }], routeContract);
                        if (added.length > 0) {
                          onOutput?.(`   ✓ Inserted missing marker for "${issue.spanName}" in ${path.basename(targetFile)}\n`);
                          resolved.push(issue);
                          continue;
                        }
                      }
                    }
                    // Deterministic failed (no fetch/try-block match) — fall through to LLM below
                  }

                  // targeted_patch or file_rewrite — use LLM via surgical-repairer
                }

                // Batch remaining LLM-fixable issues for this file
                const llmIssues = fileIssues.filter(i => {
                  if (resolved.some(r => r === i)) return false; // already resolved above
                  const s = classifyRepair(i, fileIssues.length, repairAttempt - 1);
                  return s === 'targeted_patch' || s === 'file_rewrite';
                });

                if (llmIssues.length > 0) {
                  try {
                    // Convert TopologyIssue → TraceIssue-compatible shape for surgical-repairer.
                    // For missing_marker issues we target the PAGE file (frontend) or api.ts (backend),
                    // NOT instrumentation.ts — the validator runs pre-injection so files still have markers.
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const traceIssues: any[] = llmIssues.map(i => {
                      const isFrontend = topologyContract.spans.find(s => s.name === i.spanName)?.layer === 'frontend'
                        || i.file.includes('frontend');
                      const isMissingMarker = i.type === 'missing_marker';
                      let repairTarget: string;
                      if (isMissingMarker && isFrontend) {
                        repairTarget = 'frontend_page';
                      } else if (isFrontend) {
                        repairTarget = 'frontend_instrumentation';
                      } else {
                        repairTarget = 'backend_routes';
                      }
                      return {
                        kind: i.type,
                        spanName: i.spanName,
                        repairTarget,
                        fixable: false,
                        severity: i.severity,
                        affectedFlows: [],
                        detail: `[${i.type}]${i.spanName ? ` (${i.spanName})` : ''}: expected ${i.expected} — found ${i.found}`,
                      };
                    });

                    const patched = await surgicalRepair(
                      traceIssues,
                      repairAttempt,
                      appPath,
                      project,
                      [],
                      llmConfig,
                      (msg) => onOutput?.(msg),
                      this.llm,
                      accumulatedDiffs
                    );

                    if (patched.length > 0) {
                      resolved.push(...llmIssues);
                    }
                  } catch (repairErr: any) {
                    onOutput?.(`   ✗ LLM repair failed: ${repairErr?.message}\n`);
                  }
                }
              }

              // Remove resolved issues
              for (const r of resolved) {
                const idx = repairableErrors.indexOf(r);
                if (idx !== -1) repairableErrors.splice(idx, 1);
              }

              // Re-validate to check if repairs introduced new issues
              if (resolved.length > 0 && repairableErrors.length > 0) {
                const recheck = runStaticTopologyValidation(topologyContract, appPath);
                repairableErrors.length = 0;
                repairableErrors.push(...recheck.errors);
              }
            }

            if (repairableErrors.length > 0) {
              onOutput?.(`\n   ⚠ ${repairableErrors.length} topology issue(s) unresolved after ${repairAttempt} attempt(s) — proceeding with warnings\n`);
              for (const i of repairableErrors) {
                onOutput?.(`     • [${i.type}]${i.spanName ? ` ${i.spanName}` : ''}: ${i.expected}\n`);
              }
            } else {
              onOutput?.(`   ✓ All topology issues resolved\n`);
            }
          }
        }
      }

      // Inject instrumentation AFTER static topology validation + repair so that
      // the validator works with raw // INSTRUMENT: markers (its designed input).
      progress(85, '🐾 Injecting instrumentation…');
      onOutput?.('\n🐾 Injecting instrumentation wrappers…\n');
      this.injectAllInstrumentation(appPath, project, onOutput);

      progress(86, 'Writing config files…');
      this.generateConfigFiles(appPath, project);

      progress(92, 'Generating user flows…');
      this.generateUserFlows(outputPath, project);

      progress(95, 'Saving engagement spec…');
      const specPath = path.join(outputPath, 'engagement-spec.json');
      fs.writeFileSync(specPath, JSON.stringify(project, null, 2));

      // Update project
      this.storage.updateProject(project.id, {
        outputPath: appPath,
        status: 'generated'
      });

      // Validate generated app (structure check + build check + smoke test)
      if (project.stack.type !== 'mobile') {
        progress(97, 'Validating generated app…');
        const settings = this.storage.getSettings();
        const llmConfig = { baseUrl: settings.llm.baseUrl, apiKey: settings.llm.apiKey, model: settings.llm.model };
        try {
          const validationResult = await validateGeneratedApp(
            appPath,
            project,
            llmConfig,
            (_pct, label) => { progress(97, label); },
            (line) => { onOutput?.(line); },
            this.llm,
            routeContract
          );
          if (validationResult.buildRepaired) {
            onOutput?.('✓ Build errors were auto-repaired\n');
            // Fix A: Re-run static topology validation after build repair modified source files.
            // The LLM repair loop can change instrumentation.ts — re-validate to surface any
            // topology regressions introduced by the repair before the run completes.
            if (topologyContract) {
              onOutput?.('\n🐾 Re-checking topology after build repair…\n');
              const postRepairStatic = runStaticTopologyValidation(topologyContract, appPath);
              if (postRepairStatic.passed) {
                onOutput?.('   ✓ Topology still clean after build repair\n');
              } else {
                onOutput?.(`   ⚠ ${postRepairStatic.errors.length} topology issue(s) surfaced after build repair:\n`);
                for (const i of postRepairStatic.errors) {
                  onOutput?.(`     • [${i.type}]${i.spanName ? ` ${i.spanName}` : ''}: ${i.expected}\n`);
                }
              }
            }
          }
          if (validationResult.errors.length > 0) {
            onOutput?.(`⚠ Validation issues: ${validationResult.errors.join('; ')}\n`);
          }
        } catch (validationError) {
          onOutput?.(`⚠ Validation skipped: ${String(validationError)}\n`);
        }
      }

      progress(100, 'Done');
      this.llm.streamProgressCallback = null;
      return { success: true, outputPath: appPath };
    } catch (error) {
      this.llm.streamProgressCallback = null;
      console.error('Error generating reference app:', error);
      return { success: false, error: String(error) };
    }
  }

  async generateImplementationGuide(project: EngagementSpec): Promise<{ success: boolean; outputPath?: string; error?: string }> {
    try {
      const outputPath = this.storage.getOutputPath(project.id);
      const guidePath = path.join(outputPath, 'IMPLEMENTATION_GUIDE.md');

      const guide = this.buildImplementationGuide(project);
      fs.writeFileSync(guidePath, guide);

      return { success: true, outputPath: guidePath };
    } catch (error) {
      console.error('Error generating implementation guide:', error);
      return { success: false, error: String(error) };
    }
  }

  async generateDashboard(project: EngagementSpec): Promise<{ success: boolean; outputPath?: string; error?: string }> {
    try {
      const outputPath = this.storage.getOutputPath(project.id);
      const dashboardPath = path.join(outputPath, 'sentry-dashboard.json');

      let dashboard: any;
      try {
        const widgets = await this.llm.generateDashboardWidgets(project);
        dashboard = {
          title: `${project.project.name} — Monitoring Dashboard`,
          filters: {},
          projects: [],
          environment: [],
          widgets,
        };
        console.log(`✅ LLM generated ${widgets.length} dashboard widgets`);
      } catch (err) {
        console.warn('⚠️  LLM dashboard generation failed, using template:', err);
        dashboard = this.buildDashboard(project);
      }

      fs.writeFileSync(dashboardPath, JSON.stringify(dashboard, null, 2));

      return { success: true, outputPath: dashboardPath };
    } catch (error) {
      console.error('Error generating dashboard:', error);
      return { success: false, error: String(error) };
    }
  }

  async generateDataScript(project: EngagementSpec): Promise<{ success: boolean; outputPath?: string; error?: string }> {
    try {
      const outputPath = this.storage.getOutputPath(project.id);
      const scriptPath = path.join(outputPath, 'generate_data.py');

      const script = this.buildDataGenerationScript(project);
      fs.writeFileSync(scriptPath, script);

      // Also create requirements.txt
      const requirementsPath = path.join(outputPath, 'requirements.txt');
      const requirements = `sentry-sdk==1.40.0
faker==22.0.0
requests==2.31.0
python-dotenv==1.0.0
`;
      fs.writeFileSync(requirementsPath, requirements);

      // Create .env.example for DSN configuration
      const envExamplePath = path.join(outputPath, '.env.example');
      const envExample = `# Sentry DSN Configuration
SENTRY_DSN_FRONTEND=your_frontend_dsn_here
SENTRY_DSN_BACKEND=your_backend_dsn_here

# Data Generation Settings
NUM_TRACES=100
NUM_ERRORS=20
`;
      fs.writeFileSync(envExamplePath, envExample);

      return { success: true, outputPath: scriptPath };
    } catch (error) {
      console.error('Error generating data script:', error);
      return { success: false, error: String(error) };
    }
  }

  private createDirectoryStructure(appPath: string): void {
    // Only create truly generic directories — no domain-specific subdirectories.
    // The LLM creates page subdirectories (e.g. app/signup/, app/checkout/) on demand
    // based on the actual project spec, so pre-creating e-commerce paths here would
    // leave stale directories in non-e-commerce projects.
    const dirs = [
      appPath,
      path.join(appPath, 'frontend'),
      path.join(appPath, 'frontend', 'app'),
      path.join(appPath, 'frontend', 'lib'),
      path.join(appPath, 'backend'),
      path.join(appPath, 'backend', 'src'),
      path.join(appPath, 'backend', 'src', 'routes'),
      path.join(appPath, 'backend', 'src', 'middleware'),
      path.join(appPath, 'backend', 'src', 'utils')
    ];

    dirs.forEach(dir => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });
  }

  private async generateFrontend(
    appPath: string,
    project: EngagementSpec,
    progress?: (pct: number, label: string) => void,
    routeContract?: RouteContract,
    topologyContract?: TraceTopologyContract | null
  ): Promise<void> {
    const frontendPath = path.join(appPath, 'frontend');

    // Package.json
    const packageJson = {
      name: `${project.project.slug}-frontend`,
      version: '0.1.0',
      private: true,
      scripts: {
        dev: 'next dev -p 3000',
        build: 'next build',
        start: 'next start',
        lint: 'next lint'
      },
      dependencies: {
        '@sentry/nextjs': '^8.0.0',
        'next': '^14.1.0',
        'react': '^18.2.0',
        'react-dom': '^18.2.0'
      },
      devDependencies: {
        '@types/node': '^20',
        '@types/react': '^18',
        '@types/react-dom': '^18',
        'typescript': '^5',
        'tailwindcss': '^3.4.0',
        'postcss': '^8.4.33',
        'autoprefixer': '^10.4.16'
      }
    };
    fs.writeFileSync(path.join(frontendPath, 'package.json'), JSON.stringify(packageJson, null, 2));

    // Next.js config
    const nextConfig = `/** @type {import('next').NextConfig} */
const nextConfig = {
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'
  }
}

module.exports = nextConfig
`;
    fs.writeFileSync(path.join(frontendPath, 'next.config.js'), nextConfig);

    // Tailwind config
    const tailwindConfig = `/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {},
  },
  plugins: [],
}
`;
    fs.writeFileSync(path.join(frontendPath, 'tailwind.config.js'), tailwindConfig);

    // PostCSS config
    const postcssConfig = `module.exports = {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
}
`;
    fs.writeFileSync(path.join(frontendPath, 'postcss.config.js'), postcssConfig);

    // TypeScript config
    const tsConfig = {
      compilerOptions: {
        target: 'ES2020',
        lib: ['dom', 'dom.iterable', 'esnext'],
        allowJs: true,
        skipLibCheck: true,
        strict: false,
        noEmit: true,
        esModuleInterop: true,
        module: 'esnext',
        moduleResolution: 'bundler',
        resolveJsonModule: true,
        isolatedModules: true,
        jsx: 'preserve',
        incremental: true,
        plugins: [{ name: 'next' }],
        paths: {
          '@/*': ['./*']
        }
      },
      include: ['next-env.d.ts', '**/*.ts', '**/*.tsx', '.next/types/**/*.ts'],
      exclude: ['node_modules']
    };
    fs.writeFileSync(path.join(frontendPath, 'tsconfig.json'), JSON.stringify(tsConfig, null, 2));

    // Sentry config
    this.generateSentryConfig(frontendPath, 'frontend', project);

    // Instrumentation (must be generated before pages)
    this.generateFrontendInstrumentation(frontendPath, project);

    progress?.(30, 'Writing frontend pages…');
    // Pages - use LLM to generate with proper instrumentation
    await this.generateFrontendPagesWithLLM(frontendPath, project, routeContract, topologyContract);
  }

  private async generateBackend(
    appPath: string,
    project: EngagementSpec,
    progress?: (pct: number, label: string) => void,
    routeContract?: RouteContract
  ): Promise<void> {
    const backendPath = path.join(appPath, 'backend');

    // Package.json
    const packageJson = {
      name: `${project.project.slug}-backend`,
      version: '0.1.0',
      private: true,
      scripts: {
        dev: 'tsx watch src/index.ts',
        build: 'tsc',
        start: 'node dist/index.js'
      },
      dependencies: {
        '@sentry/node': '^8.0.0',
        '@sentry/profiling-node': '^8.0.0',
        'express': '^4.18.2',
        'cors': '^2.8.5',
        'dotenv': '^16.3.1'
      },
      devDependencies: {
        '@types/express': '^4.17.21',
        '@types/cors': '^2.8.17',
        '@types/node': '^20.10.6',
        'tsx': '^4.7.0',
        'typescript': '^5.3.3'
      }
    };
    fs.writeFileSync(path.join(backendPath, 'package.json'), JSON.stringify(packageJson, null, 2));

    // TypeScript config
    const tsConfig = {
      compilerOptions: {
        target: 'ES2020',
        module: 'commonjs',
        outDir: './dist',
        rootDir: './src',
        strict: false,
        esModuleInterop: true,
        skipLibCheck: true,
        forceConsistentCasingInFileNames: true,
        resolveJsonModule: true
      },
      include: ['src/**/*'],
      exclude: ['node_modules']
    };
    fs.writeFileSync(path.join(backendPath, 'tsconfig.json'), JSON.stringify(tsConfig, null, 2));

    // Sentry config
    this.generateSentryConfig(backendPath, 'backend', project);

    // Main server file
    this.generateBackendServer(backendPath, project);

    // Sentry instrumentation (must be generated before routes)
    this.generateBackendInstrumentation(backendPath, project);

    progress?.(72, 'Writing backend routes…');
    // Always generate template routes first — guaranteed correct structure:
    // correct paths, continueTrace, span wrappers, http.status_code.
    // Then optionally enrich stub bodies with LLM (cosmetic only — never touches structure).
    this.generateBackendRoutes(backendPath, project, routeContract);
    await this.enhanceRouteStubsWithLLM(backendPath, project);
  }

  private generateSentryConfig(basePath: string, layer: 'frontend' | 'backend', project: EngagementSpec): void {
    if (layer === 'frontend') {
      // Next.js requires specific Sentry config files
      
      // sentry.client.config.ts - runs in browser
      const clientConfig = `import * as Sentry from '@sentry/nextjs';

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT || 'development',

  // Explicitly enable browser tracing — required in @sentry/nextjs v8 for pageload
  // and navigation transactions and for custom spans to attach to a root trace
  integrations: [
    Sentry.browserTracingIntegration(),
  ],

  // Set tracesSampleRate to 1.0 to capture 100% of transactions
  tracesSampleRate: 1.0,

  // Propagate trace headers to backend so FE→BE spans connect in Sentry
  tracePropagationTargets: ['localhost', '127.0.0.1', /^\\//],

  // Enable debug mode for troubleshooting (disable in production)
  debug: process.env.NODE_ENV === 'development',
});
`;
      fs.writeFileSync(path.join(basePath, 'sentry.client.config.ts'), clientConfig);

      // sentry.server.config.ts - runs on server
      const serverConfig = `import * as Sentry from '@sentry/nextjs';

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT || 'development',
  
  // Set tracesSampleRate to 1.0 to capture 100% of transactions
  tracesSampleRate: 1.0,
  
  // Enable debug mode for troubleshooting
  debug: process.env.NODE_ENV === 'development',
});
`;
      fs.writeFileSync(path.join(basePath, 'sentry.server.config.ts'), serverConfig);

      // sentry.edge.config.ts - for edge runtime
      const edgeConfig = `import * as Sentry from '@sentry/nextjs';

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT || 'development',
  tracesSampleRate: 1.0,
  debug: process.env.NODE_ENV === 'development',
});
`;
      fs.writeFileSync(path.join(basePath, 'sentry.edge.config.ts'), edgeConfig);

      // instrumentation.ts - for App Router
      const instrumentationConfig = `import * as Sentry from '@sentry/nextjs';

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config');
  }

  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config');
  }
}

export const onRequestError = Sentry.captureRequestError;
`;
      fs.writeFileSync(path.join(basePath, 'instrumentation.ts'), instrumentationConfig);

      // Update next.config.js to use withSentryConfig
      const nextConfig = `const { withSentryConfig } = require('@sentry/nextjs');

/** @type {import('next').NextConfig} */
const nextConfig = {
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'
  },
  // Disable strict mode to avoid double-rendering during development
  reactStrictMode: false,
}

module.exports = withSentryConfig(nextConfig, {
  // Sentry webpack plugin options
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  
  // Suppress source map upload (we're just generating demo data)
  silent: true,
  
  // Upload source maps for better error tracking
  widenClientFileUpload: true,
  
  // Hide source maps from client bundles
  hideSourceMaps: true,
  
  // Disable logger for cleaner output
  disableLogger: true,
  
  // Automatically instrument API routes and server components
  automaticVercelMonitors: true,
});
`;
      fs.writeFileSync(path.join(basePath, 'next.config.js'), nextConfig);

    } else {
      // Backend (Express) Sentry config - Sentry v8 syntax
      const sentryConfigPath = path.join(basePath, 'sentry.config.js');
      const config = `const Sentry = require('@sentry/node');
const { nodeProfilingIntegration } = require('@sentry/profiling-node');

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.SENTRY_ENVIRONMENT || 'development',
  tracesSampleRate: 1.0,
  profilesSampleRate: 1.0,
  debug: process.env.NODE_ENV === 'development',
  integrations: [
    nodeProfilingIntegration(),
    Sentry.expressIntegration(),
  ],
});

module.exports = Sentry;
`;
      fs.writeFileSync(sentryConfigPath, config);
    }
  }

  private async generateFrontendPagesWithLLM(frontendPath: string, project: EngagementSpec, routeContract?: RouteContract, topologyContract?: TraceTopologyContract | null): Promise<void> {
    console.log('🤖 Using LLM to generate Next.js pages with instrumentation...');
    const appPath = path.join(frontendPath, 'app');

    // Wipe all stale page files and their directories before writing the new generation.
    // Without this, pages from a previous run survive regeneration and get included in
    // the build even though they belong to a completely different spec.
    // We keep the framework files (layout.tsx, globals.css, not-found.tsx, global-error.tsx)
    // because those are regenerated separately and are project-agnostic.
    const KEEP = new Set(['layout.tsx', 'globals.css', 'not-found.tsx', 'global-error.tsx']);
    if (fs.existsSync(appPath)) {
      for (const entry of fs.readdirSync(appPath, { withFileTypes: true })) {
        if (KEEP.has(entry.name)) continue;
        const full = path.join(appPath, entry.name);
        try {
          fs.rmSync(full, { recursive: true, force: true });
        } catch {}
      }
      console.log('🧹 Cleared stale pages from previous generation');
    }

    try {
      // Fix 2 Sub-step A: Generate + validate InstrumentationDeclaration before code gen
      let frontendDeclaration: InstrumentationDeclaration | undefined;
      if (topologyContract) {
        console.log('🐾 Generating frontend instrumentation declaration (pre-code plan)…');
        const frontendSpanNames = topologyContract.spans
          .filter(s => s.layer === 'frontend')
          .map(s => s.name);
        let decl = await this.llm.generateInstrumentationDeclaration('frontend', topologyContract, []);
        let { valid, errors } = validateInstrumentationDeclaration(decl, frontendSpanNames);
        if (!valid) {
          // Retry once with error context
          console.warn(`⚠ Declaration invalid: ${errors.join('; ')} — retrying…`);
          decl = await this.llm.generateInstrumentationDeclaration('frontend', topologyContract, []);
          ({ valid, errors } = validateInstrumentationDeclaration(decl, frontendSpanNames));
          if (!valid) {
            console.warn(`⚠ Declaration still invalid after retry: ${errors.join('; ')} — proceeding without grounding`);
          }
        }
        if (valid) {
          frontendDeclaration = decl;
          console.log(`   ✓ Declaration valid — ${decl.spanCoverage.length} spans mapped`);
        }
      }

      console.log('📝 Generating pages with LLM...');
      const { pages } = await this.llm.generateWebPages(project, routeContract, frontendDeclaration);
      console.log(`✅ LLM generated ${pages.length} Next.js pages`);

      // ── Deterministic URL injection ───────────────────────────────────────
      // Replace every fetch() URL in generated pages with the exact URL from
      // the route contract. The LLM never needs to get URLs right.
      if (routeContract && routeContract.routes.length > 0) {
        const pagesMap = new Map(pages.map(p => [p.filename, p.code]));
        const { files: patchedMap, reports } = injectContractUrls(pagesMap, routeContract);
        if (reports.length > 0) {
          for (const report of reports) {
            console.log(`  ✓ URL-injected ${report.replacements.length} URL(s) in ${report.filename}`);
          }
          // Write patched code back to page objects
          for (const page of pages) {
            const patched = patchedMap.get(page.filename);
            if (patched !== undefined) page.code = patched;
          }
        }
      }
      // ─────────────────────────────────────────────────────────────────────

      // Pre-write syntax gate: validate each page with the TypeScript compiler
      // before touching disk. If a page has syntax errors, run a fix-validate
      // loop (LLM fix → re-parse → accept only if clean) so broken code is
      // never written to disk in the first place.
      for (const page of pages) {
        const pagePath = path.join(appPath, page.filename);
        const pageDir = path.dirname(pagePath);
        if (!fs.existsSync(pageDir)) fs.mkdirSync(pageDir, { recursive: true });

        let code = page.code;
        let syntaxErrors = checkPageSyntax(code, page.filename);

        if (syntaxErrors.length > 0) {
          console.log(`  ⚠️  ${page.filename} — ${syntaxErrors.length} syntax error(s), running fix-validate loop`);
          const fixed = await this.fixPageWithValidation(code, syntaxErrors, page.filename, frontendPath, project);
          if (fixed !== null) {
            code = fixed;
            page.code = fixed;
          }
        }

        // Fix 3: Post-generation check before writing to disk
        const contractSpanNames = project.instrumentation.spans
          .filter(s => s.layer === 'frontend')
          .map(s => s.name);
        const postCheck = postGenerationCheck(code, contractSpanNames, page.filename);
        if (!postCheck.clean) {
          console.warn(`  ⚠ Post-generation issues in ${page.filename}:`);
          postCheck.issues.forEach(i => console.warn(`    • ${i}`));
          // Issues are logged as warnings; they'll be caught by static validator if they persist
        }

        fs.writeFileSync(pagePath, code);
        console.log(`  ✓ Created ${page.filename}: ${page.description}`);

        // ── Deterministic marker reconciliation ───────────────────────────
        // Pass 1: strip invented markers (span names not in the contract)
        const contractFESpans = (topologyContract?.spans ?? project.instrumentation.spans)
          .filter(s => s.layer === 'frontend');
        const contractFENames = contractFESpans.map(s => s.name);
        const removed = removeForeignMarkers(pagePath, contractFENames);
        if (removed.length > 0) {
          console.warn(`  ✓ Removed ${removed.length} invented marker(s) from ${page.filename}: ${removed.join(', ')}`);
        }

        // Pass 2: fill markers the LLM missed, using route → fetch-URL matching
        if (routeContract) {
          const filled = fillMissingMarkersFromRoutes(pagePath, contractFESpans, routeContract);
          if (filled.length > 0) {
            console.log(`  ✓ Auto-injected ${filled.length} missing marker(s) into ${page.filename}: ${filled.join(', ')}`);
          }
        }

        // Pass 3: normalise paraphrased span names (Jaccard similarity ≥ 0.6)
        if (topologyContract) {
          const corrections = normaliseSpanNames([pagePath], topologyContract);
          if (corrections.length > 0) {
            console.log(`  ✓ Normalised ${corrections.length} span name(s) in ${page.filename}`);
          }
        }
        // ─────────────────────────────────────────────────────────────────

        // ── UI structure check ────────────────────────────────────────────
        // Verify the page contains form elements implied by its span markers.
        // If inputs or submit buttons are missing, run one LLM repair pass.
        if (topologyContract) {
          const allFESpans = topologyContract.spans.filter(s => s.layer === 'frontend');
          const missingElements = checkPageUIStructure(pagePath, allFESpans);
          if (missingElements.length > 0) {
            console.warn(`  ⚠ ${page.filename} missing UI elements: ${missingElements.join('; ')}`);
            const currentSource = fs.readFileSync(pagePath, 'utf-8');
            // Find which contract spans this page references via markers
            const markerRe = /\/\/\s*INSTRUMENT:\s*([^\s—–\-][^\n—–]*)/g;
            const markerNames: string[] = [];
            let mm: RegExpExecArray | null;
            while ((mm = markerRe.exec(currentSource)) !== null) {
              markerNames.push(mm[1].trim().replace(/\s*[—–\-\s].*$/, '').trim());
            }
            const relevantSpans = allFESpans.filter(s => markerNames.includes(s.name));
            const repairPrompt = buildUIRepairPrompt(currentSource, page.filename, missingElements, relevantSpans);
            try {
              const settings = this.storage.getSettings();
              const fixed = await this.llm.callLLMDirect(
                [{ role: 'user', content: repairPrompt }],
                { baseUrl: settings.llm.baseUrl, apiKey: settings.llm.apiKey, model: settings.llm.model }
              );
              const cleaned = fixed.trim()
                .replace(/^```(?:typescript|tsx|ts)?\n?/, '')
                .replace(/\n?```[\s\S]*$/, '')
                .trim();
              if (cleaned.length > 100) {
                fs.writeFileSync(pagePath, cleaned);
                console.log(`  ✓ UI structure repaired in ${page.filename}`);
              }
            } catch (uiErr: any) {
              console.warn(`  ⚠ UI structure repair failed for ${page.filename}: ${uiErr?.message}`);
            }
          }
        }
        // ─────────────────────────────────────────────────────────────────
        // NOTE: Instrumentation injection (// INSTRUMENT: → trace_*() calls) is
        // intentionally deferred. It runs after static topology validation so that
        // the validator can inspect raw markers. See injectAllInstrumentation().
      }

      // Post-generation validation: fix any hallucinated instrumentation imports or API URLs.
      // We read the generated lib/instrumentation.ts to get ground-truth function names,
      // then check each page for invalid imports and run an LLM fix pass on offenders.
      await this.validateAndFixGeneratedPages(pages, appPath, frontendPath, project);

      // Ensure the root page (/) is the app's primary entry point.
      // The LLM often generates app/page.tsx as a post-action dashboard while placing
      // the primary interaction (form, search, etc.) at a sub-route. Score pages using
      // source-level signals so this works even before marker names are normalised.
      {
        const rootPagePath = path.join(frontendPath, 'app', 'page.tsx');
        const appDir2 = path.join(frontendPath, 'app');

        const INPUT_KW  = ['input', 'validate', 'email', 'password', 'signup', 'login', 'register', 'form', 'fill', 'search'];
        const SUBMIT_KW = ['submit', 'send', 'create', 'checkout', 'confirm', 'save'];

        interface PageScore { route: string; file: string; score: number }
        const scores: PageScore[] = [];

        for (const pg of pages) {
          const pgPath = path.join(appPath, pg.filename);
          if (!fs.existsSync(pgPath)) continue;
          const src = fs.readFileSync(pgPath, 'utf-8');
          const srcLower = src.toLowerCase();

          // Raw marker count — doesn't require names to match contract
          const markerCount = (src.match(/\/\/\s*INSTRUMENT:/g) ?? []).length;
          // Form/input element presence
          const hasForm  = /<form[\s>/]/i.test(src) ? 4 : 0;
          const hasInput = /<input[\s/]/i.test(src) ? 4 : 0;
          // Keyword hits directly in source text
          const inputHits  = INPUT_KW.filter(kw => srcLower.includes(kw)).length;
          const submitHits = SUBMIT_KW.filter(kw => srcLower.includes(kw)).length;
          // Placeholder penalty — dashboard template pages score lower
          const isPlaceholder = PLACEHOLDER_PATTERNS.some(p => p.test(src)) ? 3 : 0;

          const score = markerCount * 3 + hasForm + hasInput + inputHits + submitHits * 2 - isPlaceholder;

          // Derive route via path.relative so it works for any filename format
          const relPath = path.relative(appDir2, pgPath).replace(/\\/g, '/');
          const routePart = relPath.replace(/\/?page\.tsx$/, '');
          const route = routePart === '' ? '/' : `/${routePart}`;

          scores.push({ route, file: pgPath, score });
        }

        if (scores.length > 0) {
          const rootScore = scores.find(s => s.route === '/')?.score ?? 0;
          const best = scores.reduce((a, b) => b.score > a.score ? b : a);

          if (best.route !== '/' && best.score > rootScore && fs.existsSync(rootPagePath)) {
            const redirectSource =
              `import { redirect } from 'next/navigation';\n\n` +
              `// Root redirects to the primary entry point of this app.\n` +
              `export default function Home() {\n` +
              `  redirect('${best.route}');\n` +
              `}\n`;
            fs.writeFileSync(rootPagePath, redirectSource);
            onOutput?.(`   ✓ Root page redirects to primary entry point: ${best.route}\n`);
          }
        }
      }

      // Extract DOM manifest for flow generation
      const pageFilePaths = pages.map(p => path.join(appPath, p.filename)).filter(p => fs.existsSync(p));
      if (pageFilePaths.length > 0) {
        try {
          extractDOMManifest(pageFilePaths, path.dirname(frontendPath));
          console.log('   ✓ DOM manifest extracted');
        } catch (e: any) {
          console.warn(`   ⚠ DOM manifest extraction failed: ${e?.message}`);
        }
      }

      // Create globals.css
      const globalsCss = `@tailwind base;
@tailwind components;
@tailwind utilities;

:root {
  --background: #ffffff;
  --foreground: #171717;
}

@media (prefers-color-scheme: dark) {
  :root {
    --background: #0a0a0a;
    --foreground: #ededed;
  }
}

body {
  color: var(--foreground);
  background: var(--background);
  font-family: Arial, Helvetica, sans-serif;
}

@layer utilities {
  .text-balance {
    text-wrap: balance;
  }
}

/* Custom components */
.card {
  @apply bg-white rounded-lg shadow-md p-6 hover:shadow-lg transition-shadow;
}

.btn {
  @apply px-4 py-2 rounded-lg font-medium transition-colors;
}

.btn-primary {
  @apply bg-purple-600 text-white hover:bg-purple-700;
}

.btn-secondary {
  @apply bg-gray-200 text-gray-800 hover:bg-gray-300;
}

.input {
  @apply w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent;
}
`;
      fs.writeFileSync(path.join(appPath, 'globals.css'), globalsCss);

      // Create layout.tsx
      const layout = `import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '${project.project.name}',
  description: 'Generated by SE Copilot',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
`;
      fs.writeFileSync(path.join(appPath, 'layout.tsx'), layout);

      // app/not-found.tsx — App Router 404 page.
      // Without this, Next.js falls back to Pages Router's _error which imports <Html>
      // from next/document and triggers a hard build error.
      const notFound = `export default function NotFound() {
  return (
    <div style={{ padding: '2rem', textAlign: 'center' }}>
      <h1>404 — Page Not Found</h1>
      <p>The page you&apos;re looking for doesn&apos;t exist.</p>
    </div>
  );
}
`;
      fs.writeFileSync(path.join(appPath, 'not-found.tsx'), notFound);

      // app/global-error.tsx — App Router equivalent of pages/_error.tsx.
      // Must be a Client Component and must render its own <html>/<body> because
      // it replaces the root layout when a top-level error occurs.
      const globalError = `'use client';
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html>
      <body style={{ padding: '2rem', textAlign: 'center' }}>
        <h2>Something went wrong</h2>
        <button onClick={reset}>Try again</button>
      </body>
    </html>
  );
}
`;
      fs.writeFileSync(path.join(appPath, 'global-error.tsx'), globalError);

    } catch (error) {
      console.error('❌ Failed to generate pages with LLM:', error);
      console.log('⚠️  Falling back to template pages...');
      // Fallback to old method if LLM fails
      this.generateFrontendPages(frontendPath, project);
    }
  }

  /**
   * After LLM-generated pages are written to disk, validate ALL page.tsx files in the
   * app/ directory (both newly generated AND pre-existing stale files from prior generations).
   *
   * Two failure modes are caught and sent to the LLM for fixing:
   * 1. Invalid imports — the page imports a trace_* name that no longer exists in
   *    lib/instrumentation.ts (happens when a project is regenerated with a new spec).
   * 2. Inline Sentry.startSpan — the page bypassed the generated helpers and called
   *    Sentry.startSpan() directly with no import from @/lib/instrumentation.
   */
  private async validateAndFixGeneratedPages(
    pages: Array<{ name: string; filename: string; code: string; description: string }>,
    appPath: string,
    frontendPath: string,
    project: EngagementSpec
  ): Promise<void> {
    const instrumentationPath = path.join(frontendPath, 'lib', 'instrumentation.ts');
    if (!fs.existsSync(instrumentationPath)) {
      console.warn('⚠️  lib/instrumentation.ts not found, skipping validation');
      return;
    }

    // Extract ground-truth function names from the generated instrumentation file
    const instrContent = fs.readFileSync(instrumentationPath, 'utf-8');
    const validFns = Array.from(instrContent.matchAll(/export function (trace_\w+)/g), m => m[1]);
    if (validFns.length === 0) {
      console.warn('⚠️  No trace_* functions found in instrumentation.ts, skipping validation');
      return;
    }

    // Derive valid API endpoints using the same pattern as the LLM prompt
    const validEndpoints = project.instrumentation.spans.map(span => {
      const parts = span.name.split('.');
      if (parts.length === 1) return `/${parts[0].replace(/_/g, '-')}`;
      const namespace = parts[0];
      const action = parts.slice(1).join('/').replace(/_/g, '-');
      return `/${namespace}/${action}`;
    });

    // Build the full set of pages to check:
    // - The LLM's freshly generated pages (may have hallucinated names or inline Sentry.startSpan)
    // - Any pre-existing page.tsx files on disk NOT in the LLM's output (stale from prior generation)
    const generatedFilenames = new Set(pages.map(p => p.filename));
    const diskPages = this.scanPageFilesInDirectory(appPath)
      .filter(f => !generatedFilenames.has(f.filename))
      .map(f => ({ name: f.filename, filename: f.filename, code: f.code, description: 'pre-existing' }));

    const allPages = [...pages, ...diskPages];
    console.log(`🔍 Validating ${allPages.length} pages (${pages.length} generated + ${diskPages.length} pre-existing)...`);

    for (const page of allPages) {
      // ── Syntax scrub — applied unconditionally before any other check ──────
      let scrubbed = page.code;

      // 1. Unquoted dot-notation object keys: { http.status_code: 0 } → { 'http.status_code': 0 }
      scrubbed = scrubbed.replace(
        /([{,]\s*)([a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)+)\s*:/g,
        "$1'$2':"
      );

      // 2. Missing closing paren on trace_* calls.
      // LLM consistently emits: }, { key: val };
      // Correct form is:        }, { key: val });
      // The pattern matches the closing object-arg of a two-argument function call
      // where the outer call's `)` was dropped.  We handle up to one level of
      // nested `{}` inside the attribute object (e.g. { headers: {} }).
      scrubbed = scrubbed.replace(
        /(},\s*\{(?:[^{}]|\{[^}]*\})*\})\s*;/g,
        (match, group) => {
          // Only fix if this looks like a function argument context (preceded by `)`
          // from the async callback closing brace).  Avoid replacing plain object
          // literals that legitimately end with `};`.
          return group + ');';
        }
      );

      if (scrubbed !== page.code) {
        page.code = scrubbed;
        fs.writeFileSync(path.join(appPath, page.filename), scrubbed);
        console.log(`  ✓ ${page.filename} — syntax scrub applied`);
      }

      // Compiler-level syntax check on ALL pages (generated + pre-existing).
      // Catches any syntax error the LLM introduced regardless of pattern.
      // Only attempt LLM fix here if the error is new (i.e. scrub didn't fix it).
      const syntaxErrors = checkPageSyntax(page.code, page.filename);
      if (syntaxErrors.length > 0) {
        console.warn(`  ⚠️  ${page.filename} — syntax errors detected post-scrub, attempting fix`);
        const fixed = await this.fixPageWithValidation(page.code, syntaxErrors, page.filename, frontendPath, project);
        if (fixed !== null) {
          page.code = fixed;
          fs.writeFileSync(path.join(appPath, page.filename), fixed);
          console.log(`  ✓ ${page.filename} — syntax fixed`);
        }
      }

      // Deterministic check: page uses React hooks but is missing 'use client'.
      // Without 'use client', Next.js treats it as a Server Component and hooks
      // called during SSR will throw "Cannot read properties of null (reading 'useContext')".
      const HOOK_RE = /\b(useState|useEffect|useContext|useCallback|useMemo|useRef|useReducer|useSearchParams|useRouter|usePathname|useParams)\s*[(<]/;
      const hasHooks = HOOK_RE.test(page.code);
      const hasUseClient = /^\s*['"]use client['"]/.test(page.code);
      if (hasHooks && !hasUseClient) {
        page.code = `'use client';\n${page.code}`;
        fs.writeFileSync(path.join(appPath, page.filename), page.code);
        console.log(`  ✓ ${page.filename} — added missing 'use client' directive`);
      }

      const importMatch = page.code.match(/import \{([^}]+)\} from ['"]@\/lib\/instrumentation['"]/);
      const importedNames = importMatch
        ? importMatch[1].split(',').map((s: string) => s.trim()).filter(Boolean)
        : [];
      const invalidNames = importedNames.filter((n: string) => !validFns.includes(n));

      // Detect trace_* calls that exist in the page but are never imported.
      // LLMs sometimes generate the call sites but forget the import statement.
      const usedFns = Array.from(page.code.matchAll(/\b(trace_\w+)\s*\(/g), m => m[1]);
      const missingImports = [...new Set(usedFns)].filter(
        fn => validFns.includes(fn) && !importedNames.includes(fn)
      );
      if (missingImports.length > 0) {
        const allNeeded = [...new Set([...importedNames.filter((n: string) => validFns.includes(n)), ...missingImports])];
        const newImport = `import { ${allNeeded.join(', ')} } from '@/lib/instrumentation';`;
        if (importMatch) {
          page.code = page.code.replace(importMatch[0], newImport);
        } else {
          // No instrumentation import at all — insert after the last import line
          const lastImportIdx = [...page.code.matchAll(/^import .+$/gm)].pop()?.index ?? 0;
          const insertAt = lastImportIdx + page.code.slice(lastImportIdx).indexOf('\n') + 1;
          page.code = page.code.slice(0, insertAt) + newImport + '\n' + page.code.slice(insertAt);
        }
        fs.writeFileSync(path.join(appPath, page.filename), page.code);
        console.log(`  ✓ ${page.filename} — added missing imports: ${missingImports.join(', ')}`);
      }

      // Detect inline Sentry.startSpan usage without any instrumentation import
      const hasInlineSpan = page.code.includes('Sentry.startSpan(');
      const hasInstrumentationImport = page.code.includes("from '@/lib/instrumentation'");

      // Detect trace functions called with wrong first argument (string/identifier instead of async callback)
      // Valid: trace_foo(async () => {...}, attrs)
      // Invalid: trace_foo(stringValue, ...) or trace_foo(varName, 'label', ...)
      const hasWrongCallSignature = /trace_\w+\(\s*(?!async\s*\()['"`\w]/.test(page.code);

      const needsFix = invalidNames.length > 0
        || (hasInlineSpan && !hasInstrumentationImport)
        || hasWrongCallSignature;

      if (!needsFix) {
        console.log(`  ✓ ${page.filename} — OK`);
        continue;
      }

      const reason = invalidNames.length > 0
        ? `invalid imports: ${invalidNames.join(', ')}`
        : hasWrongCallSignature
          ? 'trace function called with non-callback first argument (string/identifier instead of async () => {})'
          : 'uses inline Sentry.startSpan without instrumentation helpers';
      console.log(`  ⚠️  ${page.filename} — ${reason} — fixing with LLM...`);

      try {
        const fixed = await this.llm.validateAndFixPage(page, validFns, validEndpoints);
        const pagePath = path.join(appPath, page.filename);
        fs.writeFileSync(pagePath, fixed.code);
        page.code = fixed.code;
        console.log(`  ✓ Fixed ${page.filename}`);
      } catch (err) {
        console.warn(`  ⚠️  Could not fix ${page.filename}: ${err}`);
      }
    }
  }

  /**
   * Fix-validate loop: ask the LLM to fix syntax errors, then re-parse the result
   * with the TypeScript compiler before accepting it.  Repeats up to MAX_ATTEMPTS
   * times, each time feeding the NEW compiler errors back into the prompt so the
   * LLM has accurate context.  Only returns code that actually passes the parser —
   * if all attempts fail, returns null so the caller can fall back gracefully.
   */
  private async fixPageWithValidation(
    code: string,
    initialErrors: import('./page-syntax-validator').PageSyntaxError[],
    filename: string,
    frontendPath: string,
    project: EngagementSpec
  ): Promise<string | null> {
    const MAX_ATTEMPTS = 3;
    const settings = this.storage.getSettings();
    if (!settings.llm.baseUrl || !settings.llm.apiKey) return null;

    let currentCode = code;
    let currentErrors = initialErrors;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      console.log(`  🔧 Syntax fix attempt ${attempt}/${MAX_ATTEMPTS} for ${filename}`);

      const errorBlock = formatSyntaxErrorsForLLM(currentErrors);

      // Pull a working trace_* example from the instrumentation file for grounding
      const instrPath = path.join(frontendPath, 'lib', 'instrumentation.ts');
      let exampleBlock = '';
      try {
        const instrCode = fs.readFileSync(instrPath, 'utf8');
        const exMatch = instrCode.match(/export (async )?function trace_\w+[\s\S]{0,400}/);
        if (exMatch) exampleBlock = `\nCORRECT PATTERN from your instrumentation file:\n${exMatch[0].slice(0, 300)}\n`;
      } catch { /* instrumentation file may not exist yet */ }

      const prompt = `Fix the TypeScript syntax errors in this Next.js page.
Return ONLY the complete corrected file — no explanation, no markdown fences.
${exampleBlock}
SYNTAX ERRORS (${currentErrors.length}):
${errorBlock}

CONSTRAINTS — you MUST follow all of these:
- Do NOT remove or rename any trace_* function calls
- Every trace_* call takes exactly TWO arguments: (async () => { ... }, { attrs })
  The outer call closes with ); — NOT with }; or } alone
- Do NOT add imports that are not already present in the file
- Keep all existing component logic, state, and JSX intact

FILE (${filename}):
${currentCode}`;

      let fixed: string;
      try {
        const raw = await this.llm.callLLMDirect(
          [{ role: 'user', content: prompt }],
          settings.llm
        );
        fixed = raw
          .replace(/^```(?:typescript|tsx|javascript|js)?\n?/, '')
          .replace(/\n?```[\s\S]*$/, '')
          .trim();
      } catch (e: any) {
        console.warn(`  ⚠️  LLM call failed on attempt ${attempt}: ${e?.message}`);
        break;
      }

      // Validate the fix before accepting it
      const newErrors = checkPageSyntax(fixed, filename);
      if (newErrors.length === 0) {
        console.log(`  ✓ ${filename} — syntax clean after ${attempt} attempt(s)`);
        return fixed;
      }

      console.warn(`  ⚠️  Fix attempt ${attempt} introduced/kept ${newErrors.length} error(s) — retrying with updated context`);
      currentCode = fixed;
      currentErrors = newErrors;
    }

    console.error(`  ✗ ${filename} — could not fix syntax after ${MAX_ATTEMPTS} attempts, writing best effort`);
    return null;
  }

  /**
   * Scan all page.tsx files recursively under appPath and return their filename
   * (relative to appPath) and code. Used to find pre-existing pages for validation.
   */
  private scanPageFilesInDirectory(appPath: string): Array<{ filename: string; code: string }> {
    const results: Array<{ filename: string; code: string }> = [];

    const scan = (dir: string, relDir: string = '') => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith('.') && !entry.name.startsWith('_') && entry.name !== 'node_modules') {
          scan(path.join(dir, entry.name), relDir ? `${relDir}/${entry.name}` : entry.name);
        } else if (entry.name === 'page.tsx') {
          const fullPath = path.join(dir, entry.name);
          const filename = relDir ? `${relDir}/page.tsx` : 'page.tsx';
          results.push({ filename, code: fs.readFileSync(fullPath, 'utf-8') });
        }
      }
    };

    scan(appPath);
    return results;
  }

  private getVerticalPageConfig(vertical: string, projectName: string): any {
    const configs: Record<string, any> = {
      ecommerce: {
        loadDataSpanName: 'Load Products',
        apiEndpoint: 'products',
        dataKey: 'products',
        heroTitle: 'Welcome to Our Store',
        heroSubtitle: 'Discover amazing products with real-time monitoring',
        itemIcon: 'image',
        defaultIcon: '📦',
        itemTitle: 'name',
        itemSubtitle: 'description',
        showPrice: true,
        priceField: 'price',
        itemClickSpanName: 'View Product',
        navLinks: [
          { href: '/products', label: '🛍️ Products' },
          { href: '/cart', label: '🛒 Cart' },
          { href: '/checkout', label: '💳 Checkout' }
        ],
        fallbackData: [
          { id: 1, name: 'Premium Headphones', price: 99.99, image: '🎧', description: 'Wireless noise-cancelling' },
          { id: 2, name: 'Smart Watch', price: 149.99, image: '⌚', description: 'Fitness tracking' },
          { id: 3, name: 'Laptop Stand', price: 79.99, image: '💻', description: 'Ergonomic design' },
        ]
      },
      fintech: {
        loadDataSpanName: 'Load Accounts',
        apiEndpoint: 'accounts',
        dataKey: 'accounts',
        heroTitle: 'Your Financial Dashboard',
        heroSubtitle: 'Manage your finances with confidence',
        itemIcon: 'icon',
        defaultIcon: '💰',
        itemTitle: 'name',
        itemSubtitle: 'type',
        showPrice: true,
        priceField: 'balance',
        itemClickSpanName: 'View Account',
        navLinks: [
          { href: '/accounts', label: '💰 Accounts' },
          { href: '/transactions', label: '📊 Transactions' },
          { href: '/transfer', label: '💸 Transfer' }
        ],
        fallbackData: [
          { id: 1, name: 'Checking Account', balance: 5420.50, icon: '🏦', type: 'Primary checking' },
          { id: 2, name: 'Savings Account', balance: 12350.00, icon: '💵', type: 'High-yield savings' },
          { id: 3, name: 'Investment Portfolio', balance: 45000.00, icon: '📈', type: 'Stocks & ETFs' },
        ]
      },
      healthcare: {
        loadDataSpanName: 'Load Patient Data',
        apiEndpoint: 'patients',
        dataKey: 'records',
        heroTitle: 'Patient Portal',
        heroSubtitle: 'Your health information at your fingertips',
        itemIcon: 'icon',
        defaultIcon: '🏥',
        itemTitle: 'title',
        itemSubtitle: 'description',
        showPrice: false,
        priceField: '',
        itemClickSpanName: 'View Record',
        navLinks: [
          { href: '/records', label: '📋 Records' },
          { href: '/appointments', label: '📅 Appointments' },
          { href: '/prescriptions', label: '💊 Prescriptions' }
        ],
        fallbackData: [
          { id: 1, title: 'Recent Checkup', icon: '🩺', description: 'Annual physical - Jan 2024' },
          { id: 2, title: 'Lab Results', icon: '🔬', description: 'Blood work - Normal' },
          { id: 3, title: 'Upcoming Appointment', icon: '📅', description: 'Dr. Smith - Feb 15' },
        ]
      },
      saas: {
        loadDataSpanName: 'Load Projects',
        apiEndpoint: 'projects',
        dataKey: 'projects',
        heroTitle: 'Your Dashboard',
        heroSubtitle: 'Manage your projects and workflows',
        itemIcon: 'icon',
        defaultIcon: '📁',
        itemTitle: 'name',
        itemSubtitle: 'status',
        showPrice: false,
        priceField: '',
        itemClickSpanName: 'View Project',
        navLinks: [
          { href: '/projects', label: '📁 Projects' },
          { href: '/team', label: '👥 Team' },
          { href: '/settings', label: '⚙️ Settings' }
        ],
        fallbackData: [
          { id: 1, name: 'Website Redesign', icon: '🎨', status: 'In Progress - 75%' },
          { id: 2, name: 'Mobile App', icon: '📱', status: 'Planning Phase' },
          { id: 3, name: 'API Integration', icon: '🔗', status: 'Completed' },
        ]
      },
      gaming: {
        loadDataSpanName: 'Load Games',
        apiEndpoint: 'games',
        dataKey: 'games',
        heroTitle: 'Game Lobby',
        heroSubtitle: 'Find your next adventure',
        itemIcon: 'icon',
        defaultIcon: '🎮',
        itemTitle: 'name',
        itemSubtitle: 'players',
        showPrice: false,
        priceField: '',
        itemClickSpanName: 'View Game',
        navLinks: [
          { href: '/games', label: '🎮 Games' },
          { href: '/leaderboard', label: '🏆 Leaderboard' },
          { href: '/profile', label: '👤 Profile' }
        ],
        fallbackData: [
          { id: 1, name: 'Space Adventure', icon: '🚀', players: '1.2k players online' },
          { id: 2, name: 'Fantasy Quest', icon: '⚔️', players: '856 players online' },
          { id: 3, name: 'Racing Pro', icon: '🏎️', players: '2.3k players online' },
        ]
      },
      media: {
        loadDataSpanName: 'Load Content',
        apiEndpoint: 'content',
        dataKey: 'items',
        heroTitle: 'Trending Now',
        heroSubtitle: 'Discover the latest content',
        itemIcon: 'thumbnail',
        defaultIcon: '🎬',
        itemTitle: 'title',
        itemSubtitle: 'category',
        showPrice: false,
        priceField: '',
        itemClickSpanName: 'View Content',
        navLinks: [
          { href: '/browse', label: '🎬 Browse' },
          { href: '/library', label: '📚 Library' },
          { href: '/watchlist', label: '⭐ Watchlist' }
        ],
        fallbackData: [
          { id: 1, title: 'Documentary: Tech Giants', thumbnail: '🎥', category: 'Documentary • 2h 15m' },
          { id: 2, title: 'Comedy Special', thumbnail: '😂', category: 'Comedy • 1h 30m' },
          { id: 3, title: 'Action Movie', thumbnail: '💥', category: 'Action • 2h 5m' },
        ]
      },
      other: {
        loadDataSpanName: 'Load Data',
        apiEndpoint: 'items',
        dataKey: 'items',
        heroTitle: 'Welcome to ' + projectName,
        heroSubtitle: 'Your application dashboard',
        itemIcon: 'icon',
        defaultIcon: '📊',
        itemTitle: 'name',
        itemSubtitle: 'description',
        showPrice: false,
        priceField: '',
        itemClickSpanName: 'View Item',
        navLinks: [
          { href: '/dashboard', label: '📊 Dashboard' },
          { href: '/data', label: '📁 Data' },
          { href: '/settings', label: '⚙️ Settings' }
        ],
        fallbackData: [
          { id: 1, name: 'Item One', icon: '📌', description: 'First sample item' },
          { id: 2, name: 'Item Two', icon: '📎', description: 'Second sample item' },
          { id: 3, name: 'Item Three', icon: '📍', description: 'Third sample item' },
        ]
      }
    };

    return configs[vertical] || configs.other;
  }

  private getSecondaryPageConfig(vertical: string, projectName: string): any {
    const configs: Record<string, any> = {
      ecommerce: {
        directory: 'cart',
        pageTitle: 'Shopping Cart',
        loadSpanName: 'Load Cart',
        endpoint: 'cart',
        dataKey: 'items',
        defaultIcon: '🛒',
        titleField: 'name',
        subtitleField: 'description',
        actionOp: 'cart.checkout',
        actionName: 'Checkout Item',
        actionEndpoint: 'checkout',
        actionLabel: 'Buy Now',
        fallbackData: [
          { id: 1, name: 'Premium Headphones', description: '$99.99 × 1', icon: '🎧' },
          { id: 2, name: 'Smart Watch', description: '$149.99 × 2', icon: '⌚' },
        ]
      },
      fintech: {
        directory: 'transactions',
        pageTitle: 'Recent Transactions',
        loadSpanName: 'Load Transactions',
        endpoint: 'transactions',
        dataKey: 'transactions',
        defaultIcon: '💳',
        titleField: 'description',
        subtitleField: 'amount',
        actionOp: 'transaction.view',
        actionName: 'View Transaction',
        actionEndpoint: 'transaction/view',
        actionLabel: 'Details',
        fallbackData: [
          { id: 1, description: 'Coffee Shop', amount: '-$4.50', icon: '☕' },
          { id: 2, description: 'Salary Deposit', amount: '+$3,500.00', icon: '💰' },
          { id: 3, description: 'Electric Bill', amount: '-$120.00', icon: '⚡' },
        ]
      },
      healthcare: {
        directory: 'appointments',
        pageTitle: 'Your Appointments',
        loadSpanName: 'Load Appointments',
        endpoint: 'appointments',
        dataKey: 'appointments',
        defaultIcon: '📅',
        titleField: 'title',
        subtitleField: 'datetime',
        actionOp: 'appointment.manage',
        actionName: 'Manage Appointment',
        actionEndpoint: 'appointment/manage',
        actionLabel: 'Reschedule',
        fallbackData: [
          { id: 1, title: 'Dr. Smith - Checkup', datetime: 'Feb 15, 2024 at 10:00 AM', icon: '🩺' },
          { id: 2, title: 'Lab Work', datetime: 'Feb 20, 2024 at 8:30 AM', icon: '🔬' },
        ]
      },
      saas: {
        directory: 'projects',
        pageTitle: 'Your Projects',
        loadSpanName: 'Load Projects',
        endpoint: 'projects',
        dataKey: 'projects',
        defaultIcon: '📁',
        titleField: 'name',
        subtitleField: 'status',
        actionOp: 'project.open',
        actionName: 'Open Project',
        actionEndpoint: 'project/open',
        actionLabel: 'Open',
        fallbackData: [
          { id: 1, name: 'Website Redesign', status: 'In Progress', icon: '🎨' },
          { id: 2, name: 'Mobile App', status: 'Planning', icon: '📱' },
        ]
      },
      gaming: {
        directory: 'leaderboard',
        pageTitle: 'Leaderboard',
        loadSpanName: 'Load Leaderboard',
        endpoint: 'leaderboard',
        dataKey: 'players',
        defaultIcon: '🏆',
        titleField: 'name',
        subtitleField: 'score',
        actionOp: 'player.challenge',
        actionName: 'Challenge Player',
        actionEndpoint: 'challenge',
        actionLabel: 'Challenge',
        fallbackData: [
          { id: 1, name: 'ProGamer99', score: '15,420 pts', icon: '🥇' },
          { id: 2, name: 'NinjaPlayer', score: '14,890 pts', icon: '🥈' },
          { id: 3, name: 'GameMaster', score: '13,200 pts', icon: '🥉' },
        ]
      },
      media: {
        directory: 'library',
        pageTitle: 'Your Library',
        loadSpanName: 'Load Library',
        endpoint: 'library',
        dataKey: 'items',
        defaultIcon: '🎬',
        titleField: 'title',
        subtitleField: 'info',
        actionOp: 'media.play',
        actionName: 'Play Content',
        actionEndpoint: 'play',
        actionLabel: 'Play',
        fallbackData: [
          { id: 1, title: 'Favorite Movie', info: 'Added Jan 2024', icon: '🎥' },
          { id: 2, title: 'Documentary', info: 'Watch later', icon: '📺' },
        ]
      },
      other: {
        directory: 'data',
        pageTitle: 'Data View',
        loadSpanName: 'Load Data',
        endpoint: 'data',
        dataKey: 'items',
        defaultIcon: '📊',
        titleField: 'name',
        subtitleField: 'description',
        actionOp: 'data.view',
        actionName: 'View Item',
        actionEndpoint: 'view',
        actionLabel: 'View',
        fallbackData: [
          { id: 1, name: 'Item One', description: 'Sample data', icon: '📌' },
          { id: 2, name: 'Item Two', description: 'Sample data', icon: '📎' },
        ]
      }
    };

    return configs[vertical] || configs.other;
  }

  private getActionPageConfig(vertical: string): any {
    const configs: Record<string, any> = {
      ecommerce: {
        pageTitle: 'Checkout',
        submitOp: 'checkout.submit',
        submitSpanName: 'Submit Order',
        endpoint: 'checkout',
        successTitle: 'Order Confirmed!',
        successMessage: 'Thank you for your purchase.',
        buttonText: 'Complete Order',
        directory: 'checkout'
      },
      fintech: {
        pageTitle: 'Transfer Funds',
        submitOp: 'transfer.submit',
        submitSpanName: 'Submit Transfer',
        endpoint: 'transfer',
        successTitle: 'Transfer Complete!',
        successMessage: 'Your transfer has been processed.',
        buttonText: 'Send Transfer',
        directory: 'transfer'
      },
      healthcare: {
        pageTitle: 'Book Appointment',
        submitOp: 'appointment.book',
        submitSpanName: 'Book Appointment',
        endpoint: 'appointments',
        successTitle: 'Appointment Booked!',
        successMessage: 'Your appointment has been scheduled.',
        buttonText: 'Confirm Booking',
        directory: 'book'
      },
      saas: {
        pageTitle: 'Create Project',
        submitOp: 'project.create',
        submitSpanName: 'Create Project',
        endpoint: 'projects',
        successTitle: 'Project Created!',
        successMessage: 'Your new project is ready.',
        buttonText: 'Create Project',
        directory: 'create'
      },
      gaming: {
        pageTitle: 'Join Game',
        submitOp: 'game.join',
        submitSpanName: 'Join Game',
        endpoint: 'games/join',
        successTitle: 'Joined Game!',
        successMessage: 'You have joined the game.',
        buttonText: 'Join Now',
        directory: 'join'
      },
      media: {
        pageTitle: 'Subscribe',
        submitOp: 'subscription.create',
        submitSpanName: 'Create Subscription',
        endpoint: 'subscribe',
        successTitle: 'Subscribed!',
        successMessage: 'Welcome to premium content.',
        buttonText: 'Subscribe Now',
        directory: 'subscribe'
      },
      other: {
        pageTitle: 'Submit',
        submitOp: 'form.submit',
        submitSpanName: 'Submit Form',
        endpoint: 'submit',
        successTitle: 'Submitted!',
        successMessage: 'Your submission was successful.',
        buttonText: 'Submit',
        directory: 'submit'
      }
    };

    return configs[vertical] || configs.other;
  }

  private generateFrontendPages(frontendPath: string, project: EngagementSpec): void {
    const appPath = path.join(frontendPath, 'app');
    const vertical = project.project.vertical;

    // Generate vertical-specific pages
    const pageConfig = this.getVerticalPageConfig(vertical, project.project.name);

    // Find the best span to wrap the main data load — prefer list/search/load/fetch spans
    const READ_KW = ['list', 'search', 'load', 'fetch', 'filter', 'query', 'get'];
    const primarySpan = project.instrumentation.spans.find(s =>
      READ_KW.some(k => s.name.toLowerCase().includes(k))
    ) || project.instrumentation.spans[0] || null;
    const primarySpanFn = primarySpan ? `trace_${primarySpan.name.replace(/\./g, '_')}` : null;
    const primarySpanAttrs = primarySpan
      ? Object.keys(primarySpan.attributes).slice(0, 3).map(k => `${k}: ''`).join(', ')
      : '';

    const homeImportLine = primarySpanFn
      ? `import { ${primarySpanFn} } from '@/lib/instrumentation';`
      : '';

    const homeLoadDataBody = primarySpanFn
      ? `const result = await ${primarySpanFn}(async () => {
        const response = await fetch(\`\${API_URL}/api/${pageConfig.apiEndpoint}\`);
        if (!response.ok) throw new Error('Failed to load data');
        return response.json();
      }, { ${primarySpanAttrs} });
      setData(result.${pageConfig.dataKey} || result || []);`
      : `const response = await fetch(\`\${API_URL}/api/${pageConfig.apiEndpoint}\`);
      if (!response.ok) throw new Error('Failed to load data');
      const result = await response.json();
      setData(result.${pageConfig.dataKey} || result || []);`;

    // Home page that fetches from backend API
    const homePage = `'use client';
import * as Sentry from '@sentry/nextjs';
import Link from 'next/link';
import { useEffect, useState } from 'react';
${homeImportLine}

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

export default function Home() {
  const [data, setData] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      ${homeLoadDataBody}
    } catch (err) {
      console.error('Error loading data:', err);
      Sentry.captureException(err);
      setError('Failed to load data');
      setData(${JSON.stringify(pageConfig.fallbackData)});
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-600"></div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-50 to-blue-50">
      <header className="bg-white shadow-sm">
        <div className="max-w-7xl mx-auto px-4 py-4 flex justify-between items-center">
          <h1 className="text-3xl font-bold text-purple-600">${project.project.name}</h1>
          <nav className="flex gap-4">
            ${pageConfig.navLinks.map((link: any) => `<Link href="${link.href}" className="text-purple-600 hover:text-purple-800">${link.label}</Link>`).join('\n            ')}
          </nav>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-12">
        <h2 className="text-4xl font-bold text-center mb-4">${pageConfig.heroTitle}</h2>
        <p className="text-xl text-gray-600 text-center mb-12">${pageConfig.heroSubtitle}</p>
        
        {error && <p className="text-center text-orange-600 mb-4">{error} (showing demo data)</p>}
        
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {data.map((item: any, index: number) => (
            <div key={item.id || index} className="bg-white rounded-lg shadow-md p-6 hover:shadow-lg transition cursor-pointer"
                 onClick={() => Sentry.startSpan({ op: 'ui.click', name: '${pageConfig.itemClickSpanName}' }, () => {})}>
              <div className="text-5xl mb-4">{item.${pageConfig.itemIcon} || '${pageConfig.defaultIcon}'}</div>
              <h3 className="text-xl font-semibold mb-2">{item.${pageConfig.itemTitle}}</h3>
              <p className="text-gray-600 mb-4">{item.${pageConfig.itemSubtitle}}</p>
              ${pageConfig.showPrice ? `<span className="text-2xl font-bold text-purple-600">\${item.${pageConfig.priceField}}</span>` : ''}
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
`;
    fs.writeFileSync(path.join(appPath, 'page.tsx'), homePage);

    // Generic data page that fetches details from backend API
    const secondaryConfig = this.getSecondaryPageConfig(vertical, project.project.name);
    const dataPage = `'use client';
import * as Sentry from '@sentry/nextjs';
import Link from 'next/link';
import { useState, useEffect } from 'react';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

export default function DataPage() {
  const [data, setData] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      // Do NOT wrap fetch() in a manual startSpan({ op: 'http.client' }) — SDK auto-instruments fetch.
      const response = await fetch(\`\${API_URL}/api/${secondaryConfig.endpoint}\`);
      if (response.ok) {
        const result = await response.json();
        setData(result.${secondaryConfig.dataKey} || result || []);
      } else {
        setData(${JSON.stringify(secondaryConfig.fallbackData)});
      }
    } catch (err) {
      Sentry.captureException(err);
      setData(${JSON.stringify(secondaryConfig.fallbackData)});
    } finally {
      setLoading(false);
    }
  };

  const handleAction = async (item: any) => {
    await Sentry.startSpan(
      { op: '${secondaryConfig.actionOp}', name: '${secondaryConfig.actionName}' },
      async () => {
        try {
          await fetch(\`\${API_URL}/api/${secondaryConfig.actionEndpoint}\`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ itemId: item.id })
          });
        } catch (err) {
          Sentry.captureException(err);
        }
      }
    );
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-600"></div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-50 to-blue-50">
      <header className="bg-white shadow-sm">
        <div className="max-w-7xl mx-auto px-4 py-4">
          <Link href="/" className="text-purple-600 font-medium">← Back to Home</Link>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-12">
        <h1 className="text-4xl font-bold mb-8">${secondaryConfig.pageTitle}</h1>
        
        {data.length === 0 ? (
          <div className="bg-white rounded-lg shadow-md p-12 text-center">
            <p className="text-xl text-gray-600 mb-6">No data available</p>
            <Link href="/" className="bg-purple-600 text-white px-6 py-2 rounded-lg">Go Home</Link>
          </div>
        ) : (
          <div className="space-y-4">
            {data.map((item: any, index: number) => (
              <div key={item.id || index} className="bg-white rounded-lg shadow-md p-6 flex items-center gap-6">
                <div className="text-5xl">{item.icon || item.image || '${secondaryConfig.defaultIcon}'}</div>
                <div className="flex-1">
                  <h3 className="text-lg font-semibold">{item.${secondaryConfig.titleField}}</h3>
                  <p className="text-gray-600">{item.${secondaryConfig.subtitleField}}</p>
                </div>
                <button 
                  onClick={() => handleAction(item)}
                  className="bg-purple-600 text-white px-4 py-2 rounded-lg hover:bg-purple-700"
                >
                  ${secondaryConfig.actionLabel}
                </button>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
`;
    // Create the appropriate directory based on vertical
    const secondaryDir = path.join(appPath, secondaryConfig.directory);
    if (!fs.existsSync(secondaryDir)) {
      fs.mkdirSync(secondaryDir, { recursive: true });
    }
    fs.writeFileSync(path.join(secondaryDir, 'page.tsx'), dataPage);

    // Generic action/checkout page that posts to backend API
    const actionConfig = this.getActionPageConfig(vertical);
    const checkoutPage = `'use client';
import * as Sentry from '@sentry/nextjs';
import { useState } from 'react';
import Link from 'next/link';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

export default function ActionPage() {
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    details: ''
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    
    try {
      await Sentry.startSpan(
        { op: '${actionConfig.submitOp}', name: '${actionConfig.submitSpanName}' },
        async () => {
          const response = await fetch(\`\${API_URL}/api/${actionConfig.endpoint}\`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(formData)
          });

          if (response.ok) {
            setSuccess(true);
          } else {
            throw new Error('Submission failed');
          }
        }
      );
    } catch (error) {
      Sentry.captureException(error);
      // Show success anyway for demo purposes
      setSuccess(true);
    } finally {
      setLoading(false);
    }
  };

  if (success) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-purple-50 to-blue-50">
        <div className="bg-white rounded-lg shadow-md p-12 text-center max-w-md">
          <div className="text-6xl mb-4">✅</div>
          <h1 className="text-2xl font-bold mb-4">${actionConfig.successTitle}</h1>
          <p className="text-gray-600 mb-6">${actionConfig.successMessage}</p>
          <Link href="/" className="bg-purple-600 text-white px-6 py-2 rounded-lg">Back to Home</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-50 to-blue-50">
      <header className="bg-white shadow-sm">
        <div className="max-w-7xl mx-auto px-4 py-4">
          <Link href="/" className="text-purple-600 font-medium">← Back to Home</Link>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-12">
        <h1 className="text-4xl font-bold mb-8">${actionConfig.pageTitle}</h1>
        
        <div className="bg-white rounded-lg shadow-md p-8">
          <form onSubmit={handleSubmit} className="space-y-6">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Name</label>
              <input
                type="text"
                value={formData.name}
                onChange={e => setFormData({ ...formData, name: e.target.value })}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500"
                placeholder="Your name"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Email</label>
              <input
                type="email"
                value={formData.email}
                onChange={e => setFormData({ ...formData, email: e.target.value })}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500"
                placeholder="you@example.com"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Details</label>
              <textarea
                value={formData.details}
                onChange={e => setFormData({ ...formData, details: e.target.value })}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500"
                placeholder="Additional details..."
                rows={4}
              />
            </div>
            <button 
              type="submit" 
              disabled={loading}
              className="w-full bg-purple-600 text-white py-3 rounded-lg font-medium hover:bg-purple-700 disabled:opacity-50"
            >
              {loading ? 'Processing...' : '${actionConfig.buttonText}'}
            </button>
          </form>
        </div>
      </main>
    </div>
  );
}
`;
    // Create the action page directory
    const actionDir = path.join(appPath, actionConfig.directory);
    if (!fs.existsSync(actionDir)) {
      fs.mkdirSync(actionDir, { recursive: true });
    }
    fs.writeFileSync(path.join(actionDir, 'page.tsx'), checkoutPage);

    // Product detail page with enhanced styling
    const productPage = `'use client';
import * as Sentry from '@sentry/nextjs';
import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

const products = [
  { id: '1', name: 'Premium Headphones', price: 99.99, image: '🎧', description: 'Wireless noise-cancelling headphones with premium sound quality', features: ['40-hour battery', 'Active noise cancellation', 'Premium sound drivers', 'Comfortable ear cushions'] },
  { id: '2', name: 'Smart Watch', price: 149.99, image: '⌚', description: 'Fitness tracking & notifications on your wrist', features: ['Heart rate monitor', 'GPS tracking', 'Water resistant', 'Smart notifications'] },
  { id: '3', name: 'Laptop Stand', price: 199.99, image: '💻', description: 'Ergonomic aluminum design for better posture', features: ['Adjustable height', 'Aluminum construction', 'Cable management', 'Non-slip base'] },
  { id: '4', name: 'Mechanical Keyboard', price: 129.99, image: '⌨️', description: 'RGB backlit mechanical switches for gaming', features: ['Mechanical switches', 'RGB backlighting', 'Anti-ghosting', 'Programmable keys'] },
  { id: '5', name: 'Wireless Mouse', price: 49.99, image: '🖱️', description: 'High precision optical sensor', features: ['Ergonomic design', 'Wireless connectivity', 'Long battery life', 'DPI switching'] },
  { id: '6', name: 'USB-C Hub', price: 79.99, image: '🔌', description: '7-in-1 multiport adapter', features: ['USB-C power delivery', 'HDMI output', '3x USB 3.0 ports', 'SD card reader'] },
];

export default function ProductPage({ params }: { params: { id: string } }) {
  const router = useRouter();
  const [quantity, setQuantity] = useState(1);
  const product = products.find(p => p.id === params.id);

  if (!product) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-purple-50 to-blue-50 flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-4xl font-bold text-gray-900 mb-4">Product Not Found</h1>
          <Link href="/" className="btn btn-primary">
            Back to Store
          </Link>
        </div>
      </div>
    );
  }

  const handleAddToCart = async () => {
    Sentry.startSpan({ op: 'cart.add', name: 'Add to Cart' }, async () => {
      try {
        // Simulate API call
        await new Promise(resolve => setTimeout(resolve, 500));
        alert(\`Added \${quantity} x \${product.name} to cart!\`);
        router.push('/cart');
      } catch (error) {
        Sentry.captureException(error);
        alert('Failed to add to cart');
      }
    });
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-50 to-blue-50">
      {/* Header */}
      <header className="bg-white shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <Link href="/" className="text-purple-600 hover:text-purple-700 font-medium">
            ← Back to Store
          </Link>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="grid md:grid-cols-2 gap-12">
          {/* Product Image */}
          <div className="card">
            <div className="p-12 flex items-center justify-center bg-gradient-to-br from-purple-100 to-blue-100">
              <div className="text-9xl">{product.image}</div>
            </div>
          </div>

          {/* Product Info */}
          <div>
            <h1 className="text-4xl font-bold text-gray-900 mb-4">
              {product.name}
            </h1>
            <div className="text-4xl font-bold text-purple-600 mb-6">
              \${product.price.toFixed(2)}
            </div>
            <p className="text-lg text-gray-600 mb-8">
              {product.description}
            </p>

            {/* Features */}
            <div className="mb-8">
              <h3 className="text-lg font-semibold text-gray-900 mb-4">Features:</h3>
              <ul className="space-y-2">
                {product.features.map((feature, idx) => (
                  <li key={idx} className="flex items-center text-gray-700">
                    <span className="text-purple-600 mr-2">✓</span>
                    {feature}
                  </li>
                ))}
              </ul>
            </div>

            {/* Quantity Selector */}
            <div className="mb-6">
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Quantity
              </label>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setQuantity(Math.max(1, quantity - 1))}
                  className="w-10 h-10 rounded-lg bg-gray-200 hover:bg-gray-300 flex items-center justify-center text-xl"
                >
                  −
                </button>
                <span className="text-2xl font-semibold w-16 text-center">
                  {quantity}
                </span>
                <button
                  onClick={() => setQuantity(quantity + 1)}
                  className="w-10 h-10 rounded-lg bg-purple-600 hover:bg-purple-700 text-white flex items-center justify-center text-xl"
                >
                  +
                </button>
              </div>
            </div>

            {/* Add to Cart */}
            {/* TODO: Add custom purchase options here based on your requirements
                Example: Bidding feature, installment plans, pre-orders, etc. */}
            <button 
              onClick={handleAddToCart}
              className="btn btn-primary w-full text-lg py-4 mb-4"
            >
              🛒 Add to Cart
            </button>
            
            <Link href="/" className="btn btn-secondary w-full text-center block">
              Continue Shopping
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}
`;
    // Only generate e-commerce-specific pages for e-commerce projects
    if (vertical === 'ecommerce') {
      fs.mkdirSync(path.join(appPath, 'product', '[id]'), { recursive: true });
      fs.writeFileSync(path.join(appPath, 'product', '[id]', 'page.tsx'), productPage);
    }

    // Order confirmation page with enhanced styling
    const orderPage = `'use client';
import * as Sentry from '@sentry/nextjs';
import Link from 'next/link';
import { useEffect, useState } from 'react';

export default function OrderPage({ params }: { params: { id: string } }) {
  const [orderData, setOrderData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Sentry.startSpan({ op: 'order.fetch', name: 'Fetch Order Details' }, async () => {
      try {
        const response = await fetch(\`\${process.env.NEXT_PUBLIC_API_URL}/api/order/\${params.id}\`);
        if (response.ok) {
          const data = await response.json();
          setOrderData(data);
        }
      } catch (error) {
        Sentry.captureException(error);
      } finally {
        setLoading(false);
      }
    });
  }, [params.id]);

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-purple-50 to-blue-50 flex items-center justify-center">
        <div className="text-center">
          <div className="text-6xl mb-4">⏳</div>
          <p className="text-xl text-gray-600">Loading order details...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-50 to-blue-50">
      {/* Header */}
      <header className="bg-white shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <Link href="/" className="text-purple-600 hover:text-purple-700 font-medium">
            ← Back to Store
          </Link>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        {/* Success Message */}
        <div className="text-center mb-12">
          <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-green-100 mb-6">
            <span className="text-5xl">✓</span>
          </div>
          <h1 className="text-4xl font-bold text-gray-900 mb-4">
            Order Confirmed!
          </h1>
          <p className="text-xl text-gray-600 mb-2">
            Thank you for your purchase
          </p>
          <p className="text-lg text-gray-500">
            Order #{params.id}
          </p>
        </div>

        {/* Order Details Card */}
        <div className="card mb-6">
          <div className="p-8">
            <h2 className="text-2xl font-bold text-gray-900 mb-6">Order Details</h2>
            
            {orderData ? (
              <div className="space-y-6">
                {/* Order Items */}
                <div>
                  <h3 className="text-lg font-semibold text-gray-900 mb-4">Items</h3>
                  <div className="space-y-3">
                    {orderData.items?.map((item: any, idx: number) => (
                      <div key={idx} className="flex justify-between items-center py-3 border-b last:border-0">
                        <div>
                          <p className="font-medium text-gray-900">{item.name}</p>
                          <p className="text-sm text-gray-500">Qty: {item.quantity}</p>
                        </div>
                        <p className="font-semibold text-gray-900">
                          \${(item.price * item.quantity).toFixed(2)}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Order Summary */}
                <div className="bg-gray-50 rounded-lg p-6">
                  <div className="space-y-3">
                    <div className="flex justify-between text-gray-600">
                      <span>Subtotal</span>
                      <span>\${orderData.subtotal?.toFixed(2) || '0.00'}</span>
                    </div>
                    <div className="flex justify-between text-gray-600">
                      <span>Shipping</span>
                      <span>\${orderData.shipping?.toFixed(2) || '0.00'}</span>
                    </div>
                    <div className="flex justify-between text-gray-600">
                      <span>Tax</span>
                      <span>\${orderData.tax?.toFixed(2) || '0.00'}</span>
                    </div>
                    <div className="border-t pt-3 flex justify-between text-xl font-bold">
                      <span>Total</span>
                      <span className="text-purple-600">
                        \${orderData.total?.toFixed(2) || '0.00'}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Shipping Info */}
                {orderData.shippingAddress && (
                  <div>
                    <h3 className="text-lg font-semibold text-gray-900 mb-3">Shipping Address</h3>
                    <div className="bg-gray-50 rounded-lg p-4">
                      <p className="text-gray-700">{orderData.shippingAddress.name}</p>
                      <p className="text-gray-700">{orderData.shippingAddress.address}</p>
                      <p className="text-gray-700">
                        {orderData.shippingAddress.city}, {orderData.shippingAddress.zipCode}
                      </p>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="text-center py-8">
                <p className="text-gray-600 mb-4">Order details not found</p>
                <p className="text-sm text-gray-500">
                  Your order has been processed successfully. 
                  You will receive a confirmation email shortly.
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-4">
          <Link href="/" className="btn btn-primary flex-1 text-center">
            Continue Shopping
          </Link>
          <button 
            onClick={() => window.print()} 
            className="btn btn-secondary flex-1"
          >
            Print Receipt
          </button>
        </div>
      </main>
    </div>
  );
}
`;
    if (vertical === 'ecommerce') {
      fs.mkdirSync(path.join(appPath, 'order', '[id]'), { recursive: true });
      fs.writeFileSync(path.join(appPath, 'order', '[id]', 'page.tsx'), orderPage);
    }

    // Layout
    const layout = `import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: '${project.project.name}',
  description: 'Reference app with Sentry instrumentation',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
`;
    fs.writeFileSync(path.join(appPath, 'layout.tsx'), layout);

    // Globals CSS with custom styles
    const globalsCss = `@tailwind base;
@tailwind components;
@tailwind utilities;

@layer base {
  body {
    @apply bg-gray-50 text-gray-900;
  }
  
  h1 {
    @apply text-3xl font-bold;
  }
  
  h2 {
    @apply text-2xl font-semibold;
  }
  
  h3 {
    @apply text-xl font-medium;
  }
}

@layer components {
  .btn {
    @apply px-4 py-2 rounded-lg font-medium transition-all duration-200;
  }
  
  .btn-primary {
    @apply bg-purple-600 text-white hover:bg-purple-700 shadow-md hover:shadow-lg;
  }
  
  .btn-secondary {
    @apply bg-gray-200 text-gray-800 hover:bg-gray-300;
  }
  
  .card {
    @apply bg-white rounded-lg shadow-md hover:shadow-lg transition-shadow duration-200 overflow-hidden;
  }
  
  .input {
    @apply w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent;
  }
}
`;
    fs.writeFileSync(path.join(appPath, 'globals.css'), globalsCss);
  }

  private generateFrontendInstrumentation(frontendPath: string, project: EngagementSpec): void {
    // For web projects, include ALL spans (not just frontend-layer ones).
    // Backend spans are triggered by frontend form submissions/API calls, so the
    // frontend instrumentation wraps those calls to propagate distributed tracing context.
    // Deduplicate by span name — duplicate names cause duplicate function declarations
    // which are TypeScript errors and break the instrumentation file.
    const seen = new Set<string>();
    const spans = project.instrumentation.spans.filter(s => {
      if (seen.has(s.name)) return false;
      seen.add(s.name);
      return true;
    });

    const rules = this.rulesBank?.listRules() || [];
    const needsHttpStatus = rules.some(r => r.category === 'attribute_completeness' && r.rule.includes('http.status_code'))
      || true; // always enforce — http.status_code is required by Sentry conventions
    const needsDbAttrs = rules.some(r => r.category === 'attribute_completeness' && r.rule.includes('db.system'))
      || true; // always enforce

    const rulesComment = rules.length > 0
      ? `// Applied training rules (${rules.length}):\n${rules.map(r => `//   [${r.category}] ${r.title}`).join('\n')}\n`
      : '// No training rules yet — run training to improve instrumentation quality\n';

    // Per-op required attributes enforced in every wrapper
    const opAttrs = (op: string, spanName: string): string => {
      if ((op === 'http.client' || op === 'http.server') && needsHttpStatus) {
        return `  // Required by Sentry conventions — pass statusCode in attributes when calling this function\n  if (attributes['http.status_code'] === undefined && attributes['statusCode'] !== undefined) {\n    attributes['http.status_code'] = attributes['statusCode'];\n  }`;
      }
      if (op.startsWith('db') && needsDbAttrs) {
        return `  // Required by Sentry conventions — pass db.system, db.statement in attributes\n  if (!attributes['db.system']) attributes['db.system'] = 'unknown';`;
      }
      return '';
    };

    const instrumentationFile = `import * as Sentry from '@sentry/nextjs';

// Custom instrumentation generated from your engagement spec
// These spans have been designed based on your project requirements
// Call these functions to track key operations in your application
${rulesComment}
${spans.map(span => {
  const attrSetup = opAttrs(span.op, span.name);
  return `
export function trace_${span.name.replace(/\./g, '_')}(
  callback: () => Promise<any>,
  attributes: Record<string, any> = {}
) {
${attrSetup ? attrSetup + '\n' : ''}  return Sentry.startSpan(
    {
      op: '${span.op}',
      name: '${span.name}',
      attributes: filterPII(attributes, ${JSON.stringify(span.pii.keys)})
    },
    async (span) => {
      try {
        const result = await callback();
        span.setAttributes({ success: true });
        return result;
      } catch (err: any) {
        span.setAttributes({ success: false, error_message: err.message || String(err) });
        throw err;
      }
    }
  );
}`;
}).join('\n')}

function filterPII(attributes: Record<string, any>, piiKeys: string[]): Record<string, any> {
  const filtered = { ...attributes };
  piiKeys.forEach(key => {
    if (filtered[key]) {
      filtered[key] = '[REDACTED]';
    }
  });
  return filtered;
}
`;

    fs.writeFileSync(path.join(frontendPath, 'lib', 'instrumentation.ts'), instrumentationFile);
  }

  private generateBackendServer(backendPath: string, project: EngagementSpec): void {
    const serverFile = `require('dotenv').config();
// Import Sentry first to ensure instrumentation
const Sentry = require('../sentry.config');
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3001;

// CORS and JSON parsing
app.use(cors({
  origin: ['http://localhost:3000', 'http://localhost:3001'],
  credentials: true,
  // Allow Sentry distributed tracing headers so frontend→backend traces connect
  allowedHeaders: ['Content-Type', 'Authorization', 'sentry-trace', 'baggage'],
}));
app.use(express.json());

// Health check endpoint (for live data generator)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: '${project.project.name}-backend' });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({ message: 'Welcome to ${project.project.name} API', status: 'healthy' });
});

// Routes — mount without /api prefix so Sentry sees full path (e.g. GET /api/checkout/validate-cart)
app.use(require('./routes/api'));

// Sentry error handler must come before other error handlers
Sentry.setupExpressErrorHandler(app);

// Generic error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

const server = app.listen(PORT, () => {
  console.log(\`Backend running on port \${PORT}\`);
});

// Graceful shutdown — flush Sentry before exiting so no spans are lost
// The training runner sends SIGTERM to stop the server; without this flush,
// any spans still buffered in the Sentry SDK are silently dropped.
async function shutdown() {
  server.close();
  await Sentry.flush(3000).catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Ensure TypeScript treats this file as a module (not a global script)
// Without this, tsc sees multiple files with const Sentry = require(...) as duplicate declarations
export {};
`;
    fs.writeFileSync(path.join(backendPath, 'src', 'index.ts'), serverFile);

    // .env.example
    const envExample = `SENTRY_DSN=your_sentry_dsn_here
SENTRY_ENVIRONMENT=development
PORT=3001
`;
    fs.writeFileSync(path.join(backendPath, '.env.example'), envExample);
  }

  private async generateBackendRoutesWithLLM(backendPath: string, project: EngagementSpec): Promise<void> {
    console.log('🤖 Using LLM to generate Express routes with instrumentation...');

    try {
      console.log('📝 Generating routes with LLM...');
      let { code } = await this.llm.generateExpressRoutes(project);
      console.log('✅ LLM generated Express routes');

      // Sanitize unquoted dot-notation object keys (e.g. { http.method: value } → { 'http.method': value })
      // These are valid OTel semantic convention attribute names but invalid as unquoted JS keys.
      code = code.replace(/([{,]\s*)([a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)+)\s*:/g, "$1'$2':");

      // Validate: ensure every route handler uses Sentry.continueTrace to attach BE spans to the FE trace.
      if (!code.includes('continueTrace')) {
        console.warn('⚠️  LLM routes missing Sentry.continueTrace — falling back to templates to guarantee FE→BE trace attachment');
        this.generateBackendRoutes(backendPath, project);
        return;
      }

      // Validate: detect duplicate method+path registrations.
      // In Express, only the first handler for a given method+path ever fires — duplicates silently discard spans.
      const routeMatches = [...code.matchAll(/router\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/gi)];
      const seen = new Set<string>();
      const duplicates: string[] = [];
      for (const m of routeMatches) {
        const key = `${m[1].toUpperCase()} ${m[2]}`;
        if (seen.has(key)) duplicates.push(key);
        else seen.add(key);
      }
      if (duplicates.length > 0) {
        console.warn(`⚠️  LLM generated duplicate route handlers (only first fires): ${duplicates.join(', ')}`);
        console.warn('⚠️  Falling back to template routes to guarantee every span gets its own route...');
        this.generateBackendRoutes(backendPath, project);
        return;
      }

      // Validate: detect routes mounted via app.use('/prefix', router) pattern.
      // This causes Sentry to name transactions as "METHOD /prefix" instead of the full path.
      // The server already does app.use(require('./routes/api')) with no prefix, so routes must use full paths.
      const subRouterMount = code.match(/app\.use\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*\w*[Rr]outer/);
      if (subRouterMount) {
        console.warn(`⚠️  LLM used app.use('${subRouterMount[1]}', router) — Sentry would name transactions "METHOD ${subRouterMount[1]}" not full path. Falling back to templates.`);
        this.generateBackendRoutes(backendPath, project);
        return;
      }

      // Validate: all custom span names have a matching route in the generated code
      const specSpanNames = project.instrumentation.spans.map(s => s.name);
      const missingSpanRoutes = specSpanNames.filter(name => {
        const fnName = `trace_${name.replace(/\./g, '_')}`;
        return !code.includes(fnName);
      });
      if (missingSpanRoutes.length > 0) {
        console.warn(`⚠️  LLM routes missing instrumentation for spans: ${missingSpanRoutes.join(', ')}. Falling back to templates.`);
        this.generateBackendRoutes(backendPath, project);
        return;
      }

      // Validate: detect routes registered at bare "/" path.
      // When the LLM generates router.get('/', ...) or router.post('/', ...), Sentry captures
      // the transaction name as "METHOD /" because the route path has no specificity.
      // Count routes at "/" vs routes with real paths — if most are at "/", fall back.
      const allRouteMatches = [...code.matchAll(/router\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/gi)];
      const rootRoutes = allRouteMatches.filter(m => m[2] === '/' || m[2] === '');
      if (allRouteMatches.length > 0 && rootRoutes.length / allRouteMatches.length > 0.4) {
        console.warn(`⚠️  LLM generated ${rootRoutes.length}/${allRouteMatches.length} routes at path "/" — Sentry would show "METHOD /". Falling back to templates.`);
        this.generateBackendRoutes(backendPath, project);
        return;
      }

      // Write routes file
      const routesFilePath = path.join(backendPath, 'src', 'routes', 'api.ts');
      fs.writeFileSync(routesFilePath, code);

      // NOTE: Instrumentation injection deferred — runs after static topology validation.
      // See injectAllInstrumentation().

    } catch (error) {
      console.error('❌ Failed to generate routes with LLM:', error);
      console.log('⚠️  Falling back to template routes...');
      // Fallback to old method if LLM fails
      this.generateBackendRoutes(backendPath, project);
    }
  }

  /**
   * Enhance the template-generated route stubs with domain-specific mock data.
   * The template structure (paths, continueTrace, span wrappers) is NEVER modified —
   * only the inner stub return value is replaced with realistic data.
   * This is a small focused LLM task that any model can do reliably.
   */
  private async enhanceRouteStubsWithLLM(backendPath: string, project: EngagementSpec): Promise<void> {
    const routesPath = path.join(backendPath, 'src', 'routes', 'api.ts');
    if (!fs.existsSync(routesPath)) return;

    try {
      const stubs = await this.llm.generateRouteStubs(project);
      if (!stubs || stubs.length === 0) return;

      let code = fs.readFileSync(routesPath, 'utf-8');
      let changed = false;

      for (const stub of stubs) {
        const spanName = stub.spanName.replace(/\./g, '_');
        // Replace the generic placeholder inside the trace wrapper callback
        const placeholderRe = new RegExp(
          `(trace_${spanName}\\s*\\(\\s*async\\s*\\(\\s*\\)\\s*=>\\s*\\{[^}]*?)return\\s*\\{[^}]*?operation:\\s*'${stub.spanName.replace(/\./g, '\\.')}'[^}]*?\\}`,
          'g'
        );
        const replacement = `$1return ${JSON.stringify(stub.mockResponse, null, 8).replace(/\n/g, '\n          ')}`;
        const updated = code.replace(placeholderRe, replacement);
        if (updated !== code) {
          code = updated;
          changed = true;
        }
      }

      if (changed) {
        fs.writeFileSync(routesPath, code);
        console.log(`✅ Enhanced ${stubs.length} route stub(s) with domain-specific mock data`);
      }
    } catch (err) {
      // Non-fatal — template stubs work fine, this is cosmetic only
      console.warn('⚠️  Route stub enhancement failed (non-fatal):', err);
    }
  }

  private generateBackendRoutes(backendPath: string, project: EngagementSpec, routeContract?: RouteContract): void {
    // Use ALL spans when a route contract is available — the frontend calls every span,
    // not just backend-layer ones. Without this, frontend-layer spans produce 404s.
    const allSpans = project.instrumentation.spans;
    const backendSpans = routeContract ? allSpans : allSpans.filter(s => s.layer === 'backend');

    // Build import list from actual spans
    const spanFnNames = allSpans.map(s => `trace_${s.name.replace(/\./g, '_')}`);
    const importsLine = spanFnNames.length > 0
      ? `const { ${spanFnNames.join(', ')} } = require('../utils/instrumentation');`
      : `// No backend spans defined — add instrumentation below`;

    // Generate one route per span — when a route contract is available, use exact contract paths.
    // Otherwise derive from span.name to guarantee each span gets its own route.
    const spanRoutes = backendSpans.map(span => {
      const fnName = `trace_${span.name.replace(/\./g, '_')}`;
      // Use span.name to build a unique, hierarchical route path, e.g.:
      //   product.fetch_details → /product/fetch-details
      //   checkout.init         → /checkout/init
      // Use exact path from route contract when available — guarantees FE/BE agreement.
      const contractRoute = routeContract?.routes.find(r => r.spanName === span.name);
      const nameParts = span.name.split('.');
      const routePath = contractRoute
        ? contractRoute.path
        : nameParts.length === 1
        ? `/api/${nameParts[0].replace(/_/g, '-')}`
        : `/api/${nameParts[0]}/${nameParts.slice(1).join('/').replace(/_/g, '-')}`;
      const contractMethod = contractRoute?.method.toLowerCase();
      const attrEntries = Object.keys(span.attributes)
        .map(k => {
          // Quote keys with dots (OTel conventions like 'http.method') — unquoted are JS syntax errors
          const quotedKey = k.includes('.') ? `'${k}'` : k;
          return `      ${quotedKey}: req.body.${k.replace(/\./g, '_')} || req.query.${k.replace(/\./g, '_')} || null`;
        })
        .join(',\n');
      const attrObj = attrEntries ? `{\n${attrEntries}\n    }` : '{}';
      // Use contract method when available; otherwise derive from span name keywords.
      const isGet = ['fetch', 'load', 'get', 'list', 'read', 'query', 'search', 'filter', 'view', 'show', 'detail', 'retrieve'].some(
        v => span.name.toLowerCase().includes(v)
      );
      const method = contractMethod || (isGet ? 'get' : 'post');

      // For read-type spans, also generate a RESTful GET /namespace alias so the frontend's
      // natural REST calls (e.g. GET /api/products) are handled in addition to the
      // span-specific path (e.g. GET /products/retrieve-product).
      const namespace = nameParts[0].replace(/_/g, '-');
      const aliasRoute = isGet && nameParts.length > 1
        ? `
// RESTful alias — frontend calls GET /api/${namespace} directly
router.get('/api/${namespace}', async (req, res) => {
  try {
    const result = await ${fnName}(async () => {
      await new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * 300) + 50));
      return { id: Date.now(), status: 'ok', operation: '${span.name}' };
    }, ${attrObj});
    res.json({ success: true, ...(result as Record<string, unknown>) });
  } catch (error) {
    Sentry.captureException(error);
    res.status(500).json({ error: '${span.name} failed' });
  }
});`
        : '';

      return `
router.${method}('${routePath}', async (req, res) => {
  // continueTrace propagates the sentry-trace + baggage headers from the FE request,
  // ensuring this backend span is attached to the frontend trace (not orphaned).
  return Sentry.continueTrace(
    { sentryTrace: req.headers['sentry-trace'], baggage: req.headers['baggage'] },
    async () => {
      try {
        const result = await ${fnName}(async () => {
          // ${span.description || `Handles ${span.name}`}
          await new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * 300) + 50));
          return { id: Date.now(), status: 'ok', operation: '${span.name}' };
        }, {
          ...${attrObj},
          'http.status_code': 200,
          'server.address': req.hostname || 'localhost',
          'http.method': req.method,
          'http.route': '${routePath}',
        });
        res.json({ success: true, ...(result as Record<string, unknown>) });
      } catch (error) {
        Sentry.captureException(error);
        res.status(500).json({ error: '${span.name} failed' });
      }
    }
  );
});${aliasRoute}`;
    }).join('\n');

    const routesFile = `const express = require('express');
const router = express.Router();
const Sentry = require('@sentry/node');
${importsLine}

// Routes generated from instrumentation spec for: ${project.project.name}
// TODO: Replace the stub implementations below with real business logic
${spanRoutes || `
router.get('/status', (req, res) => {
  res.json({ status: 'ok', project: '${project.project.name}' });
});`}

module.exports = router;

// Ensure TypeScript treats this file as a module (not a global script)
export {};
`;
    fs.writeFileSync(path.join(backendPath, 'src', 'routes', 'api.ts'), routesFile);

    // Normalise trace function names in api.ts against actual instrumentation exports.
    // The LLM sometimes uses frontend span naming conventions in backend routes
    // (e.g. trace_signup_submit_form instead of trace_backend_submit_form).
    // This deterministic pass fixes the mismatch before the TypeScript build runs.
    const instrumentationPath = path.join(backendPath, 'src', 'instrumentation.ts');
    const apiPath = path.join(backendPath, 'src', 'routes', 'api.ts');
    if (fs.existsSync(instrumentationPath)) {
      const renames = normaliseTraceFunctionNames(apiPath, instrumentationPath);
      if (renames.length > 0) {
        console.log(`[generator] Normalised ${renames.length} trace function name(s) in api.ts`);
      }
    }
  }

  private generateBackendInstrumentation(backendPath: string, project: EngagementSpec): void {
    const backendSpans = project.instrumentation.spans.filter(s => s.layer === 'backend');
    // Also include frontend spans so backend routes (derived from frontend span names) can import them
    const frontendSpans = project.instrumentation.spans.filter(s => s.layer === 'frontend');
    const allSpans = [...backendSpans, ...frontendSpans];

    const rules = this.rulesBank?.listRules() || [];
    const rulesComment = rules.length > 0
      ? `// Applied training rules (${rules.length}):\n${rules.map(r => `//   [${r.category}] ${r.title}`).join('\n')}\n`
      : '// No training rules yet — run training to improve instrumentation quality\n';

    const opAttrs = (op: string): string => {
      if (op === 'http.server') {
        return `  // Enforce http.status_code — required by Sentry conventions\n  if (attributes['http.status_code'] === undefined && attributes['statusCode'] !== undefined) {\n    attributes['http.status_code'] = attributes['statusCode'];\n  }`;
      }
      if (op.startsWith('db')) {
        return `  // Enforce db.system — required by Sentry DB conventions\n  if (!attributes['db.system']) attributes['db.system'] = 'sqlite';`;
      }
      return '';
    };

    const instrumentationFile = `const Sentry = require('@sentry/node');

// Custom instrumentation generated from your engagement spec
// These spans have been designed based on your project requirements
// Call these functions to track key operations in your application
${rulesComment}
${allSpans.map(span => {
  const attrSetup = opAttrs(span.op);
  return `
module.exports.trace_${span.name.replace(/\./g, '_')} = function(
  callback,
  attributes = {}
) {
${attrSetup ? attrSetup + '\n' : ''}  return Sentry.startSpan(
    {
      op: '${span.op}',
      name: '${span.name}',
      attributes: filterPII(attributes, ${JSON.stringify(span.pii.keys)})
    },
    async (span) => {
      try {
        const result = await callback(span);
        span.setAttributes({ success: true });
        return result;
      } catch (err) {
        span.setAttributes({ success: false, error_message: err.message || String(err) });
        throw err;
      }
    }
  );
};`;
}).join('\n')}

function filterPII(attributes, piiKeys) {
  const filtered = { ...attributes };
  piiKeys.forEach(key => {
    if (filtered[key]) {
      filtered[key] = '[REDACTED]';
    }
  });
  return filtered;
}

// Ensure TypeScript treats this file as a module (not a global script)
export {};
`;

    fs.writeFileSync(path.join(backendPath, 'src', 'utils', 'instrumentation.ts'), instrumentationFile);
  }

  /**
   * Walk all frontend pages and backend routes, inject instrumentation into each,
   * and run correctness assertions. Called once after static topology validation
   * and the repair loop, so the validator saw clean marker-level code.
   */
  private injectAllInstrumentation(
    appPath: string,
    project: EngagementSpec,
    onOutput?: (msg: string) => void
  ): void {
    const isPython = project.stack.backend === 'flask' || project.stack.backend === 'fastapi';
    const frontendPath = path.join(appPath, 'frontend');
    const backendPath  = isPython ? appPath : path.join(appPath, 'backend');

    // ── Frontend pages ────────────────────────────────────────────────────
    const feInstrPath = path.join(frontendPath, 'lib', 'instrumentation.ts');
    if (!isPython && fs.existsSync(feInstrPath)) {
      const appDir = path.join(frontendPath, 'app');
      const pageFiles: string[] = [];
      const walk = (dir: string) => {
        if (!fs.existsSync(dir)) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.next') walk(full);
          else if (entry.isFile() && /\.(tsx|ts)$/.test(entry.name)) pageFiles.push(full);
        }
      };
      walk(appDir);

      let injected = 0;
      for (const pageFile of pageFiles) {
        try {
          const result = injectInstrumentation(pageFile, feInstrPath);
          if (result.injected) injected++;

          const violations = assertInjectionCorrectness(pageFile);
          if (violations.length > 0) {
            onOutput?.(`   ⚠ Injection violations in ${path.basename(pageFile)}: ${violations.join('; ')}\n`);
          }
          const invented = assertNoInventedTraceFunctions(pageFile, feInstrPath);
          if (invented.length > 0) {
            onOutput?.(`   ⚠ Invented trace functions in ${path.basename(pageFile)}: ${invented.join(', ')}\n`);
          }
        } catch (err: any) {
          onOutput?.(`   ⚠ Injection skipped for ${path.basename(pageFile)}: ${err?.message}\n`);
        }
      }
      onOutput?.(`   ✓ Frontend: injected into ${injected}/${pageFiles.length} page file(s)\n`);
    }

    // ── Backend routes ────────────────────────────────────────────────────
    const beInstrPath = path.join(backendPath, 'src', 'utils', 'instrumentation.ts');
    const routesFile  = path.join(backendPath, 'src', 'routes', 'api.ts');
    if (!isPython && fs.existsSync(routesFile) && fs.existsSync(beInstrPath)) {
      try {
        const result = injectInstrumentation(routesFile, beInstrPath);
        if (result.injected) {
          onOutput?.('   ✓ Backend: instrumentation injected into api.ts\n');
        }
        const violations = assertInjectionCorrectness(routesFile);
        if (violations.length > 0) {
          onOutput?.(`   ⚠ Injection violations in api.ts: ${violations.join('; ')}\n`);
        }
      } catch (err: any) {
        onOutput?.(`   ⚠ Backend injection skipped: ${err?.message}\n`);
      }
    }
  }

  private generateConfigFiles(appPath: string, project: EngagementSpec): void {
    // Docker compose
    const dockerCompose = `version: '3.8'

services:
  frontend:
    build:
      context: ./frontend
      dockerfile: Dockerfile
    ports:
      - "3000:3000"
    environment:
      - NEXT_PUBLIC_API_URL=http://backend:3001
      - NEXT_PUBLIC_SENTRY_DSN=\${SENTRY_DSN}
    depends_on:
      - backend

  backend:
    build:
      context: ./backend
      dockerfile: Dockerfile
    ports:
      - "3001:3001"
    environment:
      - SENTRY_DSN=\${SENTRY_DSN}
      - PORT=3001
`;
    fs.writeFileSync(path.join(appPath, 'docker-compose.yml'), dockerCompose);

    // README
    const readme = `# ${project.project.name}

Reference application with Sentry instrumentation.

${project.project.notes ? `## Project Requirements

${project.project.notes}

**⚠️ Important:** This is a template starting point. The generated code provides a basic e-commerce structure with Sentry instrumentation. You'll need to customize the application logic to fully implement the requirements above. The custom spans and instrumentation have been designed to track your specific use case.

` : ''}## Setup

1. Install dependencies:
\`\`\`bash
cd frontend && npm install
cd ../backend && npm install
\`\`\`

2. Configure environment variables:
\`\`\`bash
cp backend/.env.example backend/.env
# Add your Sentry DSN to backend/.env
\`\`\`

3. Run the application:
\`\`\`bash
# Terminal 1 - Backend
cd backend
npm run dev

# Terminal 2 - Frontend
cd frontend
npm run dev
\`\`\`

4. Open http://localhost:3000

## Instrumentation

This app includes custom Sentry instrumentation:
- ${project.instrumentation.spans.length} custom spans
- ${project.instrumentation.transactions.length} transactions

See IMPLEMENTATION_GUIDE.md for details.
`;
    fs.writeFileSync(path.join(appPath, 'README.md'), readme);
  }

  private generateUserFlows(outputPath: string, project: EngagementSpec): void {
    const flowsPath = path.join(outputPath, 'user-flows.json');
    const appPath = path.join(outputPath, 'reference-app');

    // Scan actual generated page routes from the filesystem
    const pageRoutes = this.scanGeneratedPageRoutes(appPath, project);

    const flows = this.buildSpanDrivenFlows(project, pageRoutes);

    fs.writeFileSync(flowsPath, JSON.stringify(flows, null, 2));
  }

  /**
   * Scan the generated Next.js app directory to find all page routes.
   */
  private scanGeneratedPageRoutes(appPath: string, project: EngagementSpec): string[] {
    const routes: string[] = [];

    if (project.stack.type === 'backend-only') return routes;

    const pagesDir = path.join(appPath, 'frontend', 'app');
    if (!fs.existsSync(pagesDir)) return routes;

    const scanDir = (dir: string, prefix: string) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        // Skip Next.js internals and non-route directories
        if (entry.name.startsWith('_') || entry.name.startsWith('.') ||
            ['globals.css', 'layout.tsx', 'loading.tsx', 'error.tsx', 'not-found.tsx'].includes(entry.name)) {
          continue;
        }
        if (entry.isDirectory()) {
          // Dynamic route segments like [id] — skip for simplicity
          if (entry.name.startsWith('[')) continue;
          const subDir = path.join(dir, entry.name);
          const pageFile = path.join(subDir, 'page.tsx');
          if (fs.existsSync(pageFile)) {
            routes.push(`${prefix}/${entry.name}`);
          }
          scanDir(subDir, `${prefix}/${entry.name}`);
        } else if (entry.name === 'page.tsx' && prefix === '') {
          routes.unshift('/'); // home page first
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

  /**
   * Build user flows driven by the project's instrumentation spans and actual page routes.
   * Each frontend span becomes a distinct flow that navigates to the relevant page and
   * interacts with the form/UI element that triggers that span.
   */
  private buildSpanDrivenFlows(project: EngagementSpec, pageRoutes: string[]): any[] {
    const isBackendOnly = project.stack.type === 'backend-only';
    const frontendSpans = project.instrumentation.spans.filter(s => s.layer === 'frontend');
    const backendSpans = project.instrumentation.spans.filter(s => s.layer === 'backend');

    const flows: any[] = [];

    if (isBackendOnly) {
      // For backend-only, generate one flow per backend span
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
      // One flow per span — use frontend spans when available, otherwise use backend spans
      // (backend spans on a web project are triggered by frontend form actions)
      const spansToUse = frontendSpans.length > 0 ? frontendSpans : backendSpans.slice(0, 5);
      for (const span of spansToUse) {
        const route = this.deriveRouteFromSpan(span.name, span.op, pageRoutes);
        const steps: any[] = [
          { action: 'navigate', url: route, description: `Navigate to ${route}` },
          { action: 'wait', duration: 1500 }
        ];

        // Determine if this span is triggered by a form submission
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
      // No frontend spans defined — generate a browse flow per page
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

    // Error scenario on the most relevant page
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

  /**
   * Derive a page route from a span's name and op, cross-referenced against known page routes.
   */
  private deriveRouteFromSpan(spanName: string, op: string, knownRoutes: string[]): string {
    const keyword = op.toLowerCase().replace(/[^a-z0-9]/g, '');
    const nameParts = spanName.toLowerCase().split('.');

    // Common keyword → route mappings.
    // IMPORTANT: signup/register map to their own dedicated routes, NOT to '/'.
    // Only map to '/' when there is genuinely no better route (e.g. generic home/dashboard).
    const keywordRoutes: Record<string, string> = {
      login: '/login', signin: '/login', auth: '/login',
      logout: '/logout', signout: '/logout',
      signup: '/signup', register: '/register', registration: '/register',
      confirm: '/confirm', verify: '/confirm', verification: '/confirm',
      reset: '/password-reset', forgot: '/forgot-password',
      checkout: '/checkout', payment: '/checkout', pay: '/checkout',
      cart: '/cart',
      products: '/products', product: '/products', catalog: '/products',
      search: '/search',
      dashboard: '/dashboard', home: '/',
      profile: '/profile', account: '/profile',
      settings: '/settings',
      upload: '/upload',
      submit: '/submit', form: '/submit',
    };

    // Collect all words from the span name (split on . and _)
    const allWords = spanName.toLowerCase().split(/[._]/).map(w => w.replace(/[^a-z0-9]/g, '')).filter(Boolean);

    // 1. Try op keyword against known routes
    if (keywordRoutes[keyword]) {
      const candidate = keywordRoutes[keyword];
      if (knownRoutes.length === 0 || knownRoutes.includes(candidate)) return candidate;
    }

    // 2. For each word in the span name (reversed = most specific first):
    for (const word of [...allWords].reverse()) {
      // a. Exact keyword → route mapping, validate against known routes
      if (keywordRoutes[word]) {
        const candidate = keywordRoutes[word];
        if (knownRoutes.length === 0 || knownRoutes.includes(candidate)) return candidate;
      }
      // b. Known route whose path segment exactly matches this word
      const exactMatch = knownRoutes.find(r => r.replace(/^\//, '').replace(/-/g, '') === word);
      if (exactMatch) return exactMatch;
    }

    // 3. Partial match: a known route whose segment appears in the span name words
    for (const route of knownRoutes) {
      const seg = route.replace(/^\//, '').replace(/-/g, '').toLowerCase();
      if (seg && seg !== '' && allWords.some(w => w.includes(seg) || seg.includes(w))) {
        return route;
      }
    }

    // 4. Prefer any non-root known route over '/' when nothing matched
    const nonRoot = knownRoutes.find(r => r !== '/');
    if (nonRoot) return nonRoot;

    // Default to home
    return '/';
  }

  /**
   * Build form-filling steps based on the span's PII keys and attributes.
   */
  private buildFormSteps(span: { attributes: Record<string, string>; pii: { keys: string[] }; op: string; name: string }): any[] {
    const steps: any[] = [];
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

    // Submit the form
    steps.push({
      action: 'submit',
      selector: 'button[type="submit"], form button:last-of-type',
      description: 'Submit form'
    });
    steps.push({ action: 'wait', duration: 2000 });
    return steps;
  }

  /** Convert dot-notation span name to a human-readable flow name. */
  private humanizeName(spanName: string): string {
    return spanName.split('.').map(p =>
      p.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
    ).join(' ');
  }

  private buildImplementationGuide(project: EngagementSpec): string {
    return `# Implementation Guide: ${project.project.name}

## Overview

This guide explains the Sentry instrumentation implemented in this reference application.

**Project:** ${project.project.name}  
**Vertical:** ${project.project.vertical}  
**Stack:** Next.js (Frontend) + Express (Backend)

${project.project.notes ? `## Requirements

${project.project.notes}

**Note:** The generated reference app provides a basic e-commerce template. You should customize the code to implement the specific requirements above. The custom Sentry instrumentation has been tailored to track the operations relevant to your use case.

` : ''}## Instrumentation Plan

### Transactions

${project.instrumentation.transactions.map(t => `- \`${t}\``).join('\n')}

### Custom Spans

${project.instrumentation.spans.map(span => `
#### ${span.name} (${span.layer})

**Operation:** \`${span.op}\`  
**Description:** ${span.description || 'N/A'}

**Attributes:**
${Object.entries(span.attributes).map(([key, desc]) => `- \`${key}\`: ${desc}`).join('\n')}

${span.pii.keys.length > 0 ? `**PII Keys (Redacted):** ${span.pii.keys.map(k => `\`${k}\``).join(', ')}` : ''}
`).join('\n')}

## Files Modified

### Frontend

- \`frontend/lib/instrumentation.ts\` - Custom instrumentation helpers
- \`frontend/app/checkout/page.tsx\` - Checkout flow with tracing

### Backend

- \`backend/src/utils/instrumentation.ts\` - Custom span helpers
- \`backend/src/routes/api.ts\` - API endpoints with instrumentation

## Validation in Sentry

1. **Performance Tab**
   - View transactions: ${project.instrumentation.transactions.join(', ')}
   - Check span waterfall for custom operations

2. **Search by Span**
   - Use query: \`span.op:[${project.instrumentation.spans.map(s => s.op).join(',')}]\`

3. **Dashboard**
   - Import \`sentry-dashboard.json\` to visualize key metrics

## PII Handling

The following attributes are automatically redacted:
${[...new Set(project.instrumentation.spans.flatMap(s => s.pii.keys))].map(k => `- \`${k}\``).join('\n') || '- None'}

## Generating Test Data

A Python script (generate_data.py) has been included to populate your Sentry dashboard with realistic test data.

### Setup

1. Install Python dependencies:
\\\`\\\`\\\`bash
pip install -r requirements.txt
\\\`\\\`\\\`

2. Configure your Sentry DSNs:
\\\`\\\`\\\`bash
cp .env.example .env
# Edit .env and add your DSNs
\\\`\\\`\\\`

3. Run the data generator:
\\\`\\\`\\\`bash
python generate_data.py
\\\`\\\`\\\`

### What It Generates

The script creates realistic test data including:
- **Custom spans** from your instrumentation plan
- **Realistic attributes** based on your schema
- **PII handling** - automatically redacts sensitive data
- **Variety of outcomes** - success, errors, slow requests
- **Both layers** - frontend and backend data

### Configuration

Edit .env to customize:
- NUM_TRACES - Number of traces to generate (default: 100)
- NUM_ERRORS - Number of errors to generate (default: 20)
- SENTRY_DSN_FRONTEND - Frontend project DSN
- SENTRY_DSN_BACKEND - Backend project DSN

## Next Steps

1. Add your Sentry DSN to environment variables
2. Run the data generation script to populate your dashboard
3. Import the dashboard JSON to Sentry
4. Customize spans and attributes for your use case
`;
  }

  private buildDashboard(project: EngagementSpec): any {
    const widgets: any[] = [];

    // ── Row 0: KPI big-numbers (y=0, h=1) ──────────────────────────────────
    widgets.push({
      title: 'Total Transactions',
      description: 'Total transaction count',
      displayType: 'big_number',
      widgetType: 'spans',
      interval: '1h',
      queries: [{
        aggregates: ['count(span.duration)'],
        columns: [],
        conditions: 'is_transaction:1',
        name: '',
        orderby: '',
        fields: ['count(span.duration)']
      }],
      layout: { x: 0, y: 0, w: 2, h: 1, minH: 1 }
    });

    widgets.push({
      title: 'P95 Latency',
      description: 'P95 transaction response time',
      displayType: 'big_number',
      widgetType: 'spans',
      interval: '1h',
      queries: [{
        aggregates: ['p95(span.duration)'],
        columns: [],
        conditions: 'is_transaction:1',
        name: '',
        orderby: '',
        fields: ['p95(span.duration)']
      }],
      layout: { x: 2, y: 0, w: 2, h: 1, minH: 1 }
    });

    widgets.push({
      title: 'Error Count',
      description: 'Total errors captured',
      displayType: 'big_number',
      widgetType: 'error-events',
      interval: '1h',
      queries: [{
        aggregates: ['count()'],
        columns: [],
        conditions: '',
        name: '',
        orderby: '',
        fields: ['count()']
      }],
      layout: { x: 4, y: 0, w: 2, h: 1, minH: 1 }
    });

    // ── Row 1-2: Transaction volume + error rate (y=1, h=2) ─────────────────
    widgets.push({
      title: 'Transaction Volume',
      description: 'Transaction count over time',
      displayType: 'area',
      widgetType: 'spans',
      interval: '1h',
      queries: [{
        aggregates: ['count(span.duration)'],
        columns: ['transaction'],
        conditions: 'is_transaction:1',
        name: '',
        orderby: '-count(span.duration)',
        fields: ['transaction', 'count(span.duration)']
      }],
      layout: { x: 0, y: 1, w: 4, h: 2, minH: 2 }
    });

    widgets.push({
      title: 'Error Rate',
      description: 'Errors over time',
      displayType: 'area',
      widgetType: 'error-events',
      interval: '1h',
      queries: [{
        aggregates: ['count()'],
        columns: ['issue', 'title'],
        conditions: '',
        name: '',
        orderby: '-count()',
        fields: ['issue', 'title', 'count()']
      }],
      layout: { x: 4, y: 1, w: 2, h: 2, minH: 2 }
    });

    // ── Rows 3+: Per-op count + per-op P95 latency pairs ────────────────────
    // Deduplicate ops and generate two widgets per op: count (area) + P95 (line)
    const ops = [...new Set(project.instrumentation.spans.map(s => s.op))];
    ops.forEach((op, idx) => {
      const row = 3 + Math.floor(idx / 2) * 2;
      const col = (idx % 2) * 3;

      widgets.push({
        title: `${op} — Throughput`,
        description: `Span count for op:${op}`,
        displayType: 'area',
        widgetType: 'spans',
        interval: '1h',
        queries: [{
          aggregates: ['count(span.duration)'],
          columns: ['span.description'],
          conditions: `span.op:${op}`,
          name: '',
          orderby: '-count(span.duration)',
          fields: ['span.description', 'count(span.duration)']
        }],
        layout: { x: col, y: row, w: 3, h: 2, minH: 2 }
      });

      widgets.push({
        title: `${op} — P95 Latency`,
        description: `P95 duration for op:${op}`,
        displayType: 'line',
        widgetType: 'spans',
        interval: '1h',
        queries: [{
          aggregates: ['p95(span.duration)'],
          columns: ['span.description'],
          conditions: `span.op:${op}`,
          name: '',
          orderby: '-p95(span.duration)',
          fields: ['span.description', 'p95(span.duration)']
        }],
        layout: { x: col, y: row + 0, w: 3, h: 2, minH: 2 }
      });
    });

    // ── Bottom row: Top slowest spans table ─────────────────────────────────
    const lastRow = 3 + Math.ceil(ops.length / 2) * 2;
    widgets.push({
      title: 'Top Slowest Spans',
      description: 'Ranked by P95 duration — useful for finding bottlenecks',
      displayType: 'table',
      widgetType: 'spans',
      interval: '1h',
      limit: 10,
      queries: [{
        aggregates: ['p95(span.duration)', 'count(span.duration)'],
        columns: ['span.description', 'span.op'],
        conditions: '',
        name: '',
        orderby: '-p95(span.duration)',
        fields: ['span.description', 'span.op', 'p95(span.duration)', 'count(span.duration)']
      }],
      layout: { x: 0, y: lastRow, w: 6, h: 3, minH: 3 }
    });

    return {
      title: `${project.project.name} — Monitoring Dashboard`,
      filters: {},
      projects: [],
      environment: [],
      widgets
    };
  }

  private buildDataGenerationScript(project: EngagementSpec): string {
    const frontendSpans = project.instrumentation.spans.filter(s => s.layer === 'frontend');
    const backendSpans = project.instrumentation.spans.filter(s => s.layer === 'backend');

    return `#!/usr/bin/env python3
"""
Data Generator for ${project.project.name}
Generates realistic test data with custom spans and attributes
"""

import os
import random
import time
from datetime import datetime, timedelta
from typing import Dict, List, Any
import sentry_sdk
from sentry_sdk import start_transaction, start_span
from faker import Faker
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

fake = Faker()

# Configuration
FRONTEND_DSN = os.getenv('SENTRY_DSN_FRONTEND')
BACKEND_DSN = os.getenv('SENTRY_DSN_BACKEND')
NUM_TRACES = int(os.getenv('NUM_TRACES', '100'))
NUM_ERRORS = int(os.getenv('NUM_ERRORS', '20'))

# Instrumentation from engagement spec
FRONTEND_SPANS = ${JSON.stringify(frontendSpans.map(s => ({
  name: s.name,
  op: s.op,
  attributes: Object.keys(s.attributes),
  pii: s.pii.keys
})), null, 2)}

BACKEND_SPANS = ${JSON.stringify(backendSpans.map(s => ({
  name: s.name,
  op: s.op,
  attributes: Object.keys(s.attributes),
  pii: s.pii.keys
})), null, 2)}


class DataGenerator:
    def __init__(self, dsn: str, environment: str = 'development'):
        """Initialize Sentry SDK for data generation"""
        sentry_sdk.init(
            dsn=dsn,
            environment=environment,
            traces_sample_rate=1.0,
            profiles_sample_rate=1.0,
        )
        self.fake = Faker()
    
    def generate_attribute_value(self, attr_name: str, pii_keys: List[str]) -> Any:
        """Generate realistic values for attributes"""
        attr_lower = attr_name.lower()
        
        # Handle PII - return redacted or fake data
        if attr_name in pii_keys:
            if 'email' in attr_lower:
                return '[REDACTED]'
            elif 'card' in attr_lower or 'payment' in attr_lower:
                return '[REDACTED]'
            elif 'phone' in attr_lower:
                return '[REDACTED]'
            else:
                return '[REDACTED]'
        
        # Generate realistic non-PII values
        if 'id' in attr_lower:
            return self.fake.uuid4()
        elif 'name' in attr_lower:
            return self.fake.word()
        elif 'price' in attr_lower or 'amount' in attr_lower or 'value' in attr_lower:
            return round(random.uniform(10.0, 500.0), 2)
        elif 'count' in attr_lower or 'quantity' in attr_lower:
            return random.randint(1, 10)
        elif 'method' in attr_lower:
            return random.choice(['credit_card', 'paypal', 'apple_pay', 'google_pay'])
        elif 'status' in attr_lower:
            return random.choice(['success', 'pending', 'failed'])
        elif 'type' in attr_lower:
            return random.choice(['standard', 'express', 'premium'])
        elif 'url' in attr_lower:
            return self.fake.url()
        elif 'user' in attr_lower:
            return f"user_{random.randint(1, 1000)}"
        else:
            return self.fake.word()
    
    def generate_custom_span(self, span_config: Dict[str, Any], parent_span=None):
        """Generate a custom span with attributes"""
        with start_span(
            op=span_config['op'],
            description=span_config['name']
        ) as span:
            # Add custom attributes
            for attr in span_config['attributes']:
                value = self.generate_attribute_value(attr, span_config['pii'])
                span.set_tag(attr, value)
            
            # Simulate work
            time.sleep(random.uniform(0.01, 0.1))
            
            return span


class FrontendDataGenerator(DataGenerator):
    """Generate frontend traces"""
    
    def generate_page_view(self, route: str):
        """Simulate a page view with custom instrumentation"""
        with start_transaction(op="pageload", name=route) as transaction:
            transaction.set_tag("transaction.type", "pageload")
            
            # Generate frontend spans
            for span_config in FRONTEND_SPANS:
                try:
                    self.generate_custom_span(span_config)
                except Exception as e:
                    print(f"Error generating span {span_config['name']}: {e}")
            
            # Simulate page load time
            time.sleep(random.uniform(0.1, 0.5))
    
    def generate_user_interaction(self, action: str):
        """Simulate user interaction"""
        with start_transaction(op="ui.action", name=action) as transaction:
            transaction.set_tag("action.type", action)
            
            # Add some frontend spans
            for span_config in random.sample(FRONTEND_SPANS, min(2, len(FRONTEND_SPANS))):
                self.generate_custom_span(span_config)
            
            time.sleep(random.uniform(0.05, 0.2))
    
    def generate_error(self):
        """Generate a frontend error"""
        errors = [
            "TypeError: Cannot read property 'value' of null",
            "NetworkError: Failed to fetch",
            "ReferenceError: validateForm is not defined",
            "Error: Payment validation failed",
        ]
        
        try:
            raise Exception(random.choice(errors))
        except Exception as e:
            sentry_sdk.capture_exception(e)


class BackendDataGenerator(DataGenerator):
    """Generate backend traces"""
    
    def generate_api_call(self, endpoint: str, method: str = "GET"):
        """Simulate an API call with custom instrumentation"""
        with start_transaction(op="http.server", name=f"{method} {endpoint}") as transaction:
            transaction.set_tag("http.method", method)
            transaction.set_tag("http.route", endpoint)
            
            # Generate backend spans
            for span_config in BACKEND_SPANS:
                try:
                    self.generate_custom_span(span_config)
                except Exception as e:
                    print(f"Error generating span {span_config['name']}: {e}")
            
            # Simulate processing time
            time.sleep(random.uniform(0.05, 0.3))
            
            # Occasionally simulate slow response
            if random.random() < 0.1:
                time.sleep(random.uniform(1.0, 2.0))
    
    def generate_database_query(self):
        """Simulate database query"""
        queries = [
            "SELECT * FROM products WHERE id = ?",
            "INSERT INTO orders (user_id, total) VALUES (?, ?)",
            "UPDATE cart SET quantity = ? WHERE id = ?",
            "DELETE FROM sessions WHERE expired_at < ?",
        ]
        
        with start_span(op="db.query", description=random.choice(queries)) as span:
            span.set_tag("db.system", "postgresql")
            time.sleep(random.uniform(0.01, 0.05))
    
    def generate_error(self):
        """Generate a backend error"""
        errors = [
            "DatabaseError: Connection timeout",
            "ValidationError: Invalid cart items",
            "PaymentError: Payment gateway unavailable",
            "AuthenticationError: Invalid token",
        ]
        
        try:
            raise Exception(random.choice(errors))
        except Exception as e:
            sentry_sdk.capture_exception(e)


def main():
    """Main data generation function"""
    print(f"🚀 Starting data generation for ${project.project.name}")
    print(f"📊 Generating {NUM_TRACES} traces and {NUM_ERRORS} errors")
    
    # Initialize generators
    if FRONTEND_DSN:
        print("\\n🎨 Generating frontend data...")
        frontend = FrontendDataGenerator(FRONTEND_DSN, 'development')
        
        routes = ['/', '/products', '/cart', '/checkout', '/order/123']
        actions = ['Add to Cart', 'Submit Checkout', 'Apply Promo Code', 'Update Quantity']
        
        for i in range(NUM_TRACES // 2):
            if i % 10 == 0:
                print(f"  Progress: {i}/{NUM_TRACES // 2}")
            
            # Generate page views
            frontend.generate_page_view(random.choice(routes))
            
            # Generate user interactions
            if random.random() < 0.5:
                frontend.generate_user_interaction(random.choice(actions))
        
        # Generate frontend errors
        for i in range(NUM_ERRORS // 2):
            frontend.generate_error()
            time.sleep(0.1)
        
        print(f"✅ Generated {NUM_TRACES // 2} frontend traces and {NUM_ERRORS // 2} errors")
    
    if BACKEND_DSN:
        print("\\n⚙️  Generating backend data...")
        backend = BackendDataGenerator(BACKEND_DSN, 'development')
        
        endpoints = [
            '/api/products',
            '/api/cart/add',
            '/api/checkout',
            '/api/order/123',
            '/api/user/profile'
        ]
        methods = ['GET', 'POST', 'PUT', 'DELETE']
        
        for i in range(NUM_TRACES // 2):
            if i % 10 == 0:
                print(f"  Progress: {i}/{NUM_TRACES // 2}")
            
            # Generate API calls
            endpoint = random.choice(endpoints)
            method = 'GET' if '/api/products' in endpoint else random.choice(methods)
            backend.generate_api_call(endpoint, method)
            
            # Add database queries
            if random.random() < 0.7:
                backend.generate_database_query()
        
        # Generate backend errors
        for i in range(NUM_ERRORS // 2):
            backend.generate_error()
            time.sleep(0.1)
        
        print(f"✅ Generated {NUM_TRACES // 2} backend traces and {NUM_ERRORS // 2} errors")
    
    # Flush remaining events
    sentry_sdk.flush()
    
    print("\\n🎉 Data generation complete!")
    print("📊 Check your Sentry dashboard for the data")


if __name__ == '__main__':
    if not FRONTEND_DSN and not BACKEND_DSN:
        print("❌ Error: No Sentry DSN configured!")
        print("Please set SENTRY_DSN_FRONTEND and/or SENTRY_DSN_BACKEND in your .env file")
        exit(1)
    
    main()
`;
  }

  // ============================================
  // React Native / Mobile Generation Methods
  // ============================================

  private createMobileDirectoryStructure(appPath: string): void {
    const dirs = [
      appPath,
      path.join(appPath, 'mobile'),
      path.join(appPath, 'mobile', 'screens'),
      path.join(appPath, 'mobile', 'components'),
      path.join(appPath, 'mobile', 'services'),
      path.join(appPath, 'mobile', 'navigation'),
      path.join(appPath, 'backend'),
      path.join(appPath, 'backend', 'src'),
      path.join(appPath, 'backend', 'src', 'routes'),
      path.join(appPath, 'backend', 'src', 'middleware'),
      path.join(appPath, 'backend', 'src', 'utils')
    ];

    dirs.forEach(dir => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });
  }

  private async generateReactNativeApp(appPath: string, project: EngagementSpec): Promise<void> {
    console.log('🤖 Using LLM to generate custom mobile app based on project requirements...');
    const mobilePath = path.join(appPath, 'mobile');

    // Generate static config files (these don't need LLM)
    this.generateReactNativePackageJson(mobilePath, project);
    this.generateReactNativeAppJson(mobilePath, project);
    this.generateReactNativeBabelConfig(mobilePath);
    this.generateReactNativeSentryConfig(mobilePath, project);
    this.generateReactNativeAppTsx(mobilePath, project);

    // Use LLM to generate custom screens based on project notes and instrumentation plan
    try {
      console.log('📝 Generating screens with LLM...');
      const { screens } = await this.llm.generateMobileScreens(project);
      console.log(`✅ LLM generated ${screens.length} custom screens`);
      
      // Write generated screens
      const screensPath = path.join(mobilePath, 'screens');
      fs.mkdirSync(screensPath, { recursive: true });
      
      for (const screen of screens) {
        fs.writeFileSync(path.join(screensPath, screen.filename), screen.code);
        console.log(`  - ${screen.filename}: ${screen.description}`);
      }

      // Generate navigation that includes all the LLM-generated screens
      this.generateReactNativeNavigationFromScreens(mobilePath, project, screens);
    } catch (error) {
      console.error('❌ LLM screen generation failed, falling back to templates:', error);
      // Fallback to template-based generation
      this.generateReactNativeScreens(mobilePath, project);
      this.generateReactNativeNavigation(mobilePath, project);
    }

    // Use LLM to generate API service with mock data fallback
    try {
      console.log('📝 Generating API service with LLM...');
      const { code } = await this.llm.generateApiService(project);
      console.log('✅ LLM generated API service with mock data support');
      
      const servicesPath = path.join(mobilePath, 'services');
      fs.mkdirSync(servicesPath, { recursive: true });
      fs.writeFileSync(path.join(servicesPath, 'api.ts'), code);
    } catch (error) {
      console.error('❌ LLM API service generation failed, using fallback:', error);
      // Fallback to template-based generation
      this.generateReactNativeServices(mobilePath, project);
    }
  }

  private generateReactNativePackageJson(mobilePath: string, project: EngagementSpec): void {
    const packageJson = {
      name: `${project.project.slug}-mobile`,
      version: "1.0.0",
      main: "node_modules/expo/AppEntry.js",
      scripts: {
        start: "expo start",
        android: "expo start --android",
        ios: "expo start --ios",
        web: "expo start --web"
      },
      dependencies: {
        "expo": "~50.0.0",
        "expo-status-bar": "~1.11.1",
        "react": "18.2.0",
        "react-native": "0.73.6",
        "@react-navigation/native": "^6.1.9",
        "@react-navigation/stack": "^6.3.20",
        "react-native-screens": "~3.29.0",
        "react-native-safe-area-context": "4.8.2",
        "react-native-gesture-handler": "~2.14.0",
        "@sentry/react-native": "~5.20.0",
        "axios": "^1.6.2"
      },
      devDependencies: {
        "@babel/core": "^7.23.5",
        "@types/react": "~18.2.45",
        "typescript": "^5.3.3"
      },
      private: true
    };

    fs.writeFileSync(
      path.join(mobilePath, 'package.json'),
      JSON.stringify(packageJson, null, 2)
    );
  }

  private generateReactNativeAppJson(mobilePath: string, project: EngagementSpec): void {
    const appJson = {
      expo: {
        name: project.project.name,
        slug: project.project.slug,
        version: "1.0.0",
        orientation: "portrait",
        icon: "./assets/icon.png",
        userInterfaceStyle: "light",
        splash: {
          image: "./assets/splash.png",
          resizeMode: "contain",
          backgroundColor: "#ffffff"
        },
        assetBundlePatterns: ["**/*"],
        ios: {
          supportsTablet: true,
          bundleIdentifier: `com.${project.project.slug}.app`
        },
        android: {
          adaptiveIcon: {
            foregroundImage: "./assets/adaptive-icon.png",
            backgroundColor: "#ffffff"
          },
          package: `com.${project.project.slug}.app`
        },
        web: {
          favicon: "./assets/favicon.png"
        },
        plugins: [
          "@sentry/react-native/expo"
        ],
        hooks: {
          postPublish: [
            {
              file: "sentry-expo/upload-sourcemaps",
              config: {
                organization: "your-org",
                project: project.project.slug
              }
            }
          ]
        }
      }
    };

    fs.writeFileSync(
      path.join(mobilePath, 'app.json'),
      JSON.stringify(appJson, null, 2)
    );
  }

  private generateReactNativeBabelConfig(mobilePath: string): void {
    const babelConfig = `module.exports = function(api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
  };
};
`;

    fs.writeFileSync(path.join(mobilePath, 'babel.config.js'), babelConfig);
  }

  private generateReactNativeSentryConfig(mobilePath: string, project: EngagementSpec): void {
    const sentryConfig = `import * as Sentry from '@sentry/react-native';

Sentry.init({
  dsn: process.env.EXPO_PUBLIC_SENTRY_DSN,
  environment: process.env.EXPO_PUBLIC_SENTRY_ENVIRONMENT || 'development',
  tracesSampleRate: 1.0,
  enableAutoSessionTracking: true,
  sessionTrackingIntervalMillis: 10000,
  integrations: [
    new Sentry.ReactNativeTracing({
      routingInstrumentation: Sentry.reactNavigationIntegration,
    }),
  ],
});

export default Sentry;
`;

    fs.writeFileSync(path.join(mobilePath, 'sentry.config.ts'), sentryConfig);
  }

  private generateReactNativeAppTsx(mobilePath: string, project: EngagementSpec): void {
    const appTsx = `import React, { useEffect } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import * as Sentry from '@sentry/react-native';
import AppNavigator from './navigation/AppNavigator';

// Initialize Sentry
Sentry.init({
  dsn: process.env.EXPO_PUBLIC_SENTRY_DSN || '',
  environment: process.env.EXPO_PUBLIC_SENTRY_ENVIRONMENT || 'development',
  tracesSampleRate: 1.0,
  enableAutoSessionTracking: true,
  sessionTrackingIntervalMillis: 10000,
  integrations: [
    new Sentry.ReactNativeTracing({
      routingInstrumentation: Sentry.reactNavigationIntegration,
    }),
  ],
});

export default function App() {
  return (
    <NavigationContainer>
      <AppNavigator />
    </NavigationContainer>
  );
}
`;

    fs.writeFileSync(path.join(mobilePath, 'App.tsx'), appTsx);
  }

  private generateReactNativeScreens(mobilePath: string, project: EngagementSpec): void {
    const screensPath = path.join(mobilePath, 'screens');

    // TODO: In the future, use LLM to generate custom screens based on project.project.notes
    // For now, generate generic screens

    // Home Screen
    const homeScreen = `import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator
} from 'react-native';
import * as Sentry from '@sentry/react-native';
import { apiService } from '../services/api';

export default function HomeScreen({ navigation }: any) {
  const [products, setProducts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadProducts();
  }, []);

  const loadProducts = async () => {
    const transaction = Sentry.startTransaction({
      name: 'HomeScreen.loadProducts',
      op: 'navigation.screen_load',
    });

    try {
      const data = await apiService.getProducts();
      setProducts(data);
    } catch (error) {
      Sentry.captureException(error);
    } finally {
      setLoading(false);
      transaction.finish();
    }
  };

  const handleProductPress = (product: any) => {
    const span = Sentry.startInactiveSpan({
      name: 'ui.button_press',
      op: 'ui.action',
    });
    span?.setData('product_id', product.id);
    span?.finish();

    navigation.navigate('ProductDetail', { product });
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#6366f1" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Products</Text>
      <FlatList
        data={products}
        keyExtractor={(item) => item.id.toString()}
        renderItem={({ item }) => (
          <TouchableOpacity
            style={styles.card}
            onPress={() => handleProductPress(item)}
          >
            <Text style={styles.emoji}>{item.image}</Text>
            <View style={styles.info}>
              <Text style={styles.name}>{item.name}</Text>
              <Text style={styles.description}>{item.description}</Text>
              <Text style={styles.price}>$\{item.price.toFixed(2)}</Text>
            </View>
          </TouchableOpacity>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f9fafb',
    padding: 16,
  },
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  title: {
    fontSize: 28,
    fontWeight: 'bold',
    marginBottom: 16,
    color: '#111827',
  },
  card: {
    flexDirection: 'row',
    backgroundColor: 'white',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  emoji: {
    fontSize: 48,
    marginRight: 16,
  },
  info: {
    flex: 1,
  },
  name: {
    fontSize: 18,
    fontWeight: '600',
    color: '#111827',
    marginBottom: 4,
  },
  description: {
    fontSize: 14,
    color: '#6b7280',
    marginBottom: 8,
  },
  price: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#6366f1',
  },
});
`;

    // Product Detail Screen
    const productDetailScreen = `import React, { useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Alert,
} from 'react-native';
import * as Sentry from '@sentry/react-native';
import { apiService } from '../services/api';

export default function ProductDetailScreen({ route, navigation }: any) {
  const { product } = route.params;
  const [addingToCart, setAddingToCart] = useState(false);

  const handleAddToCart = async () => {
    setAddingToCart(true);
    const transaction = Sentry.startTransaction({
      name: 'cart.addProduct',
      op: 'ui.action',
    });

    transaction.setData('product_id', product.id);
    transaction.setData('product_name', product.name);
    transaction.setData('price', product.price);

    try {
      await apiService.addToCart(product.id);
      Alert.alert(
        'Success!',
        \`\${product.name} has been added to your cart.\`,
        [
          { text: 'Continue Shopping', onPress: () => navigation.goBack() },
          { text: 'OK' },
        ]
      );
    } catch (error) {
      Alert.alert('Error', 'Failed to add item to cart. Please try again.');
      Sentry.captureException(error);
    } finally {
      setAddingToCart(false);
      transaction.finish();
    }
  };

  return (
    <ScrollView style={styles.container}>
      <View style={styles.content}>
        <View style={styles.imageContainer}>
          <Text style={styles.emoji}>{product.image}</Text>
        </View>
        
        <View style={styles.infoCard}>
          <Text style={styles.name}>{product.name}</Text>
          <Text style={styles.description}>{product.description}</Text>
          
          <View style={styles.priceRow}>
            <Text style={styles.priceLabel}>Price:</Text>
            <Text style={styles.price}>$\{product.price.toFixed(2)}</Text>
          </View>

          <View style={styles.features}>
            <Text style={styles.featuresTitle}>Features:</Text>
            <View style={styles.featureItem}>
              <Text style={styles.featureBullet}>✓</Text>
              <Text style={styles.featureText}>High quality product</Text>
            </View>
            <View style={styles.featureItem}>
              <Text style={styles.featureBullet}>✓</Text>
              <Text style={styles.featureText}>Fast shipping available</Text>
            </View>
            <View style={styles.featureItem}>
              <Text style={styles.featureBullet}>✓</Text>
              <Text style={styles.featureText}>30-day money-back guarantee</Text>
            </View>
          </View>
        </View>

        <TouchableOpacity 
          style={[styles.button, addingToCart && styles.buttonDisabled]} 
          onPress={handleAddToCart}
          disabled={addingToCart}
        >
          <Text style={styles.buttonText}>
            {addingToCart ? 'Adding to Cart...' : '🛒 Add to Cart'}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.button, styles.secondaryButton]}
          onPress={() => navigation.goBack()}
        >
          <Text style={[styles.buttonText, styles.secondaryButtonText]}>
            ← Back to Products
          </Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f9fafb',
  },
  content: {
    padding: 20,
  },
  imageContainer: {
    alignItems: 'center',
    backgroundColor: 'white',
    borderRadius: 16,
    padding: 32,
    marginBottom: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 4,
  },
  emoji: {
    fontSize: 120,
  },
  infoCard: {
    backgroundColor: 'white',
    borderRadius: 16,
    padding: 20,
    marginBottom: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 4,
  },
  name: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#111827',
    marginBottom: 12,
  },
  description: {
    fontSize: 16,
    color: '#6b7280',
    lineHeight: 24,
    marginBottom: 20,
  },
  priceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: '#e5e7eb',
    marginBottom: 20,
  },
  priceLabel: {
    fontSize: 18,
    color: '#6b7280',
  },
  price: {
    fontSize: 32,
    fontWeight: 'bold',
    color: '#6366f1',
  },
  features: {
    borderTopWidth: 1,
    borderTopColor: '#e5e7eb',
    paddingTop: 16,
  },
  featuresTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#111827',
    marginBottom: 12,
  },
  featureItem: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  featureBullet: {
    fontSize: 16,
    color: '#10b981',
    marginRight: 8,
    fontWeight: 'bold',
  },
  featureText: {
    fontSize: 15,
    color: '#4b5563',
  },
  button: {
    backgroundColor: '#6366f1',
    paddingVertical: 16,
    paddingHorizontal: 32,
    borderRadius: 12,
    marginBottom: 12,
    shadowColor: '#6366f1',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 4,
  },
  buttonDisabled: {
    backgroundColor: '#9ca3af',
    shadowOpacity: 0.1,
  },
  buttonText: {
    color: 'white',
    fontSize: 18,
    fontWeight: '600',
    textAlign: 'center',
  },
  secondaryButton: {
    backgroundColor: 'white',
    borderWidth: 2,
    borderColor: '#6366f1',
    shadowColor: '#000',
    shadowOpacity: 0.1,
  },
  secondaryButtonText: {
    color: '#6366f1',
  },
});
`;

    fs.writeFileSync(path.join(screensPath, 'HomeScreen.tsx'), homeScreen);
    fs.writeFileSync(path.join(screensPath, 'ProductDetailScreen.tsx'), productDetailScreen);
  }

  private generateReactNativeNavigation(mobilePath: string, project: EngagementSpec): void {
    const navigationPath = path.join(mobilePath, 'navigation');

    const appNavigator = `import React from 'react';
import { createStackNavigator } from '@react-navigation/stack';
import HomeScreen from '../screens/HomeScreen';
import ProductDetailScreen from '../screens/ProductDetailScreen';

const Stack = createStackNavigator();

export default function AppNavigator() {
  return (
    <Stack.Navigator
      initialRouteName="Home"
      screenOptions={{
        headerStyle: {
          backgroundColor: '#6366f1',
        },
        headerTintColor: '#fff',
        headerTitleStyle: {
          fontWeight: 'bold',
        },
      }}
    >
      <Stack.Screen
        name="Home"
        component={HomeScreen}
        options={{ title: '${project.project.name}' }}
      />
      <Stack.Screen
        name="ProductDetail"
        component={ProductDetailScreen}
        options={{ title: 'Product Details' }}
      />
    </Stack.Navigator>
  );
}
`;

    fs.writeFileSync(path.join(navigationPath, 'AppNavigator.tsx'), appNavigator);
  }

  private generateReactNativeNavigationFromScreens(
    mobilePath: string,
    project: EngagementSpec,
    screens: Array<{ name: string; filename: string }>
  ): void {
    const navigationPath = path.join(mobilePath, 'navigation');
    fs.mkdirSync(navigationPath, { recursive: true });

    // Generate imports for all screens
    const imports = screens.map(screen => 
      `import ${screen.name} from '../screens/${screen.filename.replace('.tsx', '')}';`
    ).join('\n');

    // Generate Stack.Screen components
    const screenComponents = screens.map((screen, index) => {
      const screenName = screen.name.replace('Screen', ''); // Remove 'Screen' suffix for route name
      const isFirst = index === 0;
      const title = screenName.replace(/([A-Z])/g, ' $1').trim(); // Convert camelCase to Title Case
      
      return `      <Stack.Screen
        name="${screenName}"
        component=${screen.name}
        options={{ title: '${title}' }}
      />`;
    }).join('\n');

    const firstScreenName = screens[0]?.name.replace('Screen', '') || 'Home';

    const appNavigator = `import React from 'react';
import { createStackNavigator } from '@react-navigation/stack';
${imports}

const Stack = createStackNavigator();

export default function AppNavigator() {
  return (
    <Stack.Navigator
      initialRouteName="${firstScreenName}"
      screenOptions={{
        headerStyle: {
          backgroundColor: '#6366f1',
        },
        headerTintColor: '#fff',
        headerTitleStyle: {
          fontWeight: 'bold',
        },
      }}
    >
${screenComponents}
    </Stack.Navigator>
  );
}
`;

    fs.writeFileSync(path.join(navigationPath, 'AppNavigator.tsx'), appNavigator);
    console.log('✅ Generated navigation with LLM screens');
  }

  private generateReactNativeServices(mobilePath: string, project: EngagementSpec): void {
    const servicesPath = path.join(mobilePath, 'services');

    const apiService = `import axios from 'axios';
import * as Sentry from '@sentry/react-native';

// Configure your backend URL
// For local development: http://localhost:3001
// For production: your deployed backend URL
const API_BASE_URL = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:3001';

// Mock data for demo purposes (used when backend is unavailable)
const MOCK_PRODUCTS = [
  {
    id: 1,
    name: 'Premium Headphones',
    description: 'High-quality wireless headphones with noise cancellation',
    price: 299.99,
    image: '🎧',
  },
  {
    id: 2,
    name: 'Smart Watch',
    description: 'Fitness tracker with heart rate monitor and GPS',
    price: 399.99,
    image: '⌚',
  },
  {
    id: 3,
    name: 'Laptop',
    description: 'Powerful laptop for work and entertainment',
    price: 1299.99,
    image: '💻',
  },
  {
    id: 4,
    name: 'Wireless Mouse',
    description: 'Ergonomic mouse with customizable buttons',
    price: 49.99,
    image: '🖱️',
  },
  {
    id: 5,
    name: 'Mechanical Keyboard',
    description: 'RGB backlit keyboard with cherry MX switches',
    price: 149.99,
    image: '⌨️',
  },
  {
    id: 6,
    name: 'USB-C Hub',
    description: 'Multi-port adapter with HDMI, USB 3.0, and card reader',
    price: 59.99,
    image: '🔌',
  },
  {
    id: 7,
    name: 'External SSD',
    description: '1TB portable solid state drive with fast transfer speeds',
    price: 179.99,
    image: '💾',
  },
  {
    id: 8,
    name: 'Webcam',
    description: '4K webcam with auto-focus and built-in microphone',
    price: 129.99,
    image: '📹',
  },
];

const apiClient = axios.create({
  baseURL: API_BASE_URL,
  timeout: 10000,
  headers: {
    'Content-Type': 'application/json',
  },
});

export const apiService = {
  async getProducts() {
    const span = Sentry.startInactiveSpan({
      name: 'api.fetch_products',
      op: 'http.client',
    });

    try {
      const response = await apiClient.get('/api/products');
      span?.setData('product_count', response.data.length);
      span?.setData('data_source', 'backend');
      return response.data;
    } catch (error) {
      console.log('Backend unavailable, using mock data');
      span?.setData('product_count', MOCK_PRODUCTS.length);
      span?.setData('data_source', 'mock');
      // Return mock data when backend is unavailable (e.g., in Expo Snack)
      return MOCK_PRODUCTS;
    } finally {
      span?.finish();
    }
  },

  async addToCart(productId: number) {
    const span = Sentry.startInactiveSpan({
      name: 'cart.add',
      op: 'http.client',
    });

    span?.setData('product_id', productId);

    try {
      const response = await apiClient.post('/api/cart/add', { productId });
      span?.setData('data_source', 'backend');
      return response.data;
    } catch (error) {
      console.log('Backend unavailable, simulating cart add');
      span?.setData('data_source', 'mock');
      // Simulate success when backend is unavailable
      return { success: true, message: 'Added to cart (mock)' };
    } finally {
      span?.finish();
    }
  },
};
`;

    fs.writeFileSync(path.join(servicesPath, 'api.ts'), apiService);

    // Generate .env.example
    const envExample = `# Backend API URL
EXPO_PUBLIC_API_URL=http://localhost:3001

# Sentry DSN
EXPO_PUBLIC_SENTRY_DSN=your_sentry_dsn_here

# Environment
EXPO_PUBLIC_SENTRY_ENVIRONMENT=development
`;

    fs.writeFileSync(path.join(mobilePath, '.env.example'), envExample);

    // Generate README
    const readme = `# ${project.project.name} - Mobile App

React Native mobile app built with Expo and instrumented with Sentry.

## Project Notes

${project.project.notes || 'No additional notes provided.'}

## Getting Started

### Prerequisites

- Node.js 18+
- Expo CLI
- Expo Go app (for testing on device)

### Installation

\`\`\`bash
cd mobile
npm install
\`\`\`

### Configuration

1. Copy \`.env.example\` to \`.env\`
2. Update \`EXPO_PUBLIC_SENTRY_DSN\` with your Sentry DSN
3. Update \`EXPO_PUBLIC_API_URL\` with your backend URL

### Running the App

\`\`\`bash
npm start
\`\`\`

This will start the Expo development server. You can:
- Scan the QR code with Expo Go app
- Press 'i' for iOS Simulator
- Press 'a' for Android Emulator
- Press 'w' for web browser

## Sentry Instrumentation

This app includes custom Sentry instrumentation:

${project.instrumentation.spans
  .filter(s => s.layer === 'frontend')
  .map(s => `- **${s.name}**: ${s.description}`)
  .join('\n')}

## TODO

Implement custom features based on project requirements:
${project.project.notes || '- Add your custom features here'}

See \`IMPLEMENTATION_GUIDE.md\` for detailed instructions.
`;

    fs.writeFileSync(path.join(mobilePath, 'README.md'), readme);
  }

  /**
   * Read all generated files from a project for refinement
   */
  readGeneratedFiles(projectId: string): Record<string, string> {
    const outputPath = this.storage.getOutputPath(projectId);
    const appPath = path.join(outputPath, 'reference-app');
    const files: Record<string, string> = {};

    const project = this.storage.getProject(projectId);
    const isMobile = project.stack.type === 'mobile';
    
    const basePath = isMobile 
      ? path.join(appPath, 'mobile')
      : path.join(appPath, 'frontend', 'app');

    if (!fs.existsSync(basePath)) {
      console.warn('Generated app not found at:', basePath);
      return files;
    }

    try {
      // Read screens/pages
      if (isMobile) {
        const screensPath = path.join(appPath, 'mobile', 'screens');
        if (fs.existsSync(screensPath)) {
          const screenFiles = fs.readdirSync(screensPath);
          for (const file of screenFiles) {
            if (file.endsWith('.tsx') || file.endsWith('.ts')) {
              const filePath = path.join(screensPath, file);
              files[`screens/${file}`] = fs.readFileSync(filePath, 'utf-8');
            }
          }
        }

        // Read API service
        const apiFile = path.join(appPath, 'mobile', 'services', 'api.ts');
        if (fs.existsSync(apiFile)) {
          files['services/api.ts'] = fs.readFileSync(apiFile, 'utf-8');
        }

        // Read navigation
        const navFile = path.join(appPath, 'mobile', 'navigation', 'AppNavigator.tsx');
        if (fs.existsSync(navFile)) {
          files['navigation/AppNavigator.tsx'] = fs.readFileSync(navFile, 'utf-8');
        }
      } else {
        // Web app - read Next.js pages
        const pagesPath = path.join(appPath, 'frontend', 'app');
        if (fs.existsSync(pagesPath)) {
          const readDirRecursive = (dir: string, prefix: string = '') => {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
              const fullPath = path.join(dir, entry.name);
              const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
              
              if (entry.isDirectory()) {
                readDirRecursive(fullPath, relativePath);
              } else if (entry.name.endsWith('.tsx') || entry.name.endsWith('.ts')) {
                files[relativePath] = fs.readFileSync(fullPath, 'utf-8');
              }
            }
          };
          readDirRecursive(pagesPath);
        }
      }

      console.log(`✅ Read ${Object.keys(files).length} files for refinement`);
    } catch (error) {
      console.error('Error reading generated files:', error);
    }

    return files;
  }

  /**
   * Update a specific file with refined code
   */
  updateGeneratedFile(
    projectId: string,
    relativePath: string,
    newCode: string
  ): void {
    const outputPath = this.storage.getOutputPath(projectId);
    const project = this.storage.getProject(projectId);
    const isMobile = project.stack.type === 'mobile';
    
    const basePath = isMobile
      ? path.join(outputPath, 'reference-app', 'mobile')
      : path.join(outputPath, 'reference-app', 'frontend', 'app');
    
    const fullPath = path.join(basePath, relativePath);
    
    // Create backup directory if it doesn't exist
    const backupDir = path.join(outputPath, 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    
    // Backup original file with timestamp
    if (fs.existsSync(fullPath)) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupFileName = `${relativePath.replace(/\//g, '_')}.${timestamp}.backup`;
      const backupPath = path.join(backupDir, backupFileName);
      fs.copyFileSync(fullPath, backupPath);
      console.log(`📦 Backed up to: ${backupFileName}`);
    }
    
    // Write new code
    const dir = path.dirname(fullPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fullPath, newCode);
    console.log(`✅ Updated ${relativePath}`);
  }

  // ============================================
  // Python Backend Generation Methods
  // ============================================

  private createPythonDirectoryStructure(appPath: string): void {
    const dirs = [
      appPath,
      path.join(appPath, 'app'),
      path.join(appPath, 'app', 'routes'),
      path.join(appPath, 'app', 'models'),
      path.join(appPath, 'app', 'services'),
      path.join(appPath, 'app', 'utils')
    ];

    for (const dir of dirs) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
  }

  private generatePythonBackend(appPath: string, project: EngagementSpec): void {
    if (project.stack.backend === 'fastapi') {
      this.generateFastAPI(appPath, project);
    } else {
      this.generateFlask(appPath, project);
    }
  }

  private generateFastAPI(appPath: string, project: EngagementSpec): void {
    // requirements.txt
    const requirements = `fastapi==0.109.0
uvicorn[standard]==0.27.0
pydantic==2.5.3
python-dotenv==1.0.0
sentry-sdk==1.40.0
`;
    fs.writeFileSync(path.join(appPath, 'requirements.txt'), requirements);

    // .env.example
    const envExample = `SENTRY_DSN=your_sentry_dsn_here
ENVIRONMENT=development
`;
    fs.writeFileSync(path.join(appPath, '.env.example'), envExample);

    // sentry_config.py
    const sentryConfig = `import sentry_sdk
from sentry_sdk.integrations.fastapi import FastApiIntegration
from sentry_sdk.integrations.starlette import StarletteIntegration
import os
from dotenv import load_dotenv

load_dotenv()

def init_sentry():
    sentry_sdk.init(
        dsn=os.getenv("SENTRY_DSN"),
        environment=os.getenv("ENVIRONMENT", "development"),
        traces_sample_rate=1.0,
        profiles_sample_rate=1.0,
        integrations=[
            FastApiIntegration(),
            StarletteIntegration(),
        ],
    )
`;
    fs.writeFileSync(path.join(appPath, 'sentry_config.py'), sentryConfig);

    // app/__init__.py
    fs.writeFileSync(path.join(appPath, 'app', '__init__.py'), '');

    // app/instrumentation.py - Custom Sentry instrumentation
    const backendSpans = project.instrumentation.spans.filter(s => s.layer === 'backend');
    const instrumentationCode = this.generatePythonInstrumentation(backendSpans);
    fs.writeFileSync(path.join(appPath, 'app', 'instrumentation.py'), instrumentationCode);

    // app/models.py
    const modelsCode = `from pydantic import BaseModel
from typing import Optional, List

class Product(BaseModel):
    id: str
    name: str
    price: float
    description: Optional[str] = None
    image_url: Optional[str] = None

class CartItem(BaseModel):
    product_id: str
    quantity: int

class Order(BaseModel):
    id: str
    items: List[CartItem]
    total: float
    user_email: str
    status: str = "pending"
`;
    fs.writeFileSync(path.join(appPath, 'app', 'models.py'), modelsCode);

    // app/routes/api.py
    const apiRoutes = this.generateFastAPIRoutes(project);
    fs.writeFileSync(path.join(appPath, 'app', 'routes', 'api.py'), apiRoutes);
    fs.writeFileSync(path.join(appPath, 'app', 'routes', '__init__.py'), '');

    // main.py
    const mainCode = `import sentry_config
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.routes import api

# Initialize Sentry
sentry_config.init_sentry()

app = FastAPI(
    title="${project.project.name} API",
    description="Backend API for ${project.project.name}",
    version="1.0.0"
)

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Configure appropriately for production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routers
app.include_router(api.router, prefix="/api")

@app.get("/")
def read_root():
    return {"message": "Welcome to ${project.project.name} API", "status": "healthy"}

@app.get("/health")
def health_check():
    return {"status": "ok"}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
`;
    fs.writeFileSync(path.join(appPath, 'main.py'), mainCode);

    // README.md
    const readme = this.generatePythonREADME(project, 'FastAPI');
    fs.writeFileSync(path.join(appPath, 'README.md'), readme);
  }

  private generateFlask(appPath: string, project: EngagementSpec): void {
    // requirements.txt
    const requirements = `Flask==3.0.0
Flask-CORS==4.0.0
python-dotenv==1.0.0
sentry-sdk[flask]==1.40.0
`;
    fs.writeFileSync(path.join(appPath, 'requirements.txt'), requirements);

    // .env.example
    const envExample = `SENTRY_DSN=your_sentry_dsn_here
ENVIRONMENT=development
FLASK_ENV=development
`;
    fs.writeFileSync(path.join(appPath, '.env.example'), envExample);

    // sentry_config.py
    const sentryConfig = `import sentry_sdk
from sentry_sdk.integrations.flask import FlaskIntegration
import os
from dotenv import load_dotenv

load_dotenv()

def init_sentry():
    sentry_sdk.init(
        dsn=os.getenv("SENTRY_DSN"),
        environment=os.getenv("ENVIRONMENT", "development"),
        traces_sample_rate=1.0,
        profiles_sample_rate=1.0,
        integrations=[FlaskIntegration()],
    )
`;
    fs.writeFileSync(path.join(appPath, 'sentry_config.py'), sentryConfig);

    // app/__init__.py
    const appInit = `from flask import Flask
from flask_cors import CORS
import sentry_config

def create_app():
    app = Flask(__name__)
    CORS(app)
    
    # Initialize Sentry
    sentry_config.init_sentry()
    
    # Register blueprints
    from app.routes.api import api_bp
    app.register_blueprint(api_bp, url_prefix='/api')
    
    @app.route('/')
    def index():
        return {'message': 'Welcome to ${project.project.name} API', 'status': 'healthy'}
    
    @app.route('/health')
    def health():
        return {'status': 'ok'}
    
    return app
`;
    fs.writeFileSync(path.join(appPath, 'app', '__init__.py'), appInit);

    // app/instrumentation.py
    const backendSpans = project.instrumentation.spans.filter(s => s.layer === 'backend');
    const instrumentationCode = this.generatePythonInstrumentation(backendSpans);
    fs.writeFileSync(path.join(appPath, 'app', 'instrumentation.py'), instrumentationCode);

    // app/routes/__init__.py
    fs.writeFileSync(path.join(appPath, 'app', 'routes', '__init__.py'), '');

    // app/routes/api.py
    const apiRoutes = this.generateFlaskRoutes(project);
    fs.writeFileSync(path.join(appPath, 'app', 'routes', 'api.py'), apiRoutes);

    // run.py
    const runCode = `from app import create_app
import os

app = create_app()

if __name__ == '__main__':
    port = int(os.getenv('PORT', 5000))
    app.run(host='0.0.0.0', port=port, debug=True)
`;
    fs.writeFileSync(path.join(appPath, 'run.py'), runCode);

    // README.md
    const readme = this.generatePythonREADME(project, 'Flask');
    fs.writeFileSync(path.join(appPath, 'README.md'), readme);
  }

  private generatePythonInstrumentation(spans: SpanDefinition[]): string {
    const spanFunctions = spans.map(span => {
      const funcName = span.name.replace(/\./g, '_');
      const attributes = Object.keys(span.attributes)
        .map(key => `        "${key}": ${key}`)
        .join(',\n');

      return `def trace_${funcName}(${Object.keys(span.attributes).join(', ')}):
    """${span.description || `Traces ${span.name} operation`}"""
    with sentry_sdk.start_span(op="${span.op}", description="${span.name}") as span:
${attributes ? `        span.set_data("attributes", {\n${attributes}\n        })` : '        pass'}
        # Add your business logic here
        pass
`;
    }).join('\n\n');

    return `"""
Custom Sentry instrumentation for ${spans.length} backend operations.
Auto-generated from engagement spec.
"""

import sentry_sdk
from functools import wraps

${spanFunctions}

# Example decorator for automatic span creation
def trace_operation(op_name: str):
    """Decorator to automatically create Sentry spans for functions"""
    def decorator(func):
        @wraps(func)
        def wrapper(*args, **kwargs):
            with sentry_sdk.start_span(op=op_name, description=func.__name__):
                return func(*args, **kwargs)
        return wrapper
    return decorator
`;
  }

  private generateFastAPIRoutes(project: EngagementSpec): string {
    return `from fastapi import APIRouter, HTTPException
from app.models import Product, CartItem, Order
from app.instrumentation import trace_operation
import sentry_sdk
from typing import List
import uuid

router = APIRouter()

# Sample data
PRODUCTS = [
    {"id": "1", "name": "Product 1", "price": 29.99, "description": "Sample product 1", "image_url": "/product1.jpg"},
    {"id": "2", "name": "Product 2", "price": 49.99, "description": "Sample product 2", "image_url": "/product2.jpg"},
    {"id": "3", "name": "Product 3", "price": 19.99, "description": "Sample product 3", "image_url": "/product3.jpg"},
]

@router.get("/products", response_model=List[Product])
@trace_operation("api.get_products")
async def get_products():
    """Get all products"""
    return PRODUCTS

@router.get("/products/{product_id}", response_model=Product)
@trace_operation("api.get_product")
async def get_product(product_id: str):
    """Get a single product by ID"""
    product = next((p for p in PRODUCTS if p["id"] == product_id), None)
    if not product:
        raise HTTPException(status_code=404, detail="Product not found")
    return product

@router.post("/checkout")
@trace_operation("api.checkout")
async def checkout(items: List[CartItem], user_email: str):
    """Process checkout"""
    with sentry_sdk.start_span(op="checkout.validate", description="Validate cart items"):
        total = sum(
            item.quantity * next((p["price"] for p in PRODUCTS if p["id"] == item.product_id), 0)
            for item in items
        )
    
    with sentry_sdk.start_span(op="checkout.create_order", description="Create order"):
        order_id = str(uuid.uuid4())
        order = {
            "id": order_id,
            "items": [item.dict() for item in items],
            "total": total,
            "user_email": user_email,
            "status": "completed"
        }
    
    # TODO: Add custom instrumentation based on project notes
    # ${project.project.notes ? `# Project notes: ${project.project.notes}` : ''}
    
    return order

@router.post("/cart/add")
@trace_operation("api.add_to_cart")
async def add_to_cart(item: CartItem):
    """Add item to cart"""
    product = next((p for p in PRODUCTS if p["id"] == item.product_id), None)
    if not product:
        raise HTTPException(status_code=404, detail="Product not found")
    
    return {"message": "Item added to cart", "item": item.dict()}
`;
  }

  private generateFlaskRoutes(project: EngagementSpec): string {
    return `from flask import Blueprint, request, jsonify
from app.instrumentation import trace_operation
import sentry_sdk
import uuid

api_bp = Blueprint('api', __name__)

# Sample data
PRODUCTS = [
    {"id": "1", "name": "Product 1", "price": 29.99, "description": "Sample product 1", "image_url": "/product1.jpg"},
    {"id": "2", "name": "Product 2", "price": 49.99, "description": "Sample product 2", "image_url": "/product2.jpg"},
    {"id": "3", "name": "Product 3", "price": 19.99, "description": "Sample product 3", "image_url": "/product3.jpg"},
]

@api_bp.route('/products', methods=['GET'])
@trace_operation("api.get_products")
def get_products():
    """Get all products"""
    return jsonify(PRODUCTS)

@api_bp.route('/products/<product_id>', methods=['GET'])
@trace_operation("api.get_product")
def get_product(product_id):
    """Get a single product by ID"""
    product = next((p for p in PRODUCTS if p["id"] == product_id), None)
    if not product:
        return jsonify({"error": "Product not found"}), 404
    return jsonify(product)

@api_bp.route('/checkout', methods=['POST'])
@trace_operation("api.checkout")
def checkout():
    """Process checkout"""
    data = request.get_json()
    items = data.get('items', [])
    user_email = data.get('user_email')
    
    with sentry_sdk.start_span(op="checkout.validate", description="Validate cart items"):
        total = sum(
            item['quantity'] * next((p['price'] for p in PRODUCTS if p['id'] == item['product_id']), 0)
            for item in items
        )
    
    with sentry_sdk.start_span(op="checkout.create_order", description="Create order"):
        order_id = str(uuid.uuid4())
        order = {
            "id": order_id,
            "items": items,
            "total": total,
            "user_email": user_email,
            "status": "completed"
        }
    
    # TODO: Add custom instrumentation based on project notes
    # ${project.project.notes ? `# Project notes: ${project.project.notes}` : ''}
    
    return jsonify(order)

@api_bp.route('/cart/add', methods=['POST'])
@trace_operation("api.add_to_cart")
def add_to_cart():
    """Add item to cart"""
    data = request.get_json()
    product_id = data.get('product_id')
    quantity = data.get('quantity', 1)
    
    product = next((p for p in PRODUCTS if p["id"] == product_id), None)
    if not product:
        return jsonify({"error": "Product not found"}), 404
    
    return jsonify({"message": "Item added to cart", "item": {"product_id": product_id, "quantity": quantity}})
`;
  }

  private generatePythonREADME(project: EngagementSpec, framework: string): string {
    const port = framework === 'FastAPI' ? '8000' : '5000';
    const runCommand = framework === 'FastAPI' 
      ? 'uvicorn main:app --reload' 
      : 'python run.py';

    return `# ${project.project.name} - ${framework} Backend

Backend API for ${project.project.name} (${project.project.vertical} demo).

## Tech Stack

- **Framework**: ${framework}
- **Language**: Python 3.9+
- **Observability**: Sentry SDK

## Setup

1. Create a virtual environment:
\`\`\`bash
python -m venv venv
source venv/bin/activate  # On Windows: venv\\Scripts\\activate
\`\`\`

2. Install dependencies:
\`\`\`bash
pip install -r requirements.txt
\`\`\`

3. Configure environment:
\`\`\`bash
cp .env.example .env
# Edit .env and add your Sentry DSN
\`\`\`

## Running the Application

\`\`\`bash
${runCommand}
\`\`\`

The API will be available at http://localhost:${port}

${framework === 'FastAPI' ? '\nAuto-generated API documentation: http://localhost:8000/docs' : ''}

## API Endpoints

- \`GET /\` - Health check
- \`GET /api/products\` - Get all products
- \`GET /api/products/{id}\` - Get product by ID
- \`POST /api/checkout\` - Process checkout
- \`POST /api/cart/add\` - Add item to cart

## Custom Instrumentation

This app includes ${project.instrumentation.spans.filter(s => s.layer === 'backend').length} custom Sentry spans:

${project.instrumentation.spans.filter(s => s.layer === 'backend').map(span => 
  `- **${span.name}**: ${span.description || 'Custom span'}`
).join('\n')}

## Project Notes

${project.project.notes || 'No additional notes'}

## Sentry Dashboard

Import the generated \`sentry-dashboard.json\` to your Sentry organization to visualize the instrumented data.
`;
  }
}
