// @ts-check
import { assertLiveBoundary, checkSettings, validateSettings } from './safety.mjs'

// Local, bounded Python bridge. Never imports Playwright or a live adapter.
try {
  const mode = process.argv[2]
  if (mode === 'check') {
    console.log(JSON.stringify(checkSettings(process.env)))
  } else if (mode === 'validate') {
    validateSettings(process.env, true)
    console.log(JSON.stringify({ configured: true }))
  } else if (mode === 'authorize' || mode === 'preflight') {
    const evidence = assertLiveBoundary()
    console.log(JSON.stringify(evidence))
  } else {
    throw new Error('unknown safety validation mode')
  }
} catch (error) {
  console.log(JSON.stringify({ error: error instanceof Error ? error.message : 'safety validation failed' }))
  process.exitCode = 2
}
