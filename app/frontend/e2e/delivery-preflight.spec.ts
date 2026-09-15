import { execFileSync } from 'node:child_process'
import { test, expect } from '@playwright/test'
import { normalizePlaybackBaseURL } from '../../scripts/generate_reliability_env.mjs'
import { e2eConfig } from './config.js'
import { persistPlaybackEvidence } from './playback-evidence.js'

function aws(args: string[]): unknown {
  const region = process.env.AWS_REGION?.trim()
  if (!region) throw new Error('AWS_REGION is required for delivery preflight')
  const output = execFileSync('aws', [...args, '--region', region, '--output', 'json'], {
    encoding: 'utf8', timeout: 10_000, maxBuffer: 2 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, AWS_EC2_METADATA_DISABLED: 'true', AWS_PAGER: '', AWS_CLI_AUTO_PROMPT: 'off' },
  })
  return JSON.parse(output || '{}')
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('AWS response was not an object')
  return value as Record<string, unknown>
}

test.describe('@preflight @delivery-preflight', () => {
  test('verifies private output bucket, deployed distribution, OAC, and frontend CORS policy', async () => {
    const playback = new URL(normalizePlaybackBaseURL(process.env.PLAYBACK_BASE_URL ?? ''))
    const bucket = process.env.E2E_OUTPUT_BUCKET?.trim()
    const account = process.env.E2E_AWS_ACCOUNT_ID?.trim()
    if (!bucket || !account) throw new Error('dedicated output bucket and account are required')

    const list = record(aws(['cloudfront', 'list-distributions']))
    const distributionList = record(list.DistributionList)
    const items = Array.isArray(distributionList.Items) ? distributionList.Items.map(record) : []
    const matches = items.filter((item) => item.DomainName === playback.hostname)
    expect(matches, 'PLAYBACK_BASE_URL must identify exactly one distribution').toHaveLength(1)
    const id = matches[0]?.Id
    expect(typeof id).toBe('string')

    const observed = record(aws(['cloudfront', 'get-distribution', '--id', String(id)]))
    const distribution = record(observed.Distribution)
    const config = record(distribution.DistributionConfig)
    expect(distribution.Status).toBe('Deployed')
    expect(config.Enabled).toBe(true)
    const origins = record(config.Origins)
    const originItems = Array.isArray(origins.Items) ? origins.Items.map(record) : []
    expect(originItems).toHaveLength(1)
    const origin = originItems[0]!
    expect(origin.DomainName).toBe(`${bucket}.s3.${process.env.AWS_REGION}.amazonaws.com`)
    expect(origin.OriginAccessControlId).toBeTruthy()

    const oacResult = record(aws(['cloudfront', 'get-origin-access-control', '--id', String(origin.OriginAccessControlId)]))
    const oac = record(oacResult.OriginAccessControl)
    const oacConfig = record(oac.OriginAccessControlConfig)
    expect(oacConfig.OriginAccessControlOriginType).toBe('s3')
    expect(oacConfig.SigningBehavior).toBe('always')
    expect(oacConfig.SigningProtocol).toBe('sigv4')

    const bpa = record(record(aws(['s3api', 'get-public-access-block', '--bucket', bucket])).PublicAccessBlockConfiguration)
    for (const setting of ['BlockPublicAcls', 'IgnorePublicAcls', 'BlockPublicPolicy', 'RestrictPublicBuckets']) {
      expect(bpa[setting]).toBe(true)
    }
    const policyResult = record(aws(['s3api', 'get-bucket-policy', '--bucket', bucket]))
    const policy = JSON.parse(String(policyResult.Policy)) as { Statement?: Record<string, unknown>[] }
    const statements = policy.Statement ?? []
    expect(statements.some((statement) => statement.Principal === '*')).toBe(false)
    const distributionArn = `arn:aws:cloudfront::${account}:distribution/${id}`
    expect(statements.some((statement) => {
      const principal = record(statement.Principal)
      const condition = record(statement.Condition)
      const equals = record(condition.StringEquals)
      return principal.Service === 'cloudfront.amazonaws.com' && equals['AWS:SourceArn'] === distributionArn
    }), 'bucket policy must scope CloudFront access to this distribution').toBe(true)

    const behavior = record(config.DefaultCacheBehavior)
    const responsePolicy = record(aws(['cloudfront', 'get-response-headers-policy', '--id', String(behavior.ResponseHeadersPolicyId)]))
    const policyConfig = record(record(responsePolicy.ResponseHeadersPolicy).ResponseHeadersPolicyConfig)
    const cors = record(policyConfig.CorsConfig)
    const allowOrigins = record(cors.AccessControlAllowOrigins)
    expect(allowOrigins.Items).toContain(new URL(e2eConfig.frontendUrl).origin)
    await persistPlaybackEvidence({ resources: {
      distributionId: String(id), distributionArn, bucket,
      oacId: String(origin.OriginAccessControlId),
      frontendOrigin: new URL(e2eConfig.frontendUrl).origin,
      deployed: true, privateOutput: true,
    } }, true, process.env, 'delivery-preflight')
  })
})
