import { test } from '@playwright/test'
import { assertReliabilityAuthorization } from '../config.js'

test.describe('@reliability', () => {
  test('requires explicit disposable runtime authorization', () => {
    assertReliabilityAuthorization()
  })
})
