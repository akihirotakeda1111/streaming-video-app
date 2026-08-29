import { test, expect, type Page, type APIRequestContext, type TestInfo } from '@playwright/test'
import { e2eConfig } from './config.js'
import { attachSafeDiagnostic, redactText } from './diagnostics.js'
import { withMp4Fixture, type VideoFixture } from './fixtures.js'

async function verifyDependency(
  testInfo: TestInfo,
  dependency: string,
  check: () => Promise<void>,
): Promise<void> {
  try {
    await check()
  } catch (error) {
    const message = redactText(error instanceof Error ? error.message : String(error))
    await attachSafeDiagnostic(testInfo, `${dependency}-failure`, { dependency, message })
    throw new Error(`${dependency} unavailable: ${message}`)
  }
}

async function verifyFrontend(request: APIRequestContext): Promise<void> {
  const response = await request.get(`${e2eConfig.frontendUrl}/`, {
    timeout: e2eConfig.timeouts.navigation,
  })
  if (!response.ok()) throw new Error(`frontend returned HTTP ${response.status()}`)
}

async function verifyBrowser(page: Page): Promise<void> {
  await page.goto('/')
  await expect(page.locator('h1')).toHaveText('You did it!')
}

async function verifyApi(request: APIRequestContext): Promise<void> {
  const response = await request.get(`${e2eConfig.apiUrl}/api/v1/health`, {
    timeout: e2eConfig.timeouts.navigation,
  })
  if (!response.ok()) throw new Error(`health returned HTTP ${response.status()}`)

  const body = (await response.json()) as { status?: unknown }
  if (body.status !== 'ok') throw new Error('health response was not ok')
}

test.describe('@preflight', () => {
  test('verifies frontend, API, browser, and FFmpeg readiness', async ({ page, request }, testInfo) => {
    await test.step('frontend reachability', () => verifyDependency(testInfo, 'frontend', () => verifyFrontend(request)))
    await test.step('browser operation', () => verifyDependency(testInfo, 'browser', () => verifyBrowser(page)))
    await test.step('side-effect-free API health', () => verifyDependency(testInfo, 'API', () => verifyApi(request)))
    await test.step('local FFmpeg fixture capability', () =>
      verifyDependency(testInfo, 'FFmpeg', async () => {
        await withMp4Fixture(async (fixture: VideoFixture) => {
          expect(fixture.contentType).toBe('video/mp4')
          expect(fixture.sizeBytes).toBeGreaterThan(0)
        })
      }),
    )
  })
})
