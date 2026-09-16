import { describe, expect, it } from 'vitest'
import { validateDeliveryBucketPolicy, validateDeliveryErrorCaching } from './delivery-policy.js'
const arn = 'arn:aws:cloudfront::123456789012:distribution/test'
const grant = () => ({ Effect: 'Allow', Principal: { Service: 'cloudfront.amazonaws.com' },
  Action: 's3:GetObject', Resource: 'arn:aws:s3:::output/videos/*/jobs/*/hls/*',
  Condition: { StringEquals: { 'AWS:SourceArn': arn } } })

describe('delivery bucket grant', () => {
  it('accepts the Terraform grant, array values, and non-granting Deny statements', () => {
    validateDeliveryBucketPolicy({ Statement: [grant(), { Effect: 'Deny', Principal: '*' }] }, 'output', arn)
    validateDeliveryBucketPolicy({ Statement: { ...grant(), Action: ['s3:GetObject'] } }, 'output', arn)
  })
  it('rejects wrong effect, action, resource, source and additional broad grants', () => {
    for (const changed of [
      { Effect: 'Deny' }, { Action: 's3:ListBucket' }, { Action: 's3:*' },
      { Resource: 'arn:aws:s3:::output/*' }, { Resource: 'arn:aws:s3:::other/videos/*/jobs/*/hls/*' },
      { Condition: {} }, { Condition: { StringEquals: { 'AWS:SourceArn': [arn, 'other'] } } },
      { Principal: '*' }, { Principal: { AWS: '*' } }, { NotAction: 's3:DeleteObject' },
    ]) {
      expect(() => validateDeliveryBucketPolicy({ Statement: [{ ...grant(), ...changed }] }, 'output', arn)).toThrow()
    }
    expect(() => validateDeliveryBucketPolicy({ Statement: [grant(), { ...grant(), Condition: {} }] }, 'output', arn)).toThrow()
    expect(() => validateDeliveryBucketPolicy({ Statement: [{ ...grant(), Effect: 'Deny' },
      { ...grant(), Condition: {} }] }, 'output', arn)).toThrow()
  })
})
it('accepts empty custom response fields returned by CloudFront', () => {
  validateDeliveryErrorCaching({ Quantity: 2, Items: [403, 404].map(ErrorCode => ({
    ErrorCode, ResponsePagePath: '', ResponseCode: '', ErrorCachingMinTTL: 0,
  })) })
})
it('requires explicit zero error TTLs and rejects response rewriting or malformed fields', () => {
  const Items = [403, 404].map(ErrorCode => ({ ErrorCode, ErrorCachingMinTTL: 0 }))
  validateDeliveryErrorCaching({ Items })
  for (const value of [{}, { Items: Items.slice(1) }, { Items: [...Items, Items[0]] },
    { Items: Items.map(item => ({ ...item, ErrorCachingMinTTL: 60 })) },
    { Items: Items.map(item => ({ ...item, ErrorCachingMinTTL: undefined })) },
    ...['ResponseCode', 'ResponsePagePath'].flatMap(field =>
      ['200', '/error.html', ' ', null, false, 0].map(value => ({
        Items: Items.map(item => ({ ...item, [field]: value })),
      }))),
  ]) {
    expect(() => validateDeliveryErrorCaching(value)).toThrow()
  }
})
