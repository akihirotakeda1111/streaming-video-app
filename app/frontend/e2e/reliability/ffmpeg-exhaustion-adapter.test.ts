import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DockerFfmpegExhaustionAdapter } from './ffmpeg-exhaustion-adapter.js'
import { duplicateTarget } from './duplicate-driver.js'

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
