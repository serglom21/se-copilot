/**
 * Phase 03 — Build assertions
 * Runs npm install + build checks on both frontend and backend.
 */
import { describe, test, expect, beforeAll } from 'vitest'
import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { E2E_OUTPUT_DIR } from '../fixture'

let appPath: string

beforeAll(() => {
  appPath = path.join(E2E_OUTPUT_DIR, 'reference-app')
  if (!fs.existsSync(appPath)) throw new Error('reference-app not found — run generation first')
})

function runCmd(cmd: string, cwd: string): { success: boolean; output: string } {
  try {
    const output = execSync(cmd, { cwd, encoding: 'utf8', timeout: 120000, stdio: 'pipe' })
    return { success: true, output }
  } catch (err: any) {
    return { success: false, output: err.stdout + err.stderr }
  }
}

describe('Phase 03 — Build', () => {
  test('frontend package.json exists', () => {
    expect(fs.existsSync(path.join(appPath, 'frontend', 'package.json'))).toBe(true)
  })

  test('backend package.json exists', () => {
    expect(fs.existsSync(path.join(appPath, 'backend', 'package.json'))).toBe(true)
  })

  test('frontend npm install succeeds', () => {
    const result = runCmd('npm install --prefer-offline', path.join(appPath, 'frontend'))
    expect(result.success, result.output.slice(-500)).toBe(true)
  }, 120000)

  test('backend npm install succeeds', () => {
    const result = runCmd('npm install --prefer-offline', path.join(appPath, 'backend'))
    expect(result.success, result.output.slice(-500)).toBe(true)
  }, 120000)

  test('backend TypeScript compiles without errors', () => {
    const result = runCmd('npx tsc --noEmit', path.join(appPath, 'backend'))
    expect(result.success, `TypeScript errors:\n${result.output.slice(-1000)}`).toBe(true)
  }, 60000)

  test('frontend next build succeeds', () => {
    const result = runCmd('npx next build', path.join(appPath, 'frontend'))
    expect(result.success, `Build errors:\n${result.output.slice(-1500)}`).toBe(true)
  }, 180000)
})
