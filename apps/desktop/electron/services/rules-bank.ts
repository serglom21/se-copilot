import fs from 'fs';
import os from 'os';
import path from 'path';

export type RuleCategory =
  | 'orphan_spans'
  | 'fe_be_connection'
  | 'custom_spans'
  | 'widget_data'
  | 'span_gaps'
  | 'span_timing'
  | 'span_naming'
  | 'attribute_completeness'
  | 'transaction_completeness'
  | 'general';

export type RuleAppliesTo = 'generation' | 'flows' | 'dashboard' | 'instrumentation';

export interface TrainingRule {
  id: string;
  category: RuleCategory;
  title: string;
  rule: string;
  discoveredFrom?: string; // spec slug
  createdAt: string;
  applyTo: RuleAppliesTo[];
  timesApplied: number;
}

export class RulesBankService {
  private rulesPath: string;
  private backupJsonPath: string;
  private backupMdPath: string;

  constructor(dataDir: string, backupDir?: string) {
    this.rulesPath = path.join(dataDir, 'training-rules.json');

    // Default backup location: ~/Documents/SE Copilot/ — outside app userData,
    // survives app reinstalls and crashes, easy to inspect / commit to git.
    const bDir = backupDir || path.join(os.homedir(), 'Documents', 'SE Copilot');
    this.backupJsonPath = path.join(bDir, 'training-rules.json');
    this.backupMdPath = path.join(bDir, 'training-rules.md');
  }

  // ── Read ─────────────────────────────────────────────────────────────────

  listRules(): TrainingRule[] {
    // Try primary location first
    if (fs.existsSync(this.rulesPath)) {
      try {
        const rules = JSON.parse(fs.readFileSync(this.rulesPath, 'utf-8')) as TrainingRule[];
        if (Array.isArray(rules) && rules.length > 0) return rules;
      } catch { /* fall through to backup */ }
    }
    // Primary missing, empty, or corrupt — try to restore from backup
    return this.restoreFromBackup();
  }

  private restoreFromBackup(): TrainingRule[] {
    if (!fs.existsSync(this.backupJsonPath)) return [];
    try {
      const rules = JSON.parse(fs.readFileSync(this.backupJsonPath, 'utf-8')) as TrainingRule[];
      if (Array.isArray(rules) && rules.length > 0) {
        // Write back to primary so future reads are fast
        this.writePrimary(rules);
        console.log(`[RulesBank] Restored ${rules.length} rule(s) from backup at ${this.backupJsonPath}`);
        return rules;
      }
    } catch { /* backup also corrupt */ }
    return [];
  }

  // ── Write ────────────────────────────────────────────────────────────────

  addRule(rule: Omit<TrainingRule, 'id' | 'createdAt' | 'timesApplied'>): TrainingRule {
    const rules = this.listRules();
    const existing = rules.find(
      r => r.category === rule.category && r.title.toLowerCase() === rule.title.toLowerCase()
    );
    if (existing) {
      if (rule.discoveredFrom && !existing.rule.includes(rule.discoveredFrom)) {
        existing.rule = existing.rule + ` (also seen in: ${rule.discoveredFrom})`;
        existing.timesApplied += 1;
        this.persist(rules);
      }
      return existing;
    }
    const newRule: TrainingRule = {
      ...rule,
      id: `rule-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      createdAt: new Date().toISOString(),
      timesApplied: 0,
    };
    rules.push(newRule);
    this.persist(rules);
    return newRule;
  }

  removeRule(id: string): void {
    this.persist(this.listRules().filter(r => r.id !== id));
  }

  clearAll(): void {
    this.persist([]);
  }

  // ── Prompt injection ──────────────────────────────────────────────────────

  getRulesForPrompt(applyTo: RuleAppliesTo): string {
    const rules = this.listRules().filter(r => r.applyTo.includes(applyTo));
    if (rules.length === 0) return '';
    const lines = rules.map(r => `- [${r.category.toUpperCase()}] ${r.rule}`);
    return `\n\n## LEARNED RULES FROM TRAINING (MUST FOLLOW — these come from real failures)\n${lines.join('\n')}`;
  }

  // ── Persistence helpers ───────────────────────────────────────────────────

  /**
   * Write to primary and both backup files atomically (best-effort for backup).
   */
  private persist(rules: TrainingRule[]): void {
    this.writePrimary(rules);
    this.writeBackup(rules);
  }

  private writePrimary(rules: TrainingRule[]): void {
    fs.writeFileSync(this.rulesPath, JSON.stringify(rules, null, 2));
  }

  private writeBackup(rules: TrainingRule[]): void {
    try {
      const bDir = path.dirname(this.backupJsonPath);
      if (!fs.existsSync(bDir)) fs.mkdirSync(bDir, { recursive: true });
      fs.writeFileSync(this.backupJsonPath, JSON.stringify(rules, null, 2));
      fs.writeFileSync(this.backupMdPath, this.toMarkdown(rules));
    } catch (e: any) {
      // Non-fatal — primary write already succeeded
      console.warn('[RulesBank] Backup write failed (non-fatal):', e.message);
    }
  }

  // ── Markdown export ───────────────────────────────────────────────────────

  private toMarkdown(rules: TrainingRule[]): string {
    const byCategory = new Map<RuleCategory, TrainingRule[]>();
    for (const r of rules) {
      if (!byCategory.has(r.category)) byCategory.set(r.category, []);
      byCategory.get(r.category)!.push(r);
    }

    const categoryLabels: Record<RuleCategory, string> = {
      orphan_spans: 'Orphan Spans',
      fe_be_connection: 'Frontend → Backend Connection',
      custom_spans: 'Custom Span Coverage',
      widget_data: 'Dashboard Widget Data',
      span_gaps: 'Span Duration Gaps',
      span_timing: 'Span Timing Integrity',
      span_naming: 'Span Naming Conventions',
      attribute_completeness: 'Attribute Completeness',
      transaction_completeness: 'Transaction Structure',
      general: 'General',
    };

    const lines: string[] = [
      '# SE Copilot — Training Rules',
      '',
      `> **Last updated:** ${new Date().toUTCString()}  `,
      `> **Total rules:** ${rules.length}`,
      '',
      '---',
      '',
      'These rules are learned automatically during training runs. They are injected into',
      'LLM prompts when generating reference apps so each run benefits from past failures.',
      '',
    ];

    for (const [category, catRules] of byCategory) {
      lines.push(`## ${categoryLabels[category] || category}`);
      lines.push('');
      for (const r of catRules) {
        lines.push(`### ${r.title}`);
        lines.push('');
        lines.push(r.rule);
        lines.push('');
        lines.push(`| Field | Value |`);
        lines.push(`|-------|-------|`);
        lines.push(`| Applies to | \`${r.applyTo.join('`, `')}\` |`);
        lines.push(`| First seen | ${r.discoveredFrom || '—'} |`);
        lines.push(`| Created | ${new Date(r.createdAt).toUTCString()} |`);
        lines.push(`| Times reinforced | ${r.timesApplied} |`);
        lines.push('');
      }
    }

    return lines.join('\n');
  }
}
