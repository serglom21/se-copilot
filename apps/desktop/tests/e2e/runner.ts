/**
 * E2E test runner — generates a reference app using Ollama (local LLM),
 * then runs all 5 phases of assertions.
 *
 * Usage:
 *   npm run test:e2e
 *   npm run test:e2e -- --skip-generate   (re-assert on existing artifacts)
 *   npm run test:e2e -- --phases 05       (run only specific phase)
 */
import path from 'path'
import fs from 'fs'
import os from 'os'
import { E2E_OUTPUT_DIR, E2E_PROJECT_SLUG, OLLAMA_LLM_CONFIG } from './fixture'

const SKIP_GENERATE = process.argv.includes('--skip-generate') || process.argv.includes('--no-generate')

async function generate() {
  console.log(`\n🐾 Pawprint E2E — generating reference app`)
  console.log(`   Output: ${E2E_OUTPUT_DIR}`)
  console.log(`   LLM:    ${OLLAMA_LLM_CONFIG.model} @ ${OLLAMA_LLM_CONFIG.baseUrl}`)

  // Dynamically import to avoid Electron-only dep issues at module load
  const { StorageService } = await import('../../electron/services/storage')
  const { LLMService }     = await import('../../electron/services/llm')
  const { GeneratorService } = await import('../../electron/services/generator')

  // StorageService needs a dataDir for project JSON + settings storage.
  // outputDir is always ~/Documents/SE-Copilot-Output/ — we pick slug to control it.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pawprint-e2e-data-'))
  console.log(`   Data:   ${dataDir}`)

  const storage = new StorageService(dataDir)

  // Write Ollama settings so LLMService picks them up via storage.getSettings()
  storage.updateSettings({
    llm: {
      baseUrl: OLLAMA_LLM_CONFIG.baseUrl,
      apiKey: OLLAMA_LLM_CONFIG.apiKey,
      model: OLLAMA_LLM_CONFIG.model,
    },
  } as any)

  // Verify settings round-trip
  const settings = storage.getSettings()
  if (!settings.llm.baseUrl) throw new Error('LLM settings not persisted — check SettingsSchema')

  // Create a valid EngagementSpec (must pass EngagementSpecSchema.parse)
  const now = new Date().toISOString()
  const project = storage.createProject({
    project: {
      name: 'TestCo Payments',
      slug: E2E_PROJECT_SLUG,
      vertical: 'fintech',
      notes: 'B2B payments platform. SMBs use it to send and receive invoices and process card payments. Main flows: create invoice, pay invoice, check payment status.',
      createdAt: now,
      updatedAt: now,
    },
    stack: {
      type: 'web',      // 'web' not 'fullstack' — matches StackConfigSchema enum
      backend: 'express',
      frontend: 'nextjs',
    },
    instrumentation: { transactions: [], spans: [] },
    dashboard: { widgets: [] },
    status: 'draft',
    chatHistory: [],
  } as any)

  console.log(`   Project ID: ${project.id}`)

  // Confirm output path matches E2E_OUTPUT_DIR
  const outputPath = storage.getOutputPath(project.id)
  console.log(`   Storage output: ${outputPath}`)
  if (outputPath !== E2E_OUTPUT_DIR) {
    console.warn(`   ⚠ Output path mismatch: expected ${E2E_OUTPUT_DIR}, got ${outputPath}`)
    console.warn(`     Phase tests will read from ${outputPath}`)
    // Write a pointer file so phase tests can find the actual path
    fs.writeFileSync(
      path.join(os.tmpdir(), 'pawprint-e2e-output-path.txt'),
      outputPath
    )
  }

  const llm = new LLMService(storage)
  const generator = new GeneratorService(storage, llm)

  // Phase 1 — Architect: generate and freeze Trace Topology Contract
  console.log('\n[01] 🐾 Architect: generating Trace Topology Contract...')
  let contract
  try {
    contract = await llm.generateTraceTopologyContract(project, outputPath)
    console.log(`     ✓ Contract frozen — ${contract.spans.length} spans, ${contract.transactions.length} transactions`)
    contract.spans.forEach(s => console.log(`       ${s.layer === 'frontend' ? '🖥' : '⚙'} ${s.name} (${s.op})`))
  } catch (err: any) {
    throw new Error(`Contract generation failed: ${err.message}`)
  }

  // Rebuild project spec with contract spans for generator
  const specWithContract = {
    ...project,
    instrumentation: {
      transactions: contract.transactions.map((t: any) => t.name),
      spans: contract.spans.map((s: any) => ({
        name: s.name,
        op: s.op,
        layer: s.layer,
        description: s.description,
        attributes: {},
        pii: { keys: [] },
      })),
    },
  }

  // Phases 2–4 — Generate reference app (frontend + backend + static validation)
  console.log('\n[02-04] 🐾 Generating reference app...')
  const result = await generator.generateReferenceApp(
    specWithContract as any,
    (pct, label) => process.stdout.write(`\r     ${pct}% — ${label}                    `),
    (line) => process.stdout.write(line)
  )

  console.log('\n')
  if (!result.success) {
    throw new Error(`Generation failed: ${result.error}`)
  }
  console.log(`     ✓ Reference app at: ${result.outputPath}`)

  // Clean up temp data dir
  try { fs.rmSync(dataDir, { recursive: true, force: true }) } catch {}
}

async function main() {
  if (SKIP_GENERATE) {
    console.log(`🐾 Skipping generation — asserting on existing artifacts at:\n   ${E2E_OUTPUT_DIR}`)
    if (!fs.existsSync(E2E_OUTPUT_DIR)) {
      console.error(`❌ Output dir not found: ${E2E_OUTPUT_DIR}`)
      process.exit(1)
    }
  } else {
    await generate()
  }
}

main().catch(err => {
  console.error('\n❌ E2E runner failed:', err.message ?? err)
  if (err.stack) console.error(err.stack)
  process.exit(1)
})
