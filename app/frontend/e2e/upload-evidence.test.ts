import { describe, expect, it } from 'vitest'
import { isSolePutToTarget, putDestinations } from './upload-evidence.js'

const target = { origin: 'https://bucket.s3.amazonaws.com', path: '/videos/vid/jobs/jid/source.mp4' }
const s3Url = 'https://bucket.s3.amazonaws.com/videos/vid/jobs/jid/source.mp4?X-Amz-Signature=secret'
const apiUrl = 'https://api.example/api/v1/videos'
const viteUrl = 'http://127.0.0.1:5173/upload'

describe('direct-upload PUT destinations', () => {
  it('accepts exactly one PUT to the API-provided URL', () => {
    const destinations = putDestinations([s3Url])
    expect(destinations).toEqual([target])
    expect(isSolePutToTarget(destinations, target)).toBe(true)
  })

  it('fails when the same file is also sent to the API', () => {
    const destinations = putDestinations([s3Url, apiUrl])
    expect(destinations).toEqual([target, { origin: 'https://api.example', path: '/api/v1/videos' }])
    expect(isSolePutToTarget(destinations, target)).toBe(false)
  })

  it('fails when the same file is also sent to Vite', () => {
    const destinations = putDestinations([s3Url, viteUrl])
    expect(destinations).toEqual([target, { origin: 'http://127.0.0.1:5173', path: '/upload' }])
    expect(isSolePutToTarget(destinations, target)).toBe(false)
  })

  it('fails when two PUTs both target the API-provided URL', () => {
    expect(isSolePutToTarget(putDestinations([s3Url, s3Url]), target)).toBe(false)
  })

  it('fails when the only PUT is to the API or Vite origin', () => {
    expect(isSolePutToTarget(putDestinations([apiUrl]), target)).toBe(false)
    expect(isSolePutToTarget(putDestinations([viteUrl]), target)).toBe(false)
  })
})
