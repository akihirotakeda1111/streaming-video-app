# Private CloudFront delivery

The output bucket is private. CloudFront uses an Origin Access Control (OAC)
with SigV4 signing against the bucket's regional REST endpoint. The bucket
policy grants `s3:GetObject` only to `cloudfront.amazonaws.com`, only below the
legacy `videos/*/jobs/*/hls/*` prefix, and only when `AWS:SourceArn` matches
the intended distribution. S3 CORS handles browser preflight requests forwarded
by CloudFront and authorized browser-based inspection tools. Non-browser SDKs
do not enforce CORS; it is not an authentication mechanism. Playback CORS is applied by the
CloudFront response-headers policy, including cache hits, for the configured
frontend origins.

## Staged preparation

Operators perform these live changes. A full apply of this root immediately
replaces the public output policy and enables Block Public Access (BPA); it is
not a preparation-only operation. Do not full-apply it while the API still
returns direct S3 URLs. Review every plan for bucket replacement or unrelated
changes and stop if either appears.

1. Prepare and test the Task 03 API release before the cutover. Completed
   responses must use the CloudFront base URL and existing relative manifest
   key. Arrange for clients holding old direct S3 URLs to refresh playback URLs
   at cutover; those URLs stop working after private access is enforced.
2. For an existing public deployment, prepare the distribution separately.
   An operator may use a reviewed, saved targeted plan for
   `aws_cloudfront_distribution.video_output` (under `module.foundation` in the
   E2E root). Its dependencies include OAC and the delivery policies. Confirm
   that the plan does not change the bucket policy or BPA, and wait until the
   distribution is Deployed. Targeting is only for this one-time migration;
   it does not establish that the full configuration has been applied.
3. Record the actual distribution ID/domain and derive the HTTPS base URL.
   During this preparation window, an operator adds the final configuration's
   scoped CloudFront Allow statement to the existing output bucket policy:
   GetObject on the existing HLS prefix, Service cloudfront.amazonaws.com,
   StringEquals AWS:SourceArn equal to this distribution's ARN. Preserve the
   existing statements at this step; do not add new public grants or relax BPA.
   This temporary migration state is operator-managed, not a public-mode switch
   in the final IaC. An already-private deployment must stay private.
4. Verify HTTPS GET and HEAD for an existing manifest and segment through
   CloudFront. Send OPTIONS with Origin, Access-Control-Request-Method: GET,
   and Access-Control-Request-Headers for the headers used by the player.
   Require successful preflight and the expected CORS response for each approved
   origin. An unapproved origin must not receive an allowing CORS response;
   this does not imply viewer authentication or prevent non-browser downloads.
5. Switch the API to CloudFront, refresh clients and verify playback. Then
   review and apply the full final plan to remove legacy public statements
   and enforce all four output BPA settings. Confirm CloudFront still serves
   manifest/segments and anonymous direct S3 GET/HEAD fail. Check the full plan
   again for remaining drift. Task 04 owns integrated live acceptance evidence.

For a new dedicated environment with no existing playback traffic, apply the
full root directly, configure the Task 03 API, and perform the same checks.
The E2E root exports `playback_base_url` separately; `compose_environment`
retains the ten-name Reliability setup contract. Task 03 owns passing the
playback setting into the API runtime.

If `frontend_origins` is omitted or null, both S3 and CloudFront CORS use
`frontend_origin`. An explicit non-empty list replaces that fallback entirely;
include every intended upload/playback origin. It does not automatically add
localhost or the legacy origin.

The distribution starts legacy deterministic HLS objects at TTL zero because a
retry can overwrite those keys. An immutable attempt-key policy may be added by
Task 24. Successful-response cache hits are not expected with these zero TTLs.
The response-headers policy also covers cache hits; verify multiple approved
origins and an unapproved origin against warmed objects when Task 24 enables
caching, without increasing mutable-key TTLs just for this test. If OPTIONS
caching is enabled then, include the preflight headers in the cache key.

403/404 error caching minimum TTL is configured to zero. AWS documents a
one-second minimum for S3 origin errors when caching is enabled, even when
the error TTL is zero. Do not use negative caching as a consistency mechanism
or promise immediate recovery based solely on this setting. See
[AWS error caching documentation](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/custom-error-pages-expiration.html).

## Rollback

If playback fails, repair or postpone the API/distribution cutover while
retaining private S3. Roll back by correcting the distribution, origin, or API
configuration; never reopen the bucket to anonymous S3 reads.
