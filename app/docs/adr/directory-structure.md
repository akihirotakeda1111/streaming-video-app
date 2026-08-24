# streaming-video-app モノレポ構成案

## 0. 前提と構成方針

配置先は `\streaming-video-app\app` とし、この `app` ディレクトリをモノレポのルートとして扱う。

- フロントエンド: Vue.js + TypeScript + Vite
- API / Control Plane: Go
- エンコードワーカー / Data Plane: Rust + FFmpeg
- インフラ: AWS + Terraform
- 開発環境: 原則ローカル。S3、SQSなど、実AWSでの確認が必要なリソースだけ先行構築してよい
- AWS環境: `dev` / `prod` には分割しない
- Terraform: root configurationは `infra/terraform` の1つだけとする
- ディレクトリ: `phase1`、`phase2`、`phase3` のようなPhase単位のトップレベルディレクトリは作らない
- 開発方法: 責務別の同じ構成を維持し、Phaseが進むごとに実装、契約、Terraform moduleを追加する

開発途中でも、Terraformの原則は次の状態を維持する。

```text
infra/terraform/main.tf に定義されているリソース
    =
現時点でAWSに存在すべきリソース
```

S3とSQSだけを先行利用する場合は、まずそのmoduleだけをroot configurationに定義し、後続PhaseでCDN、監視、コンピュートなどを追加する。`terraform apply -target=...` の常用は避ける。

---

## 1. 最終的な構成

Phase 3まで完了した時点の想定構成を以下に示す。

```text
\streaming-video-app\
└── app\
    ├── frontend\                         # Vue.jsフロントエンド
    │   ├── public\
    │   ├── src\
    │   │   ├── app\
    │   │   │   ├── router\              # 画面ルーティング
    │   │   │   └── stores\              # アプリ全体の状態管理
    │   │   ├── features\
    │   │   │   └── videos\
    │   │   │       ├── api\             # upload/status/playback APIクライアント
    │   │   │       ├── components\      # Uploader、Player、進捗・失敗表示
    │   │   │       ├── composables\
    │   │   │       ├── stores\
    │   │   │       ├── types\           # Video、Job、Renditionなど
    │   │   │       └── views\
    │   │   ├── shared\
    │   │   │   ├── components\
    │   │   │   └── lib\
    │   │   │       ├── api\             # HTTPクライアント共通処理
    │   │   │       └── hls\             # HLS/ABRプレイヤー初期化
    │   │   ├── App.vue
    │   │   └── main.ts
    │   ├── tests\
    │   │   ├── unit\
    │   │   └── e2e\
    │   ├── Dockerfile
    │   ├── package.json
    │   ├── tsconfig.json
    │   └── vite.config.ts
    │
    ├── backend\
    │   ├── api\                          # Go API / Control Plane
    │   │   ├── cmd\
    │   │   │   └── api\
    │   │   │       └── main.go
    │   │   ├── internal\
    │   │   │   ├── config\
    │   │   │   ├── video\               # 動画メタデータ、状態、再生情報
    │   │   │   │   ├── handler.go
    │   │   │   │   ├── service.go
    │   │   │   │   ├── model.go
    │   │   │   │   └── repository.go
    │   │   │   ├── upload\              # Presigned URL発行
    │   │   │   ├── job\                 # job生成、冪等性、再実行制御
    │   │   │   ├── playback\            # HLS/CloudFront再生URL発行
    │   │   │   ├── storage\             # S3 adapter
    │   │   │   ├── queue\               # SQS adapter
    │   │   │   ├── database\            # PostgreSQL adapter
    │   │   │   ├── middleware\
    │   │   │   └── observability\        # 構造化ログ、メトリクス、trace連携
    │   │   ├── migrations\
    │   │   ├── tests\
    │   │   │   ├── integration\
    │   │   │   └── e2e\
    │   │   ├── Dockerfile
    │   │   ├── go.mod
    │   │   └── go.sum
    │   │
    │   └── worker\                       # Rust encoding worker / Data Plane
    │       ├── src\
    │       │   ├── bin\
    │       │   │   ├── worker.rs         # SQS consumer / orchestration入口
    │       │   │   └── encode_task.rs    # 分散エンコード実行単位
    │       │   ├── config.rs
    │       │   ├── job\
    │       │   │   ├── consumer.rs
    │       │   │   ├── idempotency.rs
    │       │   │   ├── lease.rs
    │       │   │   ├── heartbeat.rs
    │       │   │   └── retry.rs
    │       │   ├── encode\
    │       │   │   ├── ffmpeg_cli.rs     # 初期実装・フォールバック
    │       │   │   ├── ffmpeg_api.rs     # FFmpeg C API連携候補
    │       │   │   ├── probe.rs
    │       │   │   ├── segment.rs
    │       │   │   ├── abr.rs
    │       │   │   └── hls.rs
    │       │   ├── profiles\             # ABR rendition定義
    │       │   ├── storage\              # S3入出力
    │       │   ├── queue\                # SQS、DLQ連携
    │       │   ├── database\             # job/lease/進捗更新
    │       │   ├── orchestration\        # Step Functions連携
    │       │   └── observability\
    │       ├── tests\
    │       │   ├── fixtures\
    │       │   ├── integration\
    │       │   └── e2e\
    │       ├── Cargo.toml
    │       ├── Cargo.lock
    │       └── Dockerfile
    │
    ├── infra\
    │   └── terraform\                    # 唯一のTerraform root
    │       ├── main.tf
    │       ├── providers.tf
    │       ├── versions.tf
    │       ├── variables.tf
    │       ├── outputs.tf
    │       ├── locals.tf
    │       ├── terraform.tfvars.example
    │       ├── definitions\
    │       │   └── encoding-workflow.asl.json
    │       └── modules\
    │           ├── iam\
    │           ├── network\
    │           ├── storage\              # S3 input/output
    │           ├── queue\                # SQS + DLQ
    │           ├── database\             # RDS PostgreSQL
    │           ├── api\                  # ECS/Fargate API
    │           ├── worker\               # ECS/Fargate常駐worker
    │           ├── encoding_compute\     # ECS taskまたはAWS Batch
    │           ├── orchestration\        # Step Functions
    │           ├── cdn\                  # CloudFront + OAC
    │           └── monitoring\           # CloudWatch logs/metrics/alarms
    │
    ├── contracts\                        # 言語間・サービス間の共通契約
    │   ├── openapi\
    │   │   └── api.yaml
    │   ├── events\
    │   │   ├── encoding-requested.schema.json
    │   │   ├── encoding-progress.schema.json
    │   │   └── encoding-completed.schema.json
    │   └── examples\
    │
    ├── config\
    │   └── encoding-profiles.yaml         # ABR ladderなどの共有設定
    ├── docs\
    │   ├── architecture\
    │   ├── adr\
    │   └── runbooks\                     # retry、DLQ、障害対応
    ├── scripts\                          # ローカル起動・検証・fixture作成
    ├── compose.yaml                      # ローカル開発環境
    ├── Makefile
    ├── .env.example
    ├── .gitignore
    └── README.md
```

`encoding_compute` は、Phase 3で採用する実行基盤に応じてECS taskまたはAWS Batchを実装する。両方を同時運用する必要はない。Step Functionsは分割されたエンコード処理の実行、再試行、集約を管理する。

---

## 2. Phase 1の構成

### 2.1 目的

最小の正常系E2Eを成立させる。

```text
Vue.js
  ↓ アップロード要求
Go API
  ↓ Presigned URL発行
Browser → S3 input
             ↓ イベント通知
            SQS
             ↓ consume
        Rust Worker
             ↓ FFmpeg
          HLS生成
             ↓
         S3 output
             ↓
       Browserで再生
```

この段階ではAPI、worker、PostgreSQL、フロントエンドをローカルで動かす。Presigned URL、S3イベント、SQSを実際に確認するため、`storage`、`queue`、および必要最小限の`iam`だけをAWSへ先行構築してよい。

### 2.2 ディレクトリ構成

```text
\streaming-video-app\app\
├── frontend\
│   ├── src\
│   │   ├── app\
│   │   │   ├── router\
│   │   │   └── stores\
│   │   ├── features\videos\
│   │   │   ├── api\                     # upload/status/playback API
│   │   │   ├── components\
│   │   │   │   ├── VideoUploader.vue
│   │   │   │   ├── EncodingStatus.vue
│   │   │   │   └── VideoPlayer.vue
│   │   │   ├── types\
│   │   │   └── views\
│   │   ├── shared\lib\
│   │   │   ├── api\
│   │   │   └── hls\
│   │   ├── App.vue
│   │   └── main.ts
│   ├── tests\
│   ├── Dockerfile
│   ├── package.json
│   └── vite.config.ts
│
├── backend\
│   ├── api\
│   │   ├── cmd\api\main.go
│   │   ├── internal\
│   │   │   ├── config\
│   │   │   ├── video\                   # 動画状態を管理
│   │   │   ├── upload\                  # Presigned PUT URL発行
│   │   │   ├── playback\                # HLS URL返却
│   │   │   ├── storage\                 # S3 adapter
│   │   │   └── database\                # ローカルPostgreSQL
│   │   ├── migrations\
│   │   ├── tests\
│   │   ├── Dockerfile
│   │   └── go.mod
│   │
│   └── worker\
│       ├── src\
│       │   ├── main.rs                   # SQS consume → encode → upload
│       │   ├── config.rs
│       │   ├── job\consumer.rs
│       │   ├── encode\
│       │   │   ├── ffmpeg_cli.rs
│       │   │   ├── probe.rs
│       │   │   └── hls.rs
│       │   ├── storage\                  # S3 download/upload
│       │   ├── queue\                    # SQS consumer
│       │   └── database\                 # status更新
│       ├── tests\
│       ├── Cargo.toml
│       └── Dockerfile
│
├── infra\terraform\
│   ├── main.tf                           # iam/storage/queueのみ定義可
│   ├── providers.tf
│   ├── versions.tf
│   ├── variables.tf
│   ├── outputs.tf
│   ├── terraform.tfvars.example
│   └── modules\
│       ├── iam\                          # ローカル実行主体向け最小権限
│       ├── storage\                      # input/output bucket、S3通知
│       └── queue\                        # encoding request queue
│
├── contracts\
│   ├── openapi\api.yaml
│   ├── events\encoding-requested.schema.json
│   └── examples\
├── docs\architecture\
├── scripts\
├── compose.yaml                          # frontend/api/worker/postgres
├── .env.example
├── Makefile
└── README.md
```

### 2.3 Phase 1の完了条件

- ブラウザがGo APIからPresigned URLを取得できる
- ブラウザからS3 input bucketへ動画を直接アップロードできる
- S3イベントをSQS経由でRust workerが受信できる
- Rust workerがFFmpegで単一品質のHLSを生成し、S3 output bucketへ配置できる
- Go APIから処理状態と再生URLを取得し、Vue.js画面でHLSを再生できる
- 上記フローを再現するE2Eテストまたは手順が`tests`または`docs`に存在する

---

## 3. Phase 2の構成

### 3.1 目的

Phase 1の正常系を維持したまま、重複実行、worker停止、一時障害、毒メッセージ、非公開配信に耐えられる構成へ成長させる。

主な追加要素は以下とする。

- job ID / object key等を使った冪等性
- DB上のlease取得と期限切れleaseの回収
- 長時間エンコード中のSQS visibility timeout heartbeat
- 一時障害への指数バックオフretry
- 最大試行回数超過後のDLQ移送
- CloudWatch Logs、メトリクス、アラーム
- CloudFront + Origin Access Control（OAC）による非公開S3配信
- Terraformによる上記AWSリソースのIaC化

### 3.2 ディレクトリ構成

Phase 1のディレクトリを残したまま、次の責務を追加する。

```text
\streaming-video-app\app\
├── frontend\src\features\videos\
│   ├── api\
│   ├── components\
│   │   ├── EncodingStatus.vue
│   │   ├── EncodingFailure.vue           # 失敗理由と再試行可否
│   │   └── VideoPlayer.vue
│   ├── stores\                           # polling、retry状態
│   └── types\                            # retry_count、failure_code等
│
├── backend\
│   ├── api\
│   │   ├── internal\
│   │   │   ├── video\
│   │   │   ├── job\
│   │   │   │   ├── service.go
│   │   │   │   ├── idempotency.go
│   │   │   │   └── retry.go
│   │   │   ├── playback\                 # CloudFront経由の再生URL
│   │   │   └── observability\            # 構造化ログ、相関ID
│   │   ├── migrations\                   # job、attempt、lease等を追加
│   │   └── tests\integration\
│   │
│   └── worker\
│       ├── src\
│       │   ├── job\
│       │   │   ├── consumer.rs
│       │   │   ├── idempotency.rs
│       │   │   ├── lease.rs
│       │   │   ├── heartbeat.rs           # SQS visibility延長
│       │   │   └── retry.rs
│       │   ├── queue\
│       │   │   ├── sqs.rs
│       │   │   └── dlq.rs
│       │   └── observability\             # log/metrics
│       └── tests\
│           ├── integration\
│           └── fixtures\                 # duplicate/timeout/failureケース
│
├── infra\terraform\                     # rootはPhase 1と同じ1つ
│   ├── main.tf                           # cdn/monitoring等を追加
│   ├── providers.tf
│   ├── versions.tf
│   ├── variables.tf
│   ├── outputs.tf
│   ├── terraform.tfvars.example
│   └── modules\
│       ├── iam\
│       ├── storage\                      # S3 public access block
│       ├── queue\                        # redrive policy、DLQ
│       ├── cdn\                          # CloudFront + OAC
│       └── monitoring\                   # log group、metric、alarm
│
├── contracts\events\
│   ├── encoding-requested.schema.json
│   ├── encoding-progress.schema.json
│   ├── encoding-completed.schema.json
│   └── encoding-failed.schema.json
│
└── docs\runbooks\
    ├── retry-and-idempotency.md
    └── dlq-redrive.md
```

### 3.3 Phase 2の完了条件

- 同一メッセージを複数回受信しても、完成済み成果物を破壊せず処理結果が一意になる
- workerが停止してもlease期限切れ後に別workerが安全に処理を引き継げる
- エンコード中はvisibility timeoutが延長され、同一jobの不要な並列実行を抑制できる
- 一時障害はretryされ、恒久障害は規定回数後にDLQへ送られる
- DLQ件数、失敗率、処理時間、queue滞留をCloudWatchで確認・通知できる
- S3 output bucketを公開せず、CloudFront + OAC経由でHLSを再生できる
- AWS側の構成を単一のTerraform rootから再現できる

---

## 4. Phase 3の構成

### 4.1 目的

長時間動画や処理量増加に対応できるよう、エンコード処理を分割・並列化し、複数品質のABR配信へ拡張する。必要に応じてFFmpeg CLI実行からFFmpeg C API連携へ移行し、より細かな処理制御とオーバーヘッド削減を図る。

想定フローは以下とする。

```text
SQS / Go API
    ↓
Step Functions
    ├── probe / 分割計画
    ├── segment/rendition単位の並列ECS taskまたはAWS Batch job
    ├── retry / timeout / 失敗集約
    └── master playlist生成・成果物確定
                       ↓
                S3 output
                       ↓
             CloudFront + OAC
                       ↓
                 Vue.js ABR再生
```

### 4.2 ディレクトリ構成

Phase 2の構成へ、分散実行、ABR、FFmpeg C API連携の責務を追加する。

```text
\streaming-video-app\app\
├── frontend\src\features\videos\
│   ├── components\
│   │   ├── EncodingProgress.vue          # 全体・rendition別進捗
│   │   ├── QualitySelector.vue           # Auto/手動品質選択
│   │   └── VideoPlayer.vue               # ABR master playlist対応
│   ├── stores\
│   └── types\                            # Rendition、Segment、Progress
│
├── backend\
│   ├── api\
│   │   ├── internal\
│   │   │   ├── video\
│   │   │   ├── job\                     # 分割jobと集約状態
│   │   │   ├── playback\                # master playlist返却
│   │   │   └── observability\
│   │   └── migrations\                  # rendition/segment/progress
│   │
│   └── worker\
│       ├── src\
│       │   ├── bin\
│       │   │   ├── worker.rs             # orchestration要求
│       │   │   └── encode_task.rs        # 独立実行可能なencode task
│       │   ├── encode\
│       │   │   ├── ffmpeg_cli.rs
│       │   │   ├── ffmpeg_api.rs         # FFmpeg C API wrapper
│       │   │   ├── probe.rs
│       │   │   ├── segment.rs
│       │   │   ├── abr.rs                # rendition生成
│       │   │   └── hls.rs                # media/master playlist
│       │   ├── profiles\
│       │   ├── orchestration\            # Step Functions入出力
│       │   └── observability\            # task/segment/rendition metrics
│       └── tests\
│           ├── integration\
│           ├── e2e\
│           └── fixtures\
│
├── infra\terraform\                     # 引き続き唯一のroot
│   ├── main.tf                           # compute/orchestrationを追加
│   ├── variables.tf
│   ├── outputs.tf
│   ├── definitions\
│   │   └── encoding-workflow.asl.json
│   └── modules\
│       ├── iam\
│       ├── network\
│       ├── storage\
│       ├── queue\
│       ├── database\
│       ├── api\                          # AWS最終配置時のECS/Fargate
│       ├── worker\                       # 常駐consumerが必要な場合
│       ├── encoding_compute\             # ECS taskまたはAWS Batch
│       ├── orchestration\                # Step Functions
│       ├── cdn\
│       └── monitoring\
│
├── contracts\events\
│   ├── encoding-requested.schema.json
│   ├── encoding-progress.schema.json
│   └── encoding-completed.schema.json
│
├── config\
│   └── encoding-profiles.yaml            # 解像度、bitrate、codec等
│
└── docs\architecture\
    ├── distributed-encoding.md
    └── abr-packaging.md
```

### 4.3 Phase 3の完了条件

- Step FunctionsからECS taskまたはAWS Batch jobを起動し、エンコード処理を分散実行できる
- task単位の失敗、timeout、retryをworkflowとして制御できる
- 複数renditionとmaster playlistを生成し、プレイヤーがABR再生できる
- 並列実行してもsegment、rendition、最終成果物の確定処理が冪等である
- 動画単位だけでなく、task/segment/rendition単位で進捗と処理時間を観測できる
- FFmpeg CLI版を維持しつつ、必要性を計測したうえでFFmpeg C API実装へ切り替えられる
- API、worker、RDS、S3、SQS、CloudFront、監視、分散エンコード基盤を単一Terraform rootでAWSへ構築できる

---

## 5. Phase間の成長方針

| 領域 | Phase 1 | Phase 2 | Phase 3 |
|---|---|---|---|
| Frontend | upload、status、単一品質HLS再生 | 失敗・retry表示、CloudFront再生 | ABR、品質選択、詳細進捗 |
| Go API | Presigned URL、状態、再生URL | 冪等性、再試行制御、可観測性 | 分散job、rendition/segment集約 |
| Rust worker | SQS consume、FFmpeg CLI、HLS生成 | lease、heartbeat、retry、DLQ | 分散task、ABR、FFmpeg C API候補 |
| AWS | 必要に応じS3/SQS/IAMのみ先行 | DLQ、CloudWatch、CloudFront/OAC | Step Functions、ECS taskまたはBatch、最終AWS配置 |
| Terraform | 単一rootで必要最小限のmodule | 同じrootへ信頼性moduleを追加 | 同じrootへcompute/orchestrationを追加 |

この構成により、各Phaseで既存コードを別ディレクトリへ移動せず、責務ごとの実装を段階的に強化できる。
