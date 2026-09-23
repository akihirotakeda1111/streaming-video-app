# Streaming Video App

## Project Overview

Streaming Video App は、動画アップロードから非同期エンコード、HLS生成、ブラウザ再生までを一つのパイプラインとして学ぶための、個人開発MVPです。自己学習とポートフォリオを主目的とし、APIの応答処理と時間のかかる動画変換を分離した、最小のストリーミング動画アプリケーションを実装しています。

`dev/phase3` では、正常系パイプラインとPhase 2のlease・heartbeat・再試行・DLQ・監視に加え、CloudFront配信、AWS compute、分散エンコード、ABR、Auto ScalingとScalability E2Eを実装しています。

```text
Upload -> asynchronous Encode -> HLS generation -> Playback
```

このリポジトリは本番向け動画配信サービスではありません。ローカルComposeはFrontend、Go API、Rust Worker、PostgreSQLを起動し、S3、SQS/DLQ、CloudFrontは実AWSを利用します。クラウド用TerraformはAPI・Worker・encoderをECS/Fargate、PostgreSQLをprivate RDSへ配置します。Frontendのホスティングは別途用意します。

## What this application does

ユーザーはブラウザでMP4ファイルを1つ選び、アップロードします。動画データはAPIサーバーを経由せず、Go APIが発行したPresigned PUT URLを使ってInput S3 bucketへ直接送信されます。

アップロード完了をS3の `ObjectCreated` 通知がSQSへ伝え、Rust Workerがメッセージを受信します。`cli` モードはWorker内のFFmpeg CLIで単一品質HLSを生成します。`distributed` モードはStep FunctionsからFargate encoderを起動し、360p / 720pのrenditionを最大2並列で生成します。親Workerが成果物を検証してABR master playlistを公開し、DBで完了を確定します。

FrontendはGo APIをポーリングし、完了後にvideo.jsで再生します。HLSはCloudFrontから取得し、CloudFrontはOAC経由でprivate Output S3を読み取ります。内部の `result.json` は配信対象外です。

## Architecture Overview

```mermaid
flowchart LR
    User[User] --> Browser[Vue Frontend / video.js]

    Browser -->|1. POST /videos| API[Go API]
    API -->|create video + UPLOADING job| DB[(PostgreSQL)]
    API -->|2. Presigned PUT URL| Browser
    Browser -->|3. PUT source.mp4| Input[(S3 Input bucket)]

    Input -->|4. ObjectCreated notification| Queue[[SQS Standard Queue]]
    Queue -->|5. long poll| Worker[Rust Worker]
    Queue -->|redrive policy| DLQ[[SQS Dead Letter Queue]]
    Worker -->|lease acquisition / renewal / status updates| DB
    Worker -->|visibility heartbeat| Queue
    Worker -->|GET / probe source.mp4| Input
    Worker -->|cli: encode locally| FFmpeg[FFmpeg CLI]
    Worker -->|distributed: start / monitor| SFN[Standard Step Functions]
    SFN -->|Inline Map: max 2 / runTask.sync| Encoder[Fargate encoders / FFmpeg]
    Encoder -->|GET source.mp4| Input
    Encoder -->|segments, media playlists, result JSON| Output[(Private S3 Output bucket)]
    Worker -->|validate results / publish manifest last| Output

    Browser -->|9. poll video status| API
    API -->|read current job| DB
    Browser -->|10. request playback info| API
    Browser -->|11. HTTPS GET manifest + segments| CDN[CloudFront]
    CDN -->|OAC / HLS objects only| Output
```

責務の境界は次のとおりです。

- Go APIはジョブを作成し、アップロード先を発行し、現在状態と再生情報を返します。動画本体の中継やエンコードは行いません。
- Rust WorkerはSQSを起点にclaim、lease管理、エンコードまたは分散処理の調整、公開、状態更新を行います。子encoderは担当renditionだけを生成し、DB接続・SQS ack・ジョブ完了の権限を持ちません。
- Frontendはユーザー操作、S3への直接アップロード、状態ポーリング、HLS再生を担当します。AWS認証情報は持ちません。
- PostgreSQLは動画メタデータ、job状態、lease・attempt、処理modeと公開manifest keyを保持します。
- Terraformはstorage / deliveryとcomputeを別stateで管理します。computeにはVPC、RDS、HTTPS ALB、ECS services、migration task、Step Functions、Auto Scaling、CloudWatch logsがあります。

## Component Responsibilities

### Frontend

`frontend/` は Vue 3、TypeScript、Viteで構成されています。

- 空でない `video/mp4` ファイルを1つ受け付ける
- `POST /videos` で動画とエンコードジョブを作成する
- APIレスポンス内のPresigned URL、HTTP method、headersを使ってS3へ直接PUTする
- 既定1秒間隔で `GET /videos/{videoId}` をポーリングする
- `FAILED` をエラー表示し、`COMPLETED` で再生情報を取得する
- video.jsへHLS manifest URLを渡して再生する
- APIレスポンスを実行時に検証し、契約外の値をエラーとして扱う

### Go API

`backend/api/` はGoの標準 `net/http`、AWS SDK for Go v2、pgxを利用します。

- `POST /api/v1/videos`
  - `fileName`、`contentType`、`sizeBytes` を検証する
  - `video/mp4`、1 byte以上5 GiB以下だけ受け付ける（Workerの処理上限は別設定）
  - video IDとjob IDを生成する
  - jobを `UPLOADING` としてPostgreSQLへ保存する
  - 15分有効のS3 Presigned PUT URLを発行する
- `GET /api/v1/videos/{videoId}`
  - 動画メタデータと現在のジョブ状態を返す
- `GET /api/v1/videos/{videoId}/playback`
  - `COMPLETED` のときだけ `PLAYBACK_BASE_URL` と公開manifest keyからCloudFront URLを返す
  - legacy jobのNULL pointerは従来の `hls/index.m3u8` へ解決する
  - 未完了時は `409 VIDEO_NOT_READY` を返す
- `GET /api/v1/health`
  - ComposeとE2E preflight用のヘルスチェックを返す
- 設定されたFrontend originだけにJSON APIのCORSを許可する

APIは起動時にPostgreSQL接続、`videos` / `jobs` table、AWS credential providerを確認します。S3へのアップロード完了通知やSQSへのメッセージ送信はAPIの責務ではありません。

### Rust Worker

`backend/worker/` はCargo workspaceで、`worker`、`encoding`、`queue`、`storage`、`persistence` crateに責務を分けています。

- SQSを20秒long pollingし、1回に1 messageを受信する
- `WORKER_MAX_CONCURRENCY` で1 processの同時処理数を制限する（1〜32、Compose既定2、Fargate設定1）
- standard S3 Event Notificationの全 `Records` を解析する
- event name、Input bucket、URL decode後のobject key、UUID形式を検証する
- PostgreSQLの条件付きUPDATEで `UPLOADING -> QUEUED` を原子的にclaimする
- 未所有または期限切れのleaseを原子的に取得し、PROCESSINGへの遷移とattempt加算を行う
- heartbeatでDB leaseとSQS visibilityを延長し、所有権喪失時は処理を中断する
- sourceサイズ、動画長、一時領域、空きdisk、FFmpeg threads、処理時間を制限する
- `cli` はshellを介さずFFmpegを起動し、H.264/AAC、6秒segment、VOD HLSを生成する
- `distributed` はStep Functionsを起動・監視し、各renditionのS3結果と実メディアを検証する
- segments・media playlistsの後に公開manifestをuploadし、有効なowner / attemptの条件下でjobを `COMPLETED` にする
- 通知内の全jobが完了済みの場合だけSQS messageをdeleteし、完了済み再配送では再エンコードしない
- 再試行可能な失敗はowner条件付きでQUEUEDへ戻し、固定遅延後の再配送を要求する
- 所有中の試行上限到達時の失敗をFAILEDとし、通知はSQS redriveによるDLQ移動に任せる
- PostgreSQL接続終了時は受信・処理を停止して異常終了する
- 処理完了時も進行中のSQS受信を保持し、応答を処理へ引き渡す

Worker containerには固定バージョンのFFmpeg / ffprobe 7.1.1が含まれ、非root userで実行されます。

`ORCHESTRATION_STATE_MACHINE_ARN` が未設定なら新規取得jobは `cli`、設定すると `distributed` です。modeは初回lease取得時にDBへ保存し、再取得時も維持します。`WORKER_RUNTIME_MODE=local|ecs` はTLS・task protectionなどの実行環境設定であり、エンコードmodeとは別です。ECSではIAM task role、verified TLS、task protectionを使い、SIGTERMでは受信を止めて処理を終了します。詳細は [Worker scaling](./docs/runbooks/worker-scaling.md) と [Distributed encoding](./docs/runbooks/distributed-encoding.md) を参照してください。

通常Composeは `unless-stopped` でWorkerを再起動し、DB接続を張り直します。障害注入用の `compose.e2e.yaml` は `restart: "no"` とし、シナリオが同じコンテナのstop/startを制御します。詳細は [再試行と冪等性のrunbook](./docs/runbooks/retry-and-idempotency.md) を参照してください。

### Infra

インフラの詳細は [Infra README](./infra/README.md) を参照してください。

Terraformルートは用途ごとに分かれています。

| Root | Role |
| --- | --- |
| `infra/terraform/` | 共通のS3 / SQS / CloudFront / IAM / alarms |
| `infra/terraform-compute/` | 別stateのVPC / RDS / ALB / ECS / Step Functions / scaling。`shared_state_path` でdelivery stateを参照 |
| `infra/terraform-e2e/` | Reliability E2E専用AWS環境 |
| `infra/terraform-e2e/scalability/` | Scalability E2E専用deliveryとcompute用設定例。独立したstate / data directoryを使用 |

主な構成:

- 分離されたInput / Output S3 buckets
- SQS Standard Queue、DLQ、受信回数上限に基づくredrive policy
- source最古メッセージ年齢・source可視件数・DLQ可視件数の3つのCloudWatchアラーム
- `s3:ObjectCreated:*` からSQSへの通知
  - prefix: `videos/`
  - suffix: `/source.mp4`
- Input bucketのpublic access blockと、FrontendからのPUT CORS
- Output bucketのBlock Public Access、CloudFront OACに限定したHLS read、内部 `result.json` の明示的deny、GET/HEAD CORS
- S3からSQSへの送信を `SourceArn` / `SourceAccount` で制限したqueue policy
- Go API用のInput `s3:PutObject` 権限
- Rust Worker用のSQS consume、Input read、Output write権限
- API / Workerで分離されたローカル実行用IAM usersとpolicies
- 専用VPC、private Single-AZ RDS、HTTPS ALB配下のAPI、Fargate Worker serviceと単発encoder tasks
- ECRのimage digest指定、Secrets Managerのapplication DB URL、verified TLS、CloudWatch logs
- SQS可視backlog / running Worker tasksのtarget tracking（初期1〜4 tasks、scale-to-zeroなし）
- Standard Step FunctionsのInline Map、`MaxConcurrency=2`、`ecs:runTask.sync`

TerraformはIAM access keyを生成しません。認証情報の発行・保管・ローテーションはこのリポジトリの対象外です。

### Contracts

`contracts/` がコンポーネント間の共有契約です。

- [OpenAPI 3.1 contract](./contracts/openapi/api.yaml): create、status、playback APIとレスポンス例
- [Job status schema](./contracts/domain/job-status.schema.json): 公開APIの5状態
- [Reliability conventions](./contracts/domain/reliability-conventions.md): lease、attempt、retry、heartbeat、ack、DLQの契約
- [Storage conventions](./contracts/domain/storage-conventions.md): bucketの役割、S3 keys、S3 event、HLS公開順序
- [Scalability conventions](./contracts/domain/scalability-conventions.md): mode、親子処理、deadline、ABR公開、CloudFront配信
- `contracts/domain/orchestration-*.schema.json` と `contracts/examples/internal/`: 親入力・子入力・S3結果の内部契約
- `contracts/examples/api/`: OpenAPIから参照されるcanonical API examples
- `contracts/examples/s3/object-created.json`: Workerが解釈するcanonical S3 notification fixture

現在も独自の `encoding-requested`、`encoding-progress`、`encoding-completed` eventsを使用しません。SQS message bodyはAWS標準のS3 Event Notification JSONです。

## End-to-End Flow

1. ユーザーがFrontendで空でないMP4ファイルを1つ選びます。
2. Frontendがファイル名、`video/mp4`、サイズをGo APIへ送ります。
3. Go APIがvideo/job IDsとcanonical Input keyを生成し、そのkey専用のPresigned PUT requestを作成します。
4. Go APIがPostgreSQLへvideoと `UPLOADING` jobをtransactionで保存し、Presigned URLをFrontendへ返します。
5. BrowserがAPIを経由せず、返されたURLとheadersで動画をInput S3 bucketへPUTします。
6. S3がkey filterに一致する `ObjectCreated:*` notificationをSQSへ送ります。
7. Rust Workerがnotificationを受信し、Input bucketとkeyを検証して、jobを原子的に `QUEUED` へclaimします。再配送も含め、続くlease取得結果で処理可否を決めます。
8. Workerがleaseを取得してattemptを加算し、jobをPROCESSINGにします。初回取得時にmodeを確定し、heartbeatを開始します。
9. `cli` は単一品質HLSを生成します。`distributed` は `job-{job_id}-a{attempt}` の決定的な実行名でStep Functionsを開始し、最大2つの子encoderが各renditionを生成します。
10. 子はsegments、media playlist、`result.json` の順にuploadします。親はStep Functions成功後に結果のidentity・key・サイズ・MIME・playlist・メディアを検証し、masterを最後に公開します。子の成功だけではjobは完了しません。
11. 親がowner / attempt条件付きで公開pointerと `COMPLETED` を原子的に保存してからSQS messageをdeleteします。`cli` もmanifest公開後に完了を確定します。失敗時は既存のretry / lease / DLQ規約に従います。
12. Frontendはstatus APIをポーリングし、`COMPLETED` 後にplayback APIからmanifest URLを取得します。
13. video.jsがCloudFrontからmanifestと相対参照されたplaylists / segmentsを取得し、動画を再生します。

## Repository / Directory Structure

次は現在の `app/` 配下を責務単位で要約したものです。将来案ではなく、実在する構成だけを示しています。

```text
app/
├── frontend/                       # Vue UI、API client、video.js、Vitest / Playwright
│   ├── src/
│   │   ├── api/                    # API types、response validation、direct upload
│   │   ├── config/                 # VITE_API_BASE_URL
│   │   └── App.vue                 # upload -> polling -> playback workflow
│   └── e2e/                        # 正常系・delivery・Reliability・Scalability E2E
├── backend/
│   ├── api/                        # Go HTTP API
│   │   ├── cmd/api/                # process entrypointとruntime wiring
│   │   └── internal/
│   │       ├── config/             # environment validation
│   │       ├── httpapi/            # health、create、status、playback
│   │       ├── persistence/        # PostgreSQL repository
│   │       └── bootstrap/          # server lifecycle
│   └── worker/                     # Rust Cargo workspace
│       └── crates/
│           ├── worker/             # orchestration、event parsing、terminal states
│           ├── encoding/           # FFmpeg executionとHLS validation
│           ├── queue/              # SQS port / adapter
│           ├── storage/            # S3 port / adapter
│           └── persistence/        # PostgreSQL job-state transitions
├── infra/terraform/                # S3 / SQS / DLQ / CloudFront / IAM / alarms
├── infra/terraform-compute/        # VPC / RDS / ECS / orchestration / scaling
├── infra/terraform-e2e/             # Reliability専用環境（scalability/ は別環境）
├── contracts/
│   ├── openapi/                    # REST API contract
│   ├── domain/                     # job statusとstorage conventions
│   └── examples/                   # canonical API / S3 fixtures
├── docs/
│   ├── adr/                        # architecture decisionsと将来構想
│   └── runbooks/                   # local / cloud / delivery / distributed / E2E運用
├── scripts/
│   ├── validate_contracts.py       # OpenAPI / examples / domain整合性
│   ├── validate_terraform_contracts.py
│   ├── start-e2e-compose.sh        # Phase 1正常系E2E runtime起動
│   ├── setup_reliability_env.sh    # Bashへ統合設定を反映（.mjsと連携）
│   ├── run_reliability_e2e.py      # 障害注入・証跡管理
│   ├── setup_scalability_env.sh    # 配備済み環境からhandoff / shell設定を生成
│   └── run_scalability_e2e.py      # 負荷・並列処理・scale-in・ABR検証
├── config/                         # 現在は空の予約領域
├── compose.e2e.yaml                # 専用DB・ラベル・restart policy
├── compose.yaml                    # PostgreSQL、migration、API、Worker、Frontend
└── .env.example                    # local runtime設定例（実credentialは含まない）
```

API migrationの実体は `backend/api/internal/persistence/migrations/` にあります。Composeの `migrate` serviceがAPI / Workerの起動前に適用します。

`0001` が基本schema、`0002` がlease、`0003` が `mode` / `published_manifest_key` です。クラウドの単発migration taskは新規DBに0001〜0003を順に適用します。既存DBには未適用分だけを適用し、全件実行taskを再実行しないでください。

## Shared Contracts

変更時は、各言語内の型だけでなく `contracts/` との一致を保つ必要があります。

| 契約 | 主な利用者 | 固定している内容 |
| --- | --- | --- |
| OpenAPI | Frontend / Go API | request、response、error、UUID、5 GiB上限、playback readiness |
| Job status schema | Frontend / Go API / Rust Worker / PostgreSQL | `UPLOADING`, `QUEUED`, `PROCESSING`, `COMPLETED`, `FAILED` |
| Storage conventions | Go API / Rust Worker / Terraform / Frontend | bucket分離、input key、S3 notification、HLS keys、公開順序 |
| Reliability conventions | Worker / DB / Infra / E2E | lease所有権、attempt、retry、heartbeat、ack / DLQ |
| Scalability / orchestration schemas | Parent / encoder / DB / Infra / E2E | 固定renditions、attempt分離、S3結果、公開pointer、deadline、private origin |
| API examples | Contract validator | OpenAPI schemaに対するcanonical payloads |
| S3 example | Rust Worker / Contract validator | AWS標準 `ObjectCreated` message body |

OpenAPIに含まれない `GET /api/v1/health` は、アプリケーション機能ではなくローカルruntimeとE2E用の運用endpointです。

## Job State Flow

```mermaid
stateDiagram-v2
    [*] --> UPLOADING: Go API creates video/job
    UPLOADING --> QUEUED: Worker atomically claims valid S3 event
    QUEUED --> PROCESSING: acquire lease / increment attempt
    PROCESSING --> PROCESSING: reacquire expired lease / increment attempt
    PROCESSING --> QUEUED: retryable failure / release lease
    PROCESSING --> COMPLETED: publish manifest / owner-only completion
    PROCESSING --> FAILED: owned attempt exhausted
    COMPLETED --> [*]
    FAILED --> [*]
```

Go APIが作成時のUPLOADINGを設定し、その後の遷移はWorkerが行います。claimとlease取得は別操作です。lease取得時にのみ内部のattemptを加算し、有効なownerだけが更新・公開・完了・失敗確定を行います。worker_id、attempt、lease_expires_atは公開APIには追加しません。

crash後は、SQS再配送時にleaseが期限切れで試行予算が残っていれば取得し直します。COMPLETEDは再取得せず、再配送では削除だけを再試行します。DLQ移動はSQSの受信回数に基づき、DBのattemptとは別です。DLQに移っただけではDB状態はFAILEDに変わりません。

分散処理でも親がleaseとSQS messageを保持します。deadlineは受信要求開始時刻を基準に処理予算とSQSの12時間上限から余裕時間を引いて固定し、heartbeatでは延長しません。所有権喪失・deadline超過・子失敗では公開しません。再試行前に過去executionの残存ECS tasksを確認し、新しい子と合わせて親あたり2つの上限を守ります。modeと公開pointerは内部状態で、公開APIは引き続き5状態です。

## HLS / S3 Object Layout

InputとOutputは必ず別bucketです。これによりWorker出力がInput notificationへ再帰的に入り、エンコードループになることを防ぎます。

```text
Input bucket
└── videos/{video_id}/jobs/{job_id}/source.mp4

Output bucket
└── videos/{video_id}/jobs/{job_id}/hls/
    ├── segment-00000.ts           # cli / legacy
    ├── ...
    ├── index.m3u8                 # cli / legacy media playlist
    └── attempts/{attempt}/{execution_id}/
        ├── 360p/
        │   ├── segment-00000.ts
        │   ├── index.m3u8         # media playlist
        │   └── result.json        # 内部結果、配信不可
        ├── 720p/                 # 同じ構成
        └── index.m3u8             # 親が最後に公開するABR master
```

| Object | Content-Type | 公開方法 |
| --- | --- | --- |
| `source.mp4` | `video/mp4` | 非公開。Presigned PUTとWorker readのみ |
| `segment-{nnnnn}.ts` | `video/mp2t` | CloudFront HTTPS + CORS、S3はprivate |
| `index.m3u8` | `application/vnd.apple.mpegurl` | CloudFront HTTPS + CORS、S3はprivate |
| `result.json` | `application/json` | 親子のIAMによるread / writeのみ、CloudFront readはdeny |

Playlist内のsegment参照は `segment-00000.ts` のような相対名です。manifestを最後に公開し、その後でjobを `COMPLETED` にすることで、Frontendが不完全なplaylistを取得する時間帯を避けます。

分散出力はattempt / executionごとに分離し、遅れた子が別attemptの成果物を上書きしない構成です。`published_manifest_key` は成功したattemptのmasterを指し、legacy completed jobのNULL pointerは従来keyに解決します。360p / 720pはそれぞれ640×360 / 1280×720を上限とし、upscaleは行いません。

## Technology Stack

| Area | Technology |
| --- | --- |
| Frontend | Vue 3.5, TypeScript 6, Vite 8, video.js 8, Pinia, Vue Router |
| API | Go 1.25.1, `net/http`, AWS SDK for Go v2, pgx v5 |
| Worker | Rust 1.98, Tokio, AWS SDK for Rust, tokio-postgres |
| Media | FFmpeg / ffprobe 7.1.1 in the Worker image, H.264 + AAC, HLS MPEG-TS |
| Database | PostgreSQL 16 |
| AWS | S3, SQS / DLQ, CloudFront / OAC, ECS / Fargate, ECR, RDS, ALB, Step Functions, Secrets Manager, CloudWatch, Application Auto Scaling |
| Infrastructure | Terraform >= 1.6, AWS provider `~> 5.0` |
| Local runtime | Docker Compose |
| Validation | Python 3.11+, JSON Schema, PyYAML, Vitest, Playwright, Go test, Cargo test |

## Local Development / Setup

### Prerequisites

- Docker EngineまたはDocker DesktopとDocker Compose
- 実AWS account内に、`infra/terraform/` に対応するS3、SQS/DLQ、CloudFront/OAC、IAM、アラームが存在すること
- Input bucketとOutput bucketが別名であること
- Input S3 CORSのorigin、Output S3 CORSのorigin、`FRONTEND_ORIGIN` が実際のFrontend originと一致すること
- APIとWorkerに別々の最小権限AWS credentialsを用意すること

通常開発用のAWS resourcesはCompose起動前に `infra/terraform/` で用意してください。既存環境を使う場合も、この通常開発用stateの出力とIAM userを確認します。S3 / SQSは実AWSを使用するため、Composeだけでは作成されません。

`infra/terraform-e2e/` と `compose.e2e.yaml`、`setup_reliability_env.sh --start-services` はReliability E2E専用です。これらの準備・起動手順は後述の [Reliability E2E（Phase 2）](#reliability-e2ephase-2) を参照してください。

### Configuration

`app/.env.example` を `app/.env` にコピーし、placeholderと認証情報を通常開発用の値へ置き換えます。既存の `.env` がある場合は上書きせず、内容を確認・更新してください。

通常開発用Terraformの出力は、repository rootから次のコマンドで確認できます。

```sh
terraform -chdir=app/infra/terraform output
```

`aws_region`、`video_input_bucket_name`、`video_output_bucket_name`、`video_encoding_queue_url` をそれぞれ `.env` の `AWS_REGION`、`VIDEO_INPUT_BUCKET`、`VIDEO_OUTPUT_BUCKET`、`VIDEO_ENCODING_QUEUE_URL` に反映します。`playback_base_url` を必須の `PLAYBACK_BASE_URL` に設定し、`OUTPUT_S3_ENDPOINT` はOutput bucketのS3 endpointに合わせます。`api_local_execution` / `worker_local_execution` のIAM userに対応する認証情報を `API_AWS_*` / `WORKER_AWS_*` に設定してください。Terraformはaccess keyを発行しません。

E2Eセットアップを `source` したシェルでは、AWS接続先・Worker設定・API URLなどがexportされています。Composeではシェルの環境変数が `--env-file` の値より優先されるため、通常開発はE2E設定を読み込んでいない新しいターミナルで実行してください。シェルの起動設定でもこれらをexportしている場合は解除し、`.env` 自体にもE2E用の接続先や認証情報が残っていないことを確認します。

主なruntime variablesは次のとおりです。

| Variable | Consumer | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | host上のAPI / Worker / tests | hostからPostgreSQLへ接続 |
| `COMPOSE_DATABASE_URL` | Compose API / Worker / migration | Compose network内のPostgreSQLへ接続 |
| `AWS_REGION` | API / Worker | AWS region |
| `VIDEO_ENCODING_QUEUE_URL` | Worker | SQS queue URL |
| `VIDEO_INPUT_BUCKET` | API / Worker | upload先とsource read元 |
| `VIDEO_OUTPUT_BUCKET` | API / Worker | HLS write先 |
| `OUTPUT_S3_ENDPOINT` | API | S3接続先。CloudFront URLを設定しない |
| `PLAYBACK_BASE_URL` | API | 必須のCloudFront HTTPS origin。Terraformの `playback_base_url` を設定する |
| `FRONTEND_ORIGIN` | API / S3 configuration | 許可するbrowser origin |
| `VITE_API_BASE_URL` | Frontend | Go API base URL。既定は `http://localhost:8080/api/v1` |
| `HTTP_ADDR` | API | listen address。Compose内は `0.0.0.0:8080` |
| `FFMPEG_PATH` | Worker / E2E fixture | FFmpeg executable path |
| `TMPDIR` | Worker | per-job temporary directory root |
| `API_AWS_*` | Compose API | API専用AWS credentials |
| `WORKER_AWS_*` | Compose Worker | Worker専用AWS credentials |
| `WORKER_HEARTBEAT_INTERVAL_SECONDS` | Worker | heartbeat間隔（秒） |
| `WORKER_VISIBILITY_EXTENSION_SECONDS` | Worker | SQS visibility延長（秒） |
| `WORKER_LEASE_DURATION_SECONDS` | Worker | DB lease期間（秒） |
| `WORKER_RETRY_DELAY_SECONDS` | Worker | 再試行の固定遅延（秒） |
| `WORKER_MAXIMUM_ATTEMPTS` | Worker | lease取得の試行上限（1〜10） |
| `WORKER_MAX_CONCURRENCY` | Worker | process内同時処理数。Compose既定2、Fargate設定1 |
| `WORKER_RUNTIME_MODE` | Worker | `local` / `ecs`。Composeは `local` 固定、cloudは `ecs` |
| `ORCHESTRATION_STATE_MACHINE_ARN` | Worker | 未設定なら新規jobはcli、設定時はdistributed |
| `DATABASE_CA_CERT_PATH` | Worker | cloud DBのCA bundle。TLSでは `sslmode=verify-full` が必要 |
| `WORKER_MAX_SOURCE_BYTES` | Worker | source上限。既定64 MiB（APIの5 GiB上限とは別） |
| `WORKER_MAX_TEMP_BYTES` | Worker | job一時領域の上限。既定512 MiB |
| `WORKER_DISK_RESERVE_BYTES` | Worker | 空きdiskのreserve。既定256 MiB |
| `WORKER_FFMPEG_THREADS` | Worker | FFmpeg threads。既定1 |
| `WORKER_MAX_DURATION_SECONDS` | Worker | source動画長の上限。既定3600秒 |
| `WORKER_MAX_WALL_SECONDS` | Worker | 処理時間の上限。既定7200秒 |

上記の `WORKER_MAX_*` などは親Workerの設定です。現在の `encode-child` entrypointは環境変数からこの設定を読み込まず、`Limits::default()` を使用します。親の上限を変更しても子のsource上限64 MiBなどは変わりません。

heartbeat間隔の2倍がlease期間・visibility延長・sourceキューのvisibility以下になるよう設定します。通常Composeの既定値は順に30 / 120 / 300 / 900秒、5試行です。Reliability E2Eは専用Terraformの5 / 120 / 60 / 10秒、3試行を使い、統合セットアップで反映します。

### Playback CloudFront URL Settings

GitHub ActionsではRepository variablesの `PLAYBACK_BASE_URL` に、E2EのOutput bucketを配信するCloudFront HTTPS originを設定してください。値はTerraformの `playback_base_url` 出力で確認できます。`merge-tests.yml`、`agent-execute.yml`、`agent-review.yml` はこの値を起動処理とE2Eへ渡します。CIの `start-e2e-compose.sh` はTerraformを参照せず、未設定・不正値ならDocker操作前に停止します。E2Eは返されたmanifestのoriginがこの設定と一致することを検証します。

APIは必須の `PLAYBACK_BASE_URL` に公開manifest key（legacy jobは従来のHLS key）を連結します。S3への自動フォールバックはありません。ユーザー情報、パス、クエリ、フラグメントを含まないHTTPS originを指定してください。末尾のスラッシュは正規化します。APIのループバックHTTP許可はローカルテスト用です。

Reliability E2Eの統合セットアップは `--playback-url` → 環境変数 `PLAYBACK_BASE_URL` → Terraform出力 `playback_base_url` の順で取得し、コンテナ起動前に検証します。明示的に指定した空値・不正値はエラーになります。Terraform未適用などで出力を取得できない場合も起動を停止します。

単独の `generate_reliability_env.mjs` はTerraformを参照しないため、`--playback-url` または環境変数を指定してください。`OUTPUT_S3_ENDPOINT` には引き続きS3の接続先を設定します。

### Start the complete local stack

repository rootから `app/` へ移動し、通常用の `compose.yaml`、`.env`、プロジェクト名 `app`（このディレクトリの既定名）を明示して起動します。

```sh
cd app
docker compose -p app --env-file .env -f compose.yaml config --quiet
docker compose -p app --env-file .env -f compose.yaml up --build -d
docker compose -p app --env-file .env -f compose.yaml ps -a
```

`postgres`、`api`、`worker`、`frontend` が起動し、`migrate` が終了コード0で完了していることを確認します。通常用PostgreSQLのコンテナ名は `streaming-video-postgres`、データvolume名は `streaming-video-postgres-data` です。

Reliability E2Eの既定プロジェクト名は `streaming-video-e2e` です。Frontend / APIの既定ポートは通常環境と重なるため、E2Eが起動中の場合はテスト終了後にその環境を停止してから通常環境を起動してください。プロジェクトを分けてもAWS接続先は自動では分離されないため、前述の `.env` とシェル環境の確認が必要です。

既定の接続先は次のとおりです。

- Frontend: `http://localhost:5173`
- Go API: `http://localhost:8080/api/v1`
- API health: `http://localhost:8080/api/v1/health`
- PostgreSQL host port: `5432`

ログ確認と停止:

```sh
docker compose -p app --env-file .env -f compose.yaml logs -f api worker frontend
docker compose -p app --env-file .env -f compose.yaml down
```

ローカルPostgreSQL dataを含むvolume削除は破壊的です。必要な場合だけ、[local Compose runbook](./docs/runbooks/local-compose.md) の注意事項を確認してください。

### Cloud deployment

通常のクラウド配置は [Cloud runtime](./docs/runbooks/cloud-runtime.md)、Workerの起動・保護・Auto Scalingは [Worker scaling](./docs/runbooks/worker-scaling.md) に従います。

1. 共通delivery rootを適用し、CloudFront / OACとprivate Output S3を確認します。
2. compute rootの別state、`shared_state_path`、ACM certificate、Frontend origin、application DB secret ARNを設定します。
3. ECRを先に作成し、API / Worker imagesをpushしてdigestを固定します。
4. API / Workerのdesired countを0、autoscalingを無効にしてcomputeを配備し、DB application role・verified TLS接続・secretを準備します。
5. 新規DBではmigration 0001〜0003の成功を確認してAPIを開始します。既存DBは未適用migrationだけを適用します。
6. 証明書が対応する独自DNS名でAPIを確認し、Workerとautoscalingを開始します。computeのWorkerにはStep Functions ARNが設定され、新規jobをdistributedで処理します。

RDSはprivate subnet、API / Worker tasksはpublic subnetで外向き通信にpublic IPを使い、NAT Gatewayを置かないMVP構成です。Workerにinbound port / ALBはありません。TerraformのALB生成hostnameは独自証明書の対象ではないため、FrontendのAPI URLには証明書に対応するDNS名を使います。

既存環境からの切替は [CloudFront delivery](./docs/runbooks/cloudfront-delivery.md) と [Distributed encoding](./docs/runbooks/distributed-encoding.md) を参照してください。公開pointerを扱えるAPI・schema・Workerを揃え、既存jobのmodeと公開済みobjectsを維持します。

## Validation / Tests

以下は現在リポジトリに存在する検証方法です。コマンドはrepository rootから実行します。

### Shared contracts

Root Python projectはPython 3.11以上、PyYAML、jsonschemaを定義しています。

```sh
python -m pip install -e .
python app/scripts/validate_contracts.py
```

OpenAPI外部参照、API examples、job statuses、`FAILED` / `failure` semantics、S3 event fixture、storage / reliability / scalability契約、親子入力と結果fixtureの整合を検証します。

### Terraform architecture contract

```sh
python app/scripts/validate_terraform_contracts.py --stage orchestration
```

このvalidatorはTerraform CLIやAWSへ接続せず、compute、共通delivery / reliability、Scalability E2E rootを静的に検証します。CloudFront/OACとprivate bucket、IAM、migration、Worker、scaling、Step Functionsも対象です。静的検証は実AWSへの配備・稼働確認とは別です。

### Component tests

```sh
go test -C app/backend/api ./...
cargo test --manifest-path app/backend/worker/Cargo.toml --workspace --locked

npm --prefix app/frontend ci
npm --prefix app/frontend run test:unit -- --run
npm --prefix app/frontend run build
npm --prefix app/frontend run test:e2e:helpers
npm --prefix app/frontend run test:e2e:type-check
```

### Pipeline / Delivery E2E

Full E2Eはmock storageではなく、実際のS3/SQSとローカルCompose stackを使用します。disposableなE2E環境を使ってください。テストはAWSへ動画とHLS objectsを作成します。

必要なAWS resource variables、`PLAYBACK_BASE_URL`、API / Worker credentialsをshell environmentへ設定した後、repository rootからBashで起動します。起動scriptはTerraformを参照せず、playback originの未設定・不正値はDocker操作前に拒否します。

```sh
bash app/scripts/start-e2e-compose.sh
```

このscriptは既定でAPI host portを `8000`、Frontendを `5173` にし、両serviceとWorkerの起動を待ちます。Playwright用MP4 fixtureを生成するため、host側にもFFmpegが必要です。

browser runnerには、同じOutput bucketの `E2E_OUTPUT_BUCKET`、12桁の `E2E_AWS_ACCOUNT_ID`、`AWS_REGION`、`PLAYBACK_BASE_URL`、`OUTPUT_S3_ENDPOINT` をexportしておきます。`OUTPUT_S3_ENDPOINT` は `https://<bucket>.s3.<region>.amazonaws.com` と一致させます。delivery preflight用のAWS CLI観測権限とPlaywright browserも必要です。

```sh
E2E_ENVIRONMENT=disposable \
E2E_FRONTEND_URL=http://localhost:5173 \
E2E_API_URL=http://127.0.0.1:8000 \
E2E_PROJECT=chromium \
FFMPEG_PATH=/usr/bin/ffmpeg \
npm --prefix app/frontend run test:e2e
```

E2Eは、Browserの単一direct PUT、状態遷移、HLS object layout / content types、CloudFront経由のmanifest / segments GET、video.js初期化、再生時間の進行を確認します。delivery preflight / regressionはOAC・bucket policy、S3匿名アクセス拒否、完了済みjobの再生を検証します。内部result JSONのdenyはTerraform契約validatorの対象です。必要な観測権限と実行設定は [CloudFront delivery runbook](./docs/runbooks/cloudfront-delivery.md) を参照してください。

### Reliability E2E（Phase 2）

専用AWS環境、ホスト・Worker・API認証、正常／不正MP4、Linux版Node.js、Terraform、AWS CLI、Docker Compose、ホストFFmpeg・Chromiumを準備します。詳細は [運用ガイド](./frontend/e2e/reliability/runner.md) に集約しています。

リポジトリルートのWSL / Linux Bashで実行します。アカウントとfixtureパスは対象環境に置き換えてください。

```bash
source app/scripts/setup_reliability_env.sh \
  --account 123456789012 \
  --fixture "$HOME/e2e/long.mp4" \
  --invalid-fixture "$HOME/e2e/invalid.mp4" \
  --start-services
```

成功後、同じシェルで以下を順に実行し、失敗した場合は後続へ進みません。

```bash
python app/scripts/run_reliability_e2e.py --check
python app/scripts/run_reliability_e2e.py --live-preflight
python app/scripts/run_reliability_e2e.py --scenario preflight
python app/scripts/run_reliability_e2e.py --full
```

起動済み環境の設定を読み込む場合は同じ引数から起動オプションを省略します。設定やコンテナを更新する場合はE2E終了後に再セットアップします。

フル実行は重複配送、crash recovery、長時間heartbeat、FFmpeg試行上限、poison隔離、キュー監視を実施し、最後に新規アップロードとブラウザ再生を検証します。証跡は既定で `artifacts/reliability-e2e/` に保存されます。DLQメッセージが人手確認用に残るシナリオがあり、無条件のpurgeや再投入は行いません。

delivery preflightと完了済みjobの再生もまとめて実行する場合は `--full-suite` を使います。切替前のPhase 1 / 2 jobとの互換性確認には別途historical inventoryと証跡が必要で、通常の成功だけでその受入条件まで満たしたことにはなりません。詳細は [CloudFront delivery runbook](./docs/runbooks/cloudfront-delivery.md) を参照してください。

helperテストはオフラインで実行できますが、実環境シナリオはAWSへの書き込みやWorker停止を伴います。通常のpipeline E2E起動スクリプトを専用セットアップの代用にはしません。

### Scalability E2E（Phase 3）

[Scalability E2E runbook](./docs/runbooks/scalability-e2e.md) と [専用Terraform設定](./infra/terraform-e2e/scalability/README.md) に従い、delivery / computeのstate・data directoryをリポジトリ外の専用runtime directoryへ分離します。通常環境やReliability E2Eのstateは流用しません。API、Worker、RDS、Step Functions、Auto Scalingを配備し、Frontendを別途起動してから実行します。

WSL / Linux Bashで、配備済み環境の値と、720p以上かつ実測処理時間を校正したfixtureを指定します。

```bash
source app/scripts/setup_scalability_env.sh \
  --runtime "$SCALABILITY_RUNTIME" \
  --account 123456789012 \
  --api-url "$API_URL" \
  --frontend-url "$FRONTEND_URL" \
  --fixture "$FIXTURE_PATH"

python app/scripts/run_scalability_e2e.py --check
```

setupはTerraform outputs・AWS identity・endpoint・fixtureを確認してprivate `handoff.json` とshell設定を生成します。AWS配備、service起動、負荷投入は行いません。`--check` はAWSに接続しない設定検証です。成功後に、runごとに新しい証跡先を指定して実行します。

```bash
export SCALABILITY_E2E_EVIDENCE_DIR="$SCALABILITY_E2E_EVIDENCE_ROOT/run-001"
SCALABILITY_E2E_ALLOW_LIVE=true \
python app/scripts/run_scalability_e2e.py --full
```

事前に決めたbatchを並列uploadし、親Workerのscale-out・job同時処理、子encoderの実行時間の重なり、全job完了、scale-in、同じjobのABR browser playbackを検証します。実環境のimage digests、service、state machine、scaling policyとalarmsを照合し、証跡を保存します。通常のbrowser E2EやReliability runnerにはこの負荷試験を含めません。設定例のtargetは900 / 300 = 3 messages / Worker、範囲1〜4、cooldownはscale-out 180秒 / scale-in 600秒です。実行予算、fixture校正、後片付けはrunbookを参照してください。

## Phase Scope

ロードマップの原典は [ADR-001](./docs/adr/adr-001-video-streaming-mvp-architecture.md) です。以下は `dev/phase3` の実装状況であり、Phase 1のS3直配信は現在CloudFront配信へ移行しています。

### Phase 1 — implemented pipeline

- Browser -> Go APIでvideo/job作成とPresigned PUT URL発行
- Browser -> Input S3への直接upload
- Input S3 `ObjectCreated:*` -> SQS Standard Queue
- Rust WorkerによるS3 event解析とatomic claim
- PostgreSQLによる5状態のjob管理
- FFmpeg CLIによる単一品質HLS生成
- segments -> `index.m3u8` -> `COMPLETED` の公開順序
- Output S3からのdirect HLS playbackとCORS
- Vue Frontendによるupload、polling、video.js playback
- ローカルCompose runtimeと実AWSを使うPlaywright E2E harness
- S3、SQS、IAMのPhase 1 Terraform configuration

ソースコードとテストharnessは存在しますが、実際のE2E成功には正しく構成されたAWS resourcesとcredentialsが必要です。リポジトリだけで特定AWS環境へのデプロイ済み状態までは保証しません。

### Phase 2 — implemented reliability

- DB lease取得・更新・期限切れ再取得、owner条件付きの状態更新
- SQS visibilityとDB leaseのheartbeat、所有権喪失時の処理中断
- 固定遅延・試行上限付き再試行、完了済み再配送での再処理防止
- DLQ / poison隔離、キューのCloudWatch metrics / alarmsと証跡
- DB接続終了の監視とWorker異常終了、進行中のSQS受信の保持
- 専用Terraform / Compose、統合セットアップ、障害注入E2Eと復旧runbook

### Phase 3 — implemented delivery and distributed encoding

- CloudFront / OAC、private Output S3、内部result JSONの配信拒否とdelivery E2E
- nullable公開manifest pointerを解決するAPI、legacy completed jobとの互換性
- VPC、private RDS、HTTPS ALB、API / Worker Fargate services、ECR、migration task、CloudWatch logs
- Worker resource limits、verified TLS、SIGTERM対応、ECS task protection
- backlog-per-workerのAuto Scaling（初期1〜4 tasks）
- Standard Step Functions、最大2つのFargate encoderによるrendition並列処理
- 360p / 720p、attempt別成果物、親による検証・ABR master公開・owner条件付き完了
- 専用Scalability E2E環境、handoff生成、負荷・並列処理・scale-in・ABR再生の検証

AWS Batch、segment単位の分散処理、scale-to-zero、FFmpeg C API / libav FFIは未実装です。エンコードは両modeともFFmpeg CLIを使います。

## Known Limitations / Non-goals

- Authentication、user management、authorizationはありません。
- APIの入力は空でないMP4 1ファイル、最大5 GiB、単一Presigned PUTです。multipart uploadはありません。Worker source上限は既定64 MiB（設定上限1 GiB）で、API受付成功はエンコード成功を保証しません。
- HLSはH.264/AAC、6秒MPEG-TS segmentsです。cliは単一品質、distributedは固定360p / 720pで、upscaleは行いません。字幕、thumbnail、live streamingはありません。
- S3 originはprivateですが、CloudFrontのviewer配信は公開HTTPSです。viewer認証・署名付きURL / cookieはなく、APIの409 gateはURLを知るviewerへのアクセス認可ではありません。
- Frontendホスティング、DNS / ACM certificate、DB application secretの準備は運用者が行います。RDSはSingle-AZのMVP構成です。
- WorkerはS3 source object全体をmemoryへ収集してからlocal diskへ書き、upload時も各HLS fileをmemoryへ読み込みます。大容量・高並列処理向けではありません。
- 復旧はSQS再配送と残り試行回数が前提です。全ジョブを巡回する自動修復やDLQ自動再投入はありません。メッセージ削除・DLQ移動後にQUEUED / PROCESSINGが残った場合は状態確認と手動復旧が必要です。
- busy・無効通知・FAILEDはdeleteせず、SQS redriveに任せます。受信回数とDB試行回数は一致するとは限らず、DLQ移動だけでは非終端ジョブをFAILEDにしません。
- 分散処理はrendition単位です。子ごとにsource download / decodeを行うためCPUと転送が重複します。親がSQSを保持するため、処理はdeadlineとSQSの12時間上限内に終える必要があります。
- CORSは単一の設定済みFrontend originを前提とします。
- Terraform stateはlocal backendです。Scalability E2Eは専用delivery / compute stateを使い、共有remote backendは提供していません。実AWS試験には専用環境と認証・観測権限が必要です。

アーキテクチャの背景とPhaseごとの判断理由は [ADR-001](./docs/adr/adr-001-video-streaming-mvp-architecture.md)、storageと状態遷移の厳密な規約は [storage conventions](./contracts/domain/storage-conventions.md) を参照してください。
