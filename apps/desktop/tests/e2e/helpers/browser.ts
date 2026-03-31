import puppeteer, { Browser, Page } from 'puppeteer'

let _browser: Browser | null = null

export async function launchBrowser(): Promise<Browser> {
  _browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  })
  return _browser
}

export async function closeBrowser(): Promise<void> {
  await _browser?.close()
  _browser = null
}

/**
 * Navigate to a URL, wait for Sentry SDK to initialize, run actions, then flush.
 * Use this for ALL tests that assert on traces — never use a fixed sleep.
 */
export async function runPageWithSentryFlush(
  page: Page,
  url: string,
  actions: (page: Page) => Promise<void>
): Promise<void> {
  await page.goto(url, { waitUntil: 'networkidle0' })

  // Poll for SDK — never sleep
  const sdkReady = await page.waitForFunction(
    () => {
      const sentry = (window as any).__SENTRY__
      return sentry && sentry.hub && typeof sentry.hub.getClient === 'function' && sentry.hub.getClient() !== undefined
    },
    { timeout: 10000 }
  ).then(() => true).catch(() => false)

  if (!sdkReady) {
    console.warn(`[browser] Sentry SDK not detected on ${url} — traces may be incomplete`)
  }

  await actions(page)

  // Wait for network activity from actions to settle
  await page.waitForNetworkIdle({ idleTime: 500, timeout: 5000 }).catch(() => {})

  // Flush — MUST use page.evaluate, not setTimeout
  const flushed = await page.evaluate(() => {
    const win = window as any
    if (win.Sentry?.flush) return win.Sentry.flush(4000).then(() => true)
    return Promise.resolve(false)
  }).catch(() => false)

  if (!flushed) {
    console.warn(`[browser] Sentry.flush() not available — traces may be dropped`)
  }

  // Buffer for proxy to receive envelopes over HTTP
  await new Promise(r => setTimeout(r, 500))
}
