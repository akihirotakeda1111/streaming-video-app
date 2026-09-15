# Private CloudFront delivery

The output bucket is private. CloudFront uses an Origin Access Control (OAC)
with SigV4 signing against the bucket's regional REST endpoint. The bucket
policy grants `s3:GetObject` only to `cloudfront.amazonaws.com`, only below the
legacy `videos/*/jobs/*/hls/*` prefix, and only when `AWS:SourceArn` matches
the intended distribution. S3 CORS remains for SDK/read inspection tools; it
is not an authentication mechanism. Browser playback CORS is applied by the
CloudFront response-headers policy, including cache hits, for the configured
frontend origins.

## Staged preparation

1. Apply the Terraform root and record `cloudfront_distribution_id`,
   `cloudfront_distribution_domain_name`, and `PLAYBACK_BASE_URL`.
2. Prepare the Task 03 API cutover so completed responses form manifest URLs
   from `PLAYBACK_BASE_URL` and the existing relative manifest key.
3. Verify the distribution serves HLS over HTTPS with GET, HEAD, and OPTIONS,
   and verify the approved frontend origins receive CORS headers on both cache
   misses and hits. Confirm that an unapproved origin is not admitted.
4. After the API cutover is ready, remove any legacy public bucket policy and
   enforce all four S3 Block Public Access settings. The final IaC must not
   retain a public delivery mode.

The distribution starts legacy deterministic HLS objects at TTL zero because a
retry can overwrite those keys. An immutable attempt-key policy may be added by
Task 24. Keep 403/404 error caching at the applicable CloudFront service
minimum; do not use negative caching as an application consistency mechanism.

## Rollback

If playback fails, repair or postpone the API/distribution cutover while
retaining private S3. Roll back by correcting the distribution, origin, or API
configuration; never reopen the bucket to anonymous S3 reads.
