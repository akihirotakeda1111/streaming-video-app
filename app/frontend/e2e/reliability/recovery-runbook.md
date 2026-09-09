# Spec 44: 手動実行手順

## 実装範囲

`crash-recovery` と `long-heartbeat` は実workerを使用するシナリオです。
シナリオはAPI/UIを経由せず、専用DBにrun固有のvideo/jobをUPLOADINGとして作成し、
canonical source keyへMP4を1回PUTします。以降は実際のS3通知・SQS・worker・DB・S3公開を通ります。
Phase 1のブラウザupload/playback回帰試験は別途実行してください。

crashはencode開始とlease/visibility更新成功を観測した後、指定したworkerコンテナへSIGKILLします（[Docker公式仕様](https://docs.docker.com/reference/cli/docker/container/kill/)）。
停止後にもDBとログを読み、最後のlease失効とvisibility失効の両方を確認してから、同じコンテナをstartします。
visibilityは成功応答ログ時刻に設定秒数を加えた保守的な上限を使用し、1秒の時計差マージンを加えます。
DB leaseはDB自身の時計で判定します。新しい所有者、attempt=2、同じSQS MessageId、
source再読込、segment→manifest→COMPLETED→acknowledgementを照合します。

heartbeatは実encode時間が実workerのheartbeat間隔の2倍を超え、その間に各2回以上の
lease/visibility成功ログがあり、attempt=1・所有者が一定であることを確認します。
動画の再生時間だけでは合格しません。短すぎた場合は失敗します。

## 1. 専用環境を用意する

既存の [runner.md](runner.md#live-preflight-and-supported-adapter) の全条件を満たす、
disposable AWS資源と直接接続のローカルDocker Engineが必要です。
Terraform、IAM、Compose、コンテナ作成はこのrunnerでは変更・実行しません。
共有環境をテスト用と宣言し直して使用しないでください。

追加条件:

- workerは今回の観測ログを含むイメージに更新し、起動ログに `observation_schema: 1` があること。
- workerのrestart policyは `no`、TMPDIRは `/tmp/video-worker`。
- workerとDBのfull container IDは固定。実行中に再作成・設定変更しないこと。
- 同じworker/queue/bucket/DBで別の作業・consumer・E2Eを同時実行しないこと。
- DBにUPLOADING/QUEUED/PROCESSINGの既存jobがないこと。
- DBと実行端末の時計差は1秒以内。
- PostgreSQLコンテナ内の `psql` がworkerの接続先DB・roleにlocal socketで接続できること。
  workerのDATABASE_URLから非秘密のrole/DB名だけをメモリ上で取り出します。接続文字列は出力しません。
- input/output bucketのversioningは未設定（Enabled/Suspendedは対象外）。
- input bucketは対象source queueへの直接通知1件。`s3:ObjectCreated:*` または `s3:ObjectCreated:Put`。
  repositoryの `videos/` prefix、`/source.mp4` suffixは利用可能です。
  SNS/Lambda/EventBridgeとの併用や複数通知は対象外です。
- crash用のmaximum attemptsは2以上。Worker・SQS redrive・E2E_MAX_ATTEMPTSを揃えること。
- source MP4は1 GiB以下、生成HLSは512オブジェクト以下を目安にすること。

イメージbuild（リポジトリルートで実行）:

```powershell
docker build -t streaming-video-worker:e2e-recovery ./app/backend/worker
```

専用環境の管理方法で、このイメージを使うworkerを用意してください。
その後に取得した新しいfull IDを以下の設定に使用します。
image更新前のIDや既存の共有コンテナは使用しません。

## 2. 長い入力動画を用意する

十分に長い実encodeが必要です。最初の候補として、ローカルで10分のテスト動画を生成できます。
処理速度は端末・workerのCPU制限に依存します。これで短すぎる場合は入力を長くするか、
専用workerを用意するときのCPU割当を調整してください。runnerはCPU割当やFFmpegを変更しません。

```powershell
New-Item -ItemType Directory -Force C:\e2e\fixtures | Out-Null
ffmpeg -hide_banner -loglevel error -f lavfi -i "testsrc2=size=1920x1080:rate=30" -t 600 -an -c:v libx264 -preset ultrafast -pix_fmt yuv420p -movflags +faststart C:\e2e\fixtures\long.mp4
```

既存ファイルを上書きしないため、別ファイルが存在する場合は新しい名前を指定してください。
生成後にサイズを確認します。アップロードを含む各外部コマンドには10秒の制限があります。
回線に対して大きすぎる場合は解像度・圧縮率を調整してください。

## 3. 環境変数を設定する（PowerShell）

`<...>` を実際の専用環境の値で置き換えます。credentialsは通常のAWS profile等を使用し、
設定ファイルや証跡に書き込まないでください。以下の秒数は例です。実worker設定に応じて調整します。

```powershell
$env:AWS_PROFILE = '<disposable-profile>'
$env:AWS_REGION = '<region>'
$env:E2E_AWS_ACCOUNT_ID = '<12-digit-account-id>'
$env:E2E_DOCKER_HOST = 'npipe:////./pipe/docker_engine'
$env:E2E_ENVIRONMENT = 'disposable'
$env:E2E_RELIABILITY_DISPOSABLE = 'true'
$env:E2E_RECOVERY_EXCLUSIVE = 'true'
$env:E2E_RECOVERY_FIXTURE = 'C:\e2e\fixtures\long.mp4'
$env:E2E_EVIDENCE_DIR = 'C:\e2e\evidence'
$env:E2E_FRONTEND_URL = 'http://127.0.0.1:5173'
$env:E2E_API_URL = 'http://127.0.0.1:8000'
$env:E2E_SOURCE_QUEUE = '<source-queue-name>'
$env:E2E_DLQ = '<dlq-name>'
$env:E2E_SOURCE_DLQ = $env:E2E_DLQ
$env:E2E_SOURCE_DLQ_RELATIONSHIP = 'verified'
$env:E2E_SOURCE_BUCKET = '<input-bucket>'
$env:E2E_OUTPUT_BUCKET = '<output-bucket>'
$env:E2E_ALARM_IDENTIFIERS = '<source-age-alarm>,<source-count-alarm>,<dlq-count-alarm>'
$env:E2E_MAX_ATTEMPTS = '3'
$env:E2E_WORKER_OBSERVATION = 'docker:<full-64-character-worker-id>'
$env:E2E_WORKER_PROCESS_CONTROL = $env:E2E_WORKER_OBSERVATION
$env:E2E_DATABASE_OBSERVATION = 'docker:<full-64-character-database-id>'
$env:E2E_DATABASE_PROCESS_CONTROL = $env:E2E_DATABASE_OBSERVATION
$env:E2E_WORKER_CONTROL_SCOPE = '<worker-container-scope-label>'
$env:E2E_DATABASE_CONTROL_SCOPE = '<database-container-scope-label>'
$env:E2E_NAVIGATION_TIMEOUT_MS = '30000'
$env:E2E_UPLOAD_TIMEOUT_MS = '120000'
$env:E2E_PROCESSING_TIMEOUT_MS = '900000'
$env:E2E_LEASE_TIMEOUT_MS = '360000'
$env:E2E_VISIBILITY_TIMEOUT_MS = '240000'
$env:E2E_DLQ_TIMEOUT_MS = '900000'
$env:E2E_PLAYBACK_TIMEOUT_MS = '120000'
```

Linux/WSLでは各変数を `export NAME=value` で設定し、Docker hostは
`unix:///var/run/docker.sock`、fixture/evidenceはその環境の絶対パスにします。
`E2E_RUN_ID` は設定しません。Python runnerが実行ごとに生成します。

必要な権限はrunner.mdのread-only preflight権限に加えて:

- S3: GetBucketVersioning、[GetBucketNotification](https://docs.aws.amazon.com/cli/latest/reference/s3api/get-bucket-notification-configuration.html)、PutObject、GetObject、DeleteObject、ListBucket
- PostgreSQL: 対象DBのvideos/jobsをSELECT/INSERT、run所有videosのDELETE（jobsはCASCADE）
- Docker: full IDへのinspect/logs/kill/start/exec、専用worker内のrun固有一時ディレクトリ削除

SQSのpurge、receive、delete、send、DLQ replayをテストrunnerに与える必要はありません。
SQSの受信・更新・ackは実workerが行います。

## 4. オフライン検証とpreflight

リポジトリルートで実行し、各コマンドの終了コードが0であることを確認します。

```powershell
npm --prefix app/frontend ci
npm --prefix app/frontend run test:e2e:helpers
npm --prefix app/frontend run test:e2e:type-check
python app/scripts/run_reliability_e2e.py --check
python app/scripts/run_reliability_e2e.py --live-preflight
```

`--check`はAWS CLI等の存在確認だけで、ライブ資源へアクセスしません。
`--live-preflight`は読み取りだけです。シナリオ固有の追加条件はシナリオ開始時にも確認します。
Python runnerはNodeからPlaywrightを直接起動するため、Windowsの `sh` は不要です。

## 5. 2つのシナリオを順番に実行する

```powershell
python app/scripts/run_reliability_e2e.py --scenario long-heartbeat
python app/scripts/run_reliability_e2e.py --scenario crash-recovery
```

最初の実行が成功・cleanup完了したことを確認してから次を実行してください。
両方とも再試行なしです。手順途中でターミナルを終了するとfinallyによる復元・cleanupは保証されません。
1回の実行は、処理予算・失効待ち・失敗時のcleanup待ちを含めて長くなる場合があります。

## 6. 証跡と合否

各実行の以下のJSONを確認します。

```text
<E2E_EVIDENCE_DIR>/e2e-<UUID>/long-heartbeat-evidence.json
<E2E_EVIDENCE_DIR>/e2e-<UUID>/crash-recovery-evidence.json
```

必要条件は終了コード0、`status: passed`、`cleanup: complete`、`restored: true`。
JSONにはrun/video/job ID、canonical key、検証済み境界とworker設定、DB観測、
相関済み成功イベントが残ります。生のDocker inspect/logs、receipt handle、DATABASE_URLは保存しません。

成功時はack確認後にrunのS3 source/HLS、DB行、crashで残ったjob固有一時ディレクトリを削除します。
workerコンテナは保持・復元され、DBコンテナは停止しません。
2つのJSONを人が確認するまでSpec 44のライブ検証完了とは扱いません。

## 失敗時

- `encode too short` / `encode finished before safe crash injection`: 実入力を長くし、cleanup完了後に新しいrunで再実行します。
- `worker image lacks ...`: 新しいイメージと起動直後のコンテナを用意し、full IDを更新します。
- `cleanup: retained`: 実行中の処理・未ackを確認できなかったため、データを削除せず残しています。
  JSONのtargetとverificationに記録されたIDだけを対象に、まずworkerの稼働と対象jobの状態を確認してください。
  同じジョブのCOMPLETEDと `record_acknowledged` を確認できるまで、S3/DBを手動削除しないでください。
  確認後、target.sourceKey、target.prefix配下のHLS、target.videoId/jobIdのDB行、
  `/tmp/video-worker/job-<jobId>-<suffix>` のみを片付けます。
  FAILED・DLQ滞留・未ackの場合は対象runの証跡を保持し、専用環境の管理者が残存メッセージも含めて対応します。
  queue全体のpurgeやDLQ全件replayは行いません。
- `restored: false`: verification.worker.identityのコンテナが同じ専用Engine上に存在することを確認し、
  停止している場合はそのfull IDだけをstartします。別IDで作り直して証跡を混ぜないでください。

予期せぬ外部障害や端末の強制終了まで自動復元を保証する仕組みではありません。
未完了runが残ったまま次の試験を開始しないでください。
