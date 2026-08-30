import { describe, expect, it } from 'vitest'
import { urlEvidence } from './url-evidence.js'

describe('URL evidence', () => {
  it('keeps HTTP origin and path without query credentials', () => {
    expect(urlEvidence('https://storage.example/video.mp4?token=secret#fragment')).toEqual({
      origin: 'https://storage.example',
      path: '/video.mp4',
    })
  })

  it('accepts blob URLs emitted by browser media playback', () => {
    expect(urlEvidence('blob:http://localhost:5173/media-source')).toEqual({
      origin: 'http://localhost:5173',
      path: 'http://localhost:5173/media-source',
    })
  })
})
