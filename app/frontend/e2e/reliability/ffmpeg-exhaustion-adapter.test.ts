import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DockerFfmpegExhaustionAdapter } from './ffmpeg-exhaustion-adapter.js'
import { duplicateTarget } from './duplicate-driver.js'

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }))
afterEach(() => vi.resetAllMocks())

const target = duplicateTarget('e2e-11111111-1111-4111-8111-111111111111')
class FakeAdapter extends DockerFfmpegExhaustionAdapter {
  calls: string[][] = []
  statements: string[] = []
  output: unknown = {}
  owned = true
  constructor() {
    super(
      { workerSettings: { attempts: 5, retry: 900 } } as ConstructorParameters<
        typeof DockerFfmpegExhaustionAdapter
      >[0],
      {
        E2E_FFMPEG_INVALID_FIXTURE: resolve('invalid.mp4'),
        E2E_DUPLICATE_FIXTURE: resolve('valid.mp4'),
        E2E_UPLOAD_TIMEOUT_MS: '123000',
        AWS_REGION: 'us-east-1',
        E2E_PROCESSING_TIMEOUT_MS: '300000',
        E2E_VISIBILITY_TIMEOUT_MS: '150000',
        E2E_NAVIGATION_TIMEOUT_MS: '30000',
        E2E_DLQ_TIMEOUT_MS: '900000',
        E2E_SOURCE_BUCKET: 'input',
        E2E_OUTPUT_BUCKET: 'output',
        E2E_AWS_ACCOUNT_ID: '123456789012',
      },
    )
    this.target = target
  }
  protected override unchanged() {}
  protected override sql(query: string) {
    this.statements.push(query)
    // Model psql's scalar output: only a JSON-producing SELECT is parseable.
    return query.startsWith('SELECT')
      ? JSON.parse(
          query.includes('json_build_object')
            ? JSON.stringify({ status: 'FAILED', owned: this.owned })
            : 'FAILED',
        )
      : null
  }
  protected override executeAws(args: string[]) {
    this.calls.push(args)
    return args.includes('list-objects-v2') ? this.output : {}
  }
}

describe('FFmpeg upload through the common transport', () => {
  it('uploads the invalid fixture using the configured timeout and host AWS settings', async () => {
    vi.mocked(execFileSync).mockReturnValue('{}')
    await new FakeAdapter().uploadInvalidMedia()
    expect(execFileSync).toHaveBeenCalledExactlyOnceWith(
      'aws',
      [
        's3api',
        'put-object',
        '--bucket',
        'input',
        '--key',
        target.sourceKey,
        '--body',
        resolve('invalid.mp4'),
        '--content-type',
        'video/mp4',
        '--expected-bucket-owner',
        '123456789012',
        '--region',
        'us-east-1',
        '--output',
        'json',
      ],
      expect.objectContaining({
        timeout: 123000,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: expect.objectContaining({
          AWS_REGION: 'us-east-1',
          AWS_PAGER: '',
          AWS_CLI_AUTO_PROMPT: 'off',
        }),
      }),
    )
  })

  it.each([
    [{ code: 'ETIMEDOUT', stderr: 'private-value' }, 'timeout'],
    [{ stderr: 'AccessDenied private-value' }, 'access_denied'],
    [{ stderr: 'Error parsing parameter --body private-value' }, 'file_read'],
  ])('preserves a safe cause without exposing raw errors (%s)', async (failure, category) => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw failure
    })
    const error = await new FakeAdapter().uploadInvalidMedia().catch((error: Error) => error)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('Upload outcome uncertain; retain run resources.')
    expect((error as Error).message).toContain(`[${category}]`)
    expect((error as Error).message).not.toContain('private-value')
  })

  it('classifies malformed upload responses', async () => {
    vi.mocked(execFileSync).mockReturnValue('private-invalid-json')
    await expect(new FakeAdapter().uploadInvalidMedia()).rejects.toThrow('[invalid_response]')
  })
})

describe('FFmpeg cleanup', () => {
  it('parses FAILED ownership and deletes only the run source and output', async () => {
    const adapter = new FakeAdapter()
    adapter.output = { Contents: [{ Key: target.prefix + 'hls/segment-00001.ts' }] }
    await adapter.cleanup()
    expect(
      adapter.calls
        .filter((c) => c.includes('delete-object'))
        .map((c) => c[c.indexOf('--key') + 1]),
    ).toEqual([target.sourceKey, target.prefix + 'hls/segment-00001.ts'])
    expect(adapter.statements.at(-1)).toContain(`file_name='${target.runId}.mp4'`)
  })
  it('retains resources if ownership or the complete deletion set is uncertain', async () => {
    for (const output of [{ IsTruncated: true }, { Contents: [{ Key: 'unrelated' }] }]) {
      const adapter = new FakeAdapter()
      adapter.output = output
      await expect(adapter.cleanup()).rejects.toThrow('manual cleanup')
      expect(adapter.calls.some((c) => c.includes('delete-object'))).toBe(false)
    }
    const adapter = new FakeAdapter()
    adapter.owned = false
    await expect(adapter.cleanup()).rejects.toThrow('not safe')
    expect(adapter.calls).toEqual([])
  })
})
