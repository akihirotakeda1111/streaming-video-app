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

## Integrated delivery acceptance

Use the dedicated E2E runner identity; it needs read-only CloudFront
distribution/OAC/response-policy inspection and output bucket policy/BPA access,
plus scoped `s3:GetObject` and `s3:ListBucket` inspection permissions (ListBucket
is required for missing HeadObject responses to be distinguishable as 404).
Generate and
review the disposable environment as described by the reliability runner, then
run the offline commands from the task independently. Offline helper,
discovery, type-check, and contract results are not live evidence.

Run `python app/scripts/run_reliability_e2e.py --live-preflight` before the
suite. This runs the read-only delivery preflight and requires its run-scoped
evidence. The full suite also runs this gate before any reliability scenario;
a failed gate or missing evidence prevents all later scenarios. It matches `PLAYBACK_BASE_URL` to one
Deployed distribution, its regional S3 origin and SigV4 OAC, all four BPA
settings, the distribution-scoped bucket policy, and the frontend origin in the
CloudFront response-headers policy.

The bucket-policy validator accepts the repository's distribution-scoped
CloudFront `Allow s3:GetObject` on `videos/*/jobs/*/hls/*` and non-granting Deny
statements. Other Allow forms, including additional broader grants, fail closed.
Dedicated SDK permissions should be identity-based. Both 403/404 custom error
TTLs must be explicitly zero, without status/page rewriting.

Finally run `python app/scripts/run_reliability_e2e.py --full-suite`. It keeps
all six Phase 2 scenarios, creates a fresh Phase 1 completion, proves that a
403/404 requested before publication becomes a CloudFront 200 within the
independent publication recovery bound, and checks repeated HTTPS delivery,
manifest/segment MIME types, relative segment references, allowed and denied
CORS origins, anonymous S3 rejection, SDK-only private-object inspection, and
positive browser media-time advancement. The final delivery-regression step
automatically consumes the successful Phase 1 run from this same suite, checks its real status and
playback API, and plays each job with video.js on the actual frontend origin.
It requires positive media-time advancement and CloudFront manifest/segment
responses, and checks the original manifest key and ETag using dedicated IAM
before and after playback. Preserve the emitted
run directories and `full-suite-*.json`; a missing/failed/unexecuted row is not
a PASS. Cache-hit headers are deliberately not required while successful TTLs
remain zero.

Publication is observed by continuous S3 HeadObject and CloudFront polling from
before upload. The recovery upper bound starts at the last confirmed S3 absence
request's start, not at a later CDN error or after encoding finishes. CloudFront
must return 200 within 10 seconds of that fixed point; recent S3 absence and CDN
negative observations must bracket publication within 5 seconds. Requests have
2-second timeouts and polls pause 250 ms. These test bounds include the documented
S3-origin error caching floor and observation overhead; they are not an AWS SLA.
Slow/failed observations fail rather than claiming an unmeasured recovery.
The playback evidence retains monotonic observation times and the latest sample,
including failures. Long upload/encoding time uses the separate processing budget.

### Continuous full suite and isolated replay

`--full-suite` passes the preceding `phase1-pipeline` run ID to delivery replay,
just as queue monitoring receives its preceding failure scenario run IDs.
No legacy inventory or manual selection is required. The Phase 1 evidence now
includes the output bucket and original manifest key/ETag for this handoff.
Failed or missing upstream evidence prevents replay. The aggregate report
records `playbackEvidenceRun` and `verificationScope: completed-job-replay`.

To replay a retained successful run independently, use:

```text
python app/scripts/run_reliability_e2e.py --scenario delivery-regression --playback-evidence-run e2e-<UUID>
```

Keep `E2E_EVIDENCE_DIR` set to the parent evidence directory, as for monitoring.
The selected child directory must contain `phase1-pipeline-evidence.json` from
a successful run, with matching run/job IDs, COMPLETED status, bucket and
manifest fingerprint. Older artifacts lacking these fields are rejected;
use the historical inventory option below for pre-cutover acceptance.
Missing files or deleted objects fail rather than selecting another job.

The two source arguments are mutually exclusive and valid only for standalone
delivery regression. Inherited `E2E_PLAYBACK_EVIDENCE_RUN` and
`E2E_LEGACY_DELIVERY_FIXTURES` are cleared by the runner: explicit CLI selection
or the full suite's automatic handoff is authoritative.

Full-suite success proves current completed-job replay, not pre-cutover
compatibility. Task 04's historical acceptance still requires the separate
inventory run below; preserve both sets of evidence for completion.

The report separates `executionStatus` for the current regression from
`acceptanceStatus` for combined live acceptance. Without historical evidence,
successful regression has `status: passed`, `statusScope: current-regression`,
`executionStatus: passed`, but `acceptanceStatus: incomplete` and
`historical-compatibility` in `unexecutedLiveChecks`. Exit code 0 in this case
means only the current regression succeeded. Acceptance automation must require
`acceptanceStatus: passed` as well as the independently recorded offline checks.

After a successful historical replay, aggregate its run ID with a fresh suite:

```text
python app/scripts/run_reliability_e2e.py --full-suite --historical-evidence-run e2e-<UUID>
```

The referenced `delivery-regression-evidence.json` must be successful, match its
run ID and the current account, region, bucket and CloudFront origin, and contain
pre-cutover chronology and positive browser advancement for both phases with
original manifest keys/ETags. Missing, mismatched, or old-format evidence blocks
acceptance and exits 2. Valid evidence appears under `acceptanceChecks`; it is
referenced, not re-executed. Re-run historical playback after a delivery change;
the aggregate checks target identity, not unchanged deployment configuration.

### Previously completed job inventory

Before changing delivery, record at least one completed Phase 1 job and one
completed Phase 2 job from the dedicated disposable environment. Save their
original IDs, manifest keys, and S3 HeadObject ETags in an operator-owned JSON
file. Set `capturedAt` to the inventory capture time and `cutoverAt` to the actual
subsequent CloudFront cutover time (UTC ISO timestamps). Retain the corresponding
pre-cutover completion evidence; the phase labels are operator-supplied provenance.
Do not generate replacements during the suite or move/re-encode the old objects.

The JSON shape is `{ "capturedAt": "…", "cutoverAt": "…", "jobs": [...] }`.
Each job contains `phase` (`phase1` or `phase2`), `videoId`, `jobId`,
`manifestKey` (`videos/<videoId>/jobs/<jobId>/hls/index.m3u8`), and
`manifestETag` (the exact HeadObject ETag string, including its double quotes).
Both phases are mandatory; 2–10 distinct videos are supported. Job `updatedAt`
must be no later than capture, and capture must precede cutover.

After loading the generated environment, run:

```text
python app/scripts/run_reliability_e2e.py --scenario delivery-regression --legacy-delivery-fixtures /absolute/path/to/legacy-delivery.json
```

The result records `verificationScope: pre-cutover-compatibility`. The generator
does not create historical evidence. Missing/invalid inventory fails the
regression; it never substitutes fresh output. All replay modes select Chromium
with retries disabled.
The existing UI has no route for reopening old jobs, so the E2E harness mounts
the installed video.js player on the frontend page with the real API URL.
