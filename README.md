# Streaming Video App

## Overview

このリポジトリは、ストリーミング動画アプリケーションと、その実装作業をMarkdownのTask Specから実行するオーケストレーターを含むモノレポです。

アプリケーションは個人開発、自己学習、ポートフォリオを目的としています。`dev/phase3` では、動画アップロード・HLS再生とPhase 2の信頼性機能に加え、CloudFront + OAC、private Output S3、Fargate / RDS、Worker Auto Scaling、Step Functionsによる分散エンコード・ABR、Scalability E2Eを実装しています。

```text
Browser
  -> Go APIでvideo/job作成とPresigned URL発行
  -> Input S3へ直接upload
  -> S3 ObjectCreated notification
  -> SQS
  -> Rust Worker（lease・heartbeat・再試行）
     -> cli: Worker内でFFmpegを実行
     -> distributed: Step Functions -> Fargate encoders（360p / 720p）
  -> private Output S3へHLSを配置、DBで公開を確定
  -> CloudFront / OAC -> Frontend / video.jsで再生
```

アプリケーションのアーキテクチャ、状態遷移、S3 object layout、環境変数、起動方法、テスト、Phaseごとの範囲は [app/README.md](./app/README.md) を参照してください。

## Repository Components

| Path | Role |
| --- | --- |
| `app/` | Frontend、Go API、Rust Worker、Terraform、共有contracts、ローカル実行環境 |
| `specs/tasks/` | 実装範囲、禁止事項、受入条件、検証コマンドを定義するMarkdown Task Specs |
| `agent/` | Task Specの解析、Codex実行、scope検査、validation、report作成、PR delivery、review処理 |
| `.agent/state/` | オーケストレーターの実行状態。runtime JSONはGit管理対象外 |
| `.github/workflows/` | Task Spec実行、PR review、アプリケーションtestのGitHub Actions |
| `pyproject.toml` | Pythonオーケストレーターのpackage・dependency・lint設定 |
| `.coderabbit.yaml` | CodeRabbitのrepository設定 |

`specs/tasks/` にはPhase 1〜3のTask Specがあります。実装済み機能と未対応範囲は以下のPhase Scopeを参照してください。

## Application

### Purpose

API process内で動画を同期変換せず、upload、job管理、queue consumption、encoding、playbackを別の責務として実装しています。

ローカルComposeではFrontend、Go API、Rust Worker、PostgreSQLを起動し、S3、SQS/DLQ、CloudFrontは実AWSを利用します。クラウド用TerraformではAPI・Worker・encoderをECS/Fargate、PostgreSQLをprivate RDSに配置します。Frontendのホスティングは別途用意します。

### Components

| Component | Responsibility | Main technology |
| --- | --- | --- |
| Frontend | MP4選択、S3 direct upload、status polling、HLS playback | Vue 3、TypeScript、Vite、video.js |
| Go API | video/job作成、Presigned PUT URL、status、playback情報 | Go、AWS SDK for Go v2、pgx |
| Rust Worker | SQS受信、lease・heartbeat、再試行、FFmpeg / 分散処理、公開確定 | Rust、Tokio、AWS SDK for Rust、FFmpeg |
| PostgreSQL | video metadata、job status、lease・attempt、処理mode・公開manifest key | PostgreSQL 16 / RDS |
| Infra | S3、SQS/DLQ、CloudFront/OAC、ECS/Fargate、RDS、Step Functions、Auto Scaling | Terraform、AWS |
| Contracts | REST API、job statuses、S3/HLS conventions、examples | OpenAPI 3.1、JSON Schema、Markdown |

公開APIのjob statusesは次の5つを維持します。再試行可能な失敗ではPROCESSINGからQUEUEDへ戻り、試行上限に達した失敗をFAILEDにします。

```text
UPLOADING -> QUEUED -> PROCESSING -> COMPLETED
                         \-> FAILED
             QUEUED <- PROCESSING (retry)
```

Input S3とOutput S3は分離されています。`cli` は単一品質HLSを生成します。`distributed` は最大2つのrenditionを並列生成し、親Workerが子の成果物を検証してmaster playlistを最後に公開します。公開manifest keyと `COMPLETED` の確定後にSQSをackします。配信はCloudFront経由で、Output S3への匿名アクセスと内部 `result.json` の配信は拒否します。

詳細:

- [Application README](./app/README.md)
- [OpenAPI contract](./app/contracts/openapi/api.yaml)
- [Job status schema](./app/contracts/domain/job-status.schema.json)
- [Storage conventions](./app/contracts/domain/storage-conventions.md)
- [Reliability contract](./app/contracts/domain/reliability-conventions.md)
- [Reliability E2E運用ガイド](./app/frontend/e2e/reliability/runner.md)
- [Scalability contract](./app/contracts/domain/scalability-conventions.md)
- [Cloud runtime](./app/docs/runbooks/cloud-runtime.md)
- [Distributed encoding](./app/docs/runbooks/distributed-encoding.md)
- [Scalability E2E](./app/docs/runbooks/scalability-e2e.md)
- [Architecture decision](./app/docs/adr/adr-001-video-streaming-mvp-architecture.md)

## Task Specs

`specs/tasks/*.md` は、オーケストレーターへ渡す実装単位です。各SpecはYAML frontmatterとMarkdown本文で構成されます。

主な定義項目は次のとおりです。

- Spec ID、title、base branch、target branch
- 変更を許可する `allowed_paths`
- 変更を禁止する `forbidden_paths`
- repair / reviewのattempt上限
- Objective
- Non-Goals
- Forbidden Actions
- Architecture Invariants
- 依存関係を持つTasks
- TaskごとのRequirement、Acceptance Criteria、Validation
- Final Verification

構文と必須項目は [Task Spec schema](./agent/schemas/task-spec.schema.json) で検証されます。

## Orchestrator

`agent/` はPython 3.11以上で動作する `md-agent-orchestrator` packageです。PyYAMLとjsonschemaを使用します。

主な処理は次のとおりです。

1. Task Specを読み込み、schema、path、task dependencyを検証する。
2. branch、Git history、既存execution stateを確認する。
3. 未完了のtaskを依存関係順に選択する。
4. Task Specと現在taskから制約付きpromptを生成し、Codex CLIを `workspace-write` sandboxで実行する。
5. 変更pathを `allowed_paths`、`forbidden_paths`、runtime protected pathsに照らして検査する。
6. Taskに記載されたvalidationを実行する。
7. validation failureに対して、Specの上限内でrepair cycleを行う。
8. 全task完了後にFinal Verificationを実行する。
9. changed files、validation結果、patch、stateをwork-unit reportとして出力する。
10. Delivery処理がreportとpatchを再検証し、Final Verificationを再実行してからcommit、push、Pull Request作成を行う。

Codex実行時に保護されるpathsは現在次のとおりです。

```text
specs/**
.agent/**
agent/**
.github/**
```

実装を行うexecute jobにはGitHubへのwrite権限を与えません。commit、push、Pull Request作成は、work-unit reportを受け取る別のdelivery jobで行います。

Runtime execution stateは `.agent/state/*.json` に保存できる設計ですが、このpathはGit管理対象外です。GitHub Actionsのwork unitはreportとpatchをartifactとして受け渡します。

## Automated Workflow

### Agent Execute

[`.github/workflows/agent-execute.yml`](./.github/workflows/agent-execute.yml) は `dev` で始まるブランチの `specs/tasks/**/*.md` へのpushで起動します。

```text
Task Spec push
  -> parse-spec
  -> required toolchainsを判定
  -> execute jobでCodex・scope check・validation・report作成
  -> report / patch artifactをupload
  -> deliver jobで再検証
  -> commit / push / Pull Request作成
```

Frontend、Go API、Rust Worker、E2Eに必要なtoolchainは、Task Specの `allowed_paths` に応じて設定されます。E2E対象Specでは、実AWSのS3/SQSとローカルCompose runtimeを起動します。

### Agent Review

[`.github/workflows/agent-review.yml`](./.github/workflows/agent-review.yml) はCodeRabbitの完了イベントで起動し、prepare段階でPull Requestのベースブランチが `dev` で始まることを確認します。

### Merge Tests

[`.github/workflows/merge-tests.yml`](./.github/workflows/merge-tests.yml) は `main` または `dev` で始まるブランチの `app/**` 変更時、またはmanual dispatchで実行されます。

- Contracts: API・storage・reliability・scalabilityとTerraform orchestration構成の静的検証
- Frontend: dependency install、unit tests、build
- Go API: `go test ./...`
- Rust Worker: Cargo workspace tests
- E2E: helper tests、Compose runtime、Playwrightによる実パイプライン確認

変更pathに応じて必要なjobだけを実行します。Reliability E2Eの障害注入とScalability E2Eの実AWS負荷試験は、それぞれの専用環境で手動実行します。

## Repository Structure

```text
streaming-video-app/
├── app/                         # 動画アプリケーション本体
│   ├── frontend/                # Vue FrontendとPlaywright E2E
│   ├── backend/
│   │   ├── api/                 # Go API
│   │   └── worker/              # Rust Worker
│   ├── infra/terraform/         # S3 / SQS / DLQ / CloudFront / IAM / alarms
│   ├── infra/terraform-compute/ # VPC / RDS / ECS / Step Functions / scaling
│   ├── infra/terraform-e2e/     # Reliability E2E（scalability/ は別環境）
│   ├── contracts/               # OpenAPI、job status、storage conventions
│   ├── docs/                    # ADRとrunbook
│   ├── scripts/                 # contract validationとE2E起動
│   ├── compose.e2e.yaml         # Reliability E2E専用override
│   ├── compose.yaml
│   └── README.md
├── specs/tasks/                 # Markdown Task Specs
├── agent/                       # Python orchestrator
│   ├── scripts/                 # CLI entrypoints
│   ├── schemas/                 # Spec、state、report、review schemas
│   └── prompts/                 # implementation / repair / review prompts
├── .agent/state/                # untracked runtime state
├── .github/workflows/           # execute、review、merge tests
├── pyproject.toml
└── .coderabbit.yaml
```

## Setup

### Application

Docker Composeによる起動、AWS prerequisites、環境変数、component単位のtest、Full E2E手順は [app/README.md](./app/README.md#local-development--setup) を参照してください。

Reliability E2E専用AWS環境、認証、統合セットアップ、障害注入テストは [Reliability E2E運用ガイド](./app/frontend/e2e/reliability/runner.md) に集約しています。統合セットアップはWorker・DB・API・Frontendの起動とE2E設定のシェル反映を行います。

クラウド配置は [Cloud runtime](./app/docs/runbooks/cloud-runtime.md)、分散処理と負荷試験の専用環境は [Scalability E2E runbook](./app/docs/runbooks/scalability-e2e.md) を参照してください。Scalability E2Eはdelivery / computeのstateを分離し、配備済み環境のhandoffを使って検証します。

### Orchestrator

Repository rootでPython packageをinstallします。

```sh
python -m pip install -e .
```

Task Specだけを検証する場合:

```sh
python agent/scripts/validate-spec.py specs/tasks/phase1-19-go-api-playback.md
```

Work unitをローカル実行する場合は、Codex CLIと `CODEX_API_KEY` が必要です。実行は作業treeを変更しますが、commitやpushは行いません。

```sh
python agent/scripts/run-work-unit.py \
  --spec specs/tasks/phase1-19-go-api-playback.md \
  --report-dir work/agent-report
```

Task Specのbranch、prerequisite、allowed paths、validation環境が満たされている必要があります。

## Configuration for GitHub Actions

Agent workflowsは次のrepository secretsを使用します。

| Secret | Purpose |
| --- | --- |
| `CODEX_API_KEY` | Codexによるtask実装 |
| `REVIEW_CLASSIFIER_API_KEY` | CodeRabbit feedbackのclassification |
| `AGENT_PR_PAT` | Pull Request作成 |
| `AWS_E2E_API_ACCESS_KEY_ID` / `AWS_E2E_API_SECRET_ACCESS_KEY` | E2E用Go APIのAWS identity |
| `AWS_E2E_WORKER_ACCESS_KEY_ID` / `AWS_E2E_WORKER_SECRET_ACCESS_KEY` | E2E用Rust WorkerのAWS identity |

E2Eは次のrepository variablesを使用します。

- `AWS_REGION`
- `VIDEO_ENCODING_QUEUE_URL`
- `VIDEO_INPUT_BUCKET`
- `VIDEO_OUTPUT_BUCKET`
- `PLAYBACK_BASE_URL`（対象Output bucketを配信するCloudFront HTTPS origin）

FrontendにはAWS credentialsを渡しません。APIとWorkerのcredentialsは分離されています。

## Phase Scope

### Phase 1

基礎パイプラインとして実装した範囲です。配信方式はPhase 3でCloudFrontへ移行しています。

- BrowserからInput S3へのdirect upload
- S3 ObjectCreatedからSQSへのnotification
- Rust WorkerとFFmpegによる単一品質HLS生成
- PostgreSQLによるjob状態管理
- Output S3からのdirect HLS playback
- Frontendによるupload、polling、video.js playback
- S3、SQS、IAMのTerraform configuration
- ローカルCompose runtimeと実AWSを使用するE2E harness
- Phase 1を小さい実装単位へ分割したTask Specs

### Phase 2 — implemented reliability

- DB leaseの原子的取得、期限切れleaseの再取得、owner条件付き状態更新
- SQS visibilityとDB leaseのheartbeat、所有権喪失時の処理中断
- 固定遅延・試行上限付き再試行、SQS redriveによるDLQ隔離、完了済み再配送の再処理防止
- PostgreSQL接続終了時のWorker停止、通常処理完了時の進行中SQS受信の保持
- キュー滞留時間・可視メッセージ数・DLQ件数のCloudWatchアラーム
- 重複配送、crash recovery、長時間heartbeat、試行上限、poison隔離、監視と最終再生のE2E
- 専用Terraform/Compose環境、統合セットアップ、証跡・復旧runbook

### Phase 3 — implemented delivery and scalability

- CloudFront + OAC、private Output S3、内部result JSONの配信拒否
- 公開manifest keyを解決するAPI、CloudFront配信・S3直アクセス拒否のE2E
- VPC、private Single-AZ RDS、HTTPS ALB配下のAPI、Fargate Worker、migration task
- Workerのリソース制限、TLS接続、SIGTERM対応、ECS task protection、CloudWatch logs
- 可視SQS backlog / running Worker tasksによるAuto Scaling（初期範囲1〜4）
- Standard Step Functionsと最大2つのFargate encoderによる360p / 720pのrendition並列処理
- attempt別出力、成果物検証、ABR masterの最終公開、owner / attempt条件付き完了確定
- 独立したScalability E2E環境、セットアップ、負荷・並列処理・scale-in・ABR再生の検証と証跡

### Future scope

以下は未実装です。

- FrontendのAWSホスティング、viewer認証・署名付き配信
- segment単位の分散処理、AWS Batch、scale-to-zero
- FFmpeg C API / libav FFIによる最適化（現在はFFmpeg CLI）

## Current Limitations

- APIは空でないMP4 1ファイル、最大5 GiBを受け付けますが、Workerのsource上限は既定64 MiBです。処理可能範囲はWorker設定にも制約されます。
- HLSはH.264/AAC、MPEG-TSです。`cli` は単一品質、`distributed` は固定の360p / 720pで、upscaleは行いません。
- Authentication、user management、authorizationはありません。
- Output S3はprivateですが、CloudFrontのviewer配信は公開HTTPSです。APIの未完了時409応答はアクセス認可ではありません。
- crash後の復旧はSQS再配送と残り試行回数が前提です。全ジョブを巡回する自動修復やDLQ自動再投入はありません。
- SQS受信回数とDB試行回数は異なり、DLQ移動だけでは非終端ジョブの状態は更新されません。
- Frontendホスティング、DNS・証明書、DB application secretの準備は運用者が行います。
- Terraform CLIによるinit、validate、plan、applyはAgent pipelineの対象外です。
- Full E2Eには設定済みの実AWS resourcesと専用credentialsが必要です。

アプリケーション固有の制約は [app/README.md](./app/README.md#known-limitations--non-goals) を参照してください。
