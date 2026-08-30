import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

export interface VideoFixture {
  path: string
  contentType: 'video/mp4'
  sizeBytes: number
  cleanup: () => Promise<void>
}

export interface VideoFixtureOptions {
  ffmpegPath?: string
  durationSeconds?: number
}

function runFfmpeg(ffmpegPath: string, outputPath: string, durationSeconds: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=black:s=160x90:r=24',
      '-t',
      String(durationSeconds),
      '-an',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      '-y',
      outputPath,
    ])
    let error = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      error += chunk
    })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg failed with exit code ${code}: ${error.trim()}`))
    })
  })
}

/** Creates a small, deterministic MP4 in a private temporary directory. */
export async function generateMp4Fixture(options: VideoFixtureOptions = {}): Promise<VideoFixture> {
  const durationSeconds = options.durationSeconds ?? 1
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error('durationSeconds must be a positive number')
  }

  const directory = await mkdtemp(join(tmpdir(), 'streaming-video-e2e-'))
  const path = join(directory, 'fixture.mp4')
  try {
    await runFfmpeg(options.ffmpegPath ?? process.env.FFMPEG_PATH ?? 'ffmpeg', path, durationSeconds)
    const sizeBytes = (await stat(path)).size
    return {
      path,
      contentType: 'video/mp4',
      sizeBytes,
      cleanup: () => rm(directory, { recursive: true, force: true }),
    }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

/** Runs a scenario with a fixture and guarantees removal when it finishes. */
export async function withMp4Fixture<T>(
  callback: (fixture: VideoFixture) => Promise<T>,
  options: VideoFixtureOptions = {},
): Promise<T> {
  const fixture = await generateMp4Fixture(options)
  try {
    return await callback(fixture)
  } finally {
    await fixture.cleanup()
  }
}
