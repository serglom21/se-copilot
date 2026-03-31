// validation-logger.ts — Logging contract for the build validation pipeline.
// Every step must call startStep() before doing work and completeStep() or failStep()
// when done. printSummary() is always called at the end regardless of outcome —
// it surfaces any step that started but never completed, making silent failures visible.

type OnOutput = (line: string) => void;

export interface ValidationStep {
  layer: string;
  description: string;
  startedAt: number;
  completedAt?: number;
  outcome: 'passed' | 'failed' | 'warned' | 'skipped' | null;
  summary?: string;
  detail: string[];
}

export interface ValidationSummary {
  passed: boolean;
  failedCount: number;
  warnedCount: number;
  incompleteCount: number;
}

export class ValidationLogger {
  private steps: ValidationStep[] = [];
  private currentStep: ValidationStep | null = null;

  constructor(private readonly onOutput: OnOutput) {}

  startStep(layer: string, description: string): void {
    this.currentStep = {
      layer,
      description,
      startedAt: Date.now(),
      outcome: null,
      detail: [],
    };
    this.steps.push(this.currentStep);
    this.emit(`\n${layer}: ${description}`);
  }

  detail(message: string): void {
    if (!this.currentStep) return;
    this.currentStep.detail.push(message);
    this.emit(`   ${message}`);
  }

  completeStep(outcome: 'passed' | 'failed' | 'warned' | 'skipped', summary: string): void {
    if (!this.currentStep) return;
    this.currentStep.outcome = outcome;
    this.currentStep.completedAt = Date.now();
    this.currentStep.summary = summary;
    const icon = { passed: '✓', failed: '✗', warned: '⚠', skipped: '–' }[outcome];
    this.emit(`${icon} ${this.currentStep.layer}: ${summary}`);
    this.currentStep = null;
  }

  // Called if a step throws before completing — ensures no step ends silently
  failStep(error: Error): void {
    if (!this.currentStep) return;
    this.completeStep('failed', `Threw unexpectedly: ${error.message}`);
  }

  // Always call this at the end of validateGeneratedApp() regardless of outcome.
  // Surfaces any step that started but never completed — these are silent-failure bugs.
  printSummary(): ValidationSummary {
    const passed = this.steps.filter(s => s.outcome === 'passed').length;
    const failed = this.steps.filter(s => s.outcome === 'failed').length;
    const warned = this.steps.filter(s => s.outcome === 'warned').length;
    const incomplete = this.steps.filter(s => s.outcome === null);

    this.emit('\n━━━ Build validation summary ━━━');
    for (const s of this.steps) {
      const icon = { passed: '✓', failed: '✗', warned: '⚠', skipped: '–', null: '?' }[s.outcome ?? 'null'] ?? '?';
      const dur = s.completedAt
        ? `${((s.completedAt - s.startedAt) / 1000).toFixed(1)}s`
        : 'did not complete';
      const layer = s.layer.padEnd(14);
      const summary = (s.summary ?? 'no outcome recorded').padEnd(50);
      this.emit(`  ${icon} ${layer} ${summary} ${dur}`);
    }

    if (incomplete.length > 0) {
      this.emit('');
      this.emit(`⚠ ${incomplete.length} step(s) started but never completed:`);
      for (const s of incomplete) {
        this.emit(`  – ${s.layer}: ${s.description}`);
      }
      this.emit(`  This is a bug in the generator — every startStep() must be paired with completeStep() or failStep()`);
    }

    this.emit('');
    if (failed > 0) {
      this.emit(`Result: ✗ FAILED — ${failed} layer(s) failed, ${warned} warning(s)`);
    } else if (warned > 0) {
      this.emit(`Result: ⚠ PASSED WITH WARNINGS — ${warned} warning(s), proceeding`);
    } else {
      this.emit(`Result: ✓ PASSED — all ${passed} layers healthy`);
    }

    return { passed: failed === 0, failedCount: failed, warnedCount: warned, incompleteCount: incomplete.length };
  }

  private emit(message: string): void {
    this.onOutput(message + '\n');
  }
}
