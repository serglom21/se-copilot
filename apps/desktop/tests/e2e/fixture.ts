import path from 'path'
import os from 'os'

// StorageService always writes to ~/Documents/SE-Copilot-Output/{slug}
// Use a fixed slug so the output path is deterministic across runner + phase tests
export const E2E_PROJECT_SLUG = 'testco-e2e'
export const E2E_OUTPUT_DIR = path.join(
  os.homedir(),
  'Documents',
  'SE-Copilot-Output',
  E2E_PROJECT_SLUG
)

/** Ollama local LLM config — used for E2E generation without hitting production APIs */
export const OLLAMA_LLM_CONFIG = {
  baseUrl: 'http://127.0.0.1:11434/v1',
  apiKey: 'ollama',   // Ollama ignores this but the field is required
  model: 'qwen2.5-coder:7b',
}

export const E2E_FRONTEND_PORT = 13000
export const E2E_BACKEND_PORT  = 13001
export const E2E_PROXY_PORT    = 13999
