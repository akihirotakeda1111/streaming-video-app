# Streaming Video App

## Overview

このリポジトリは、ストリーミング動画アプリケーションと、その実装作業をMarkdownのTask Specから実行するオーケストレーターを含むモノレポです。

アプリケーションは個人開発、自己学習、ポートフォリオを目的としています。現在の実装範囲はPhase 1で、動画のアップロードから非同期エンコード、HLS生成、ブラウザ再生までの正常系E2Eを対象とします。

```text
Browser
  -> Go APIでvideo/job作成とPresigned URL発行
  -> Input S3へ直接upload
  -> S3 ObjectCreated notification
  -> SQS
  -> Rust Worker / FFmpeg
  -> Output S3へHLSを配置
  -> Frontend / video.jsで再生
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

現在、`specs/tasks/` にはPhase 1用のTask Specが38件あります。

- Infra: 3件
- Go API: 10件
- Rust Worker: 10件
- Frontend: 8件
- E2E: 7件

## Application

### Purpose

API process内で動画を同期変換せず、upload、job管理、queue consumption、encoding、playbackを別の責務として実装しています。

Phase 1ではFrontend、Go API、Rust Worker、PostgreSQLをローカルで実行し、S3、SQS、IAMは実AWSを利用します。CloudFrontは使用せず、ブラウザがOutput S3のHLS objectsをCORS経由で直接取得します。

### Components

| Component | Responsibility | Main technology |
| --- | --- | --- |
| Frontend | MP4選択、S3 direct upload、status polling、HLS playback | Vue 3、TypeScript、Vite、video.js |
| Go API | video/job作成、Presigned PUT URL、status、playback情報 | Go、AWS SDK for Go v2、pgx |
| Rust Worker | SQS受信、atomic claim、S3入出力、FFmpeg、job状態更新 | Rust、Tokio、AWS SDK for Rust、FFmpeg |
| PostgreSQL | video metadata、upload metadata、job status | PostgreSQL 16 |
| Infra | Input/Output S3、SQS Standard Queue、IAM、CORS | Terraform、AWS |
| Contracts | REST API、job statuses、S3/HLS conventions、examples | OpenAPI 3.1、JSON Schema、Markdown |

Phase 1のjob statusesは次の5つです。

```text
UPLOADING -> QUEUED -> PROCESSING -> COMPLETED
                         \-> FAILED
```

Input S3とOutput S3は分離されています。WorkerはHLS segmentsを先にuploadし、`index.m3u8` を最後にuploadしてからjobを `COMPLETED` にします。

詳細:

- [Application README](./app/README.md)
- [OpenAPI contract](./app/contracts/openapi/api.yaml)
- [Job status schema](./app/contracts/domain/job-status.schema.json)
- [Storage conventions](./app/contracts/domain/storage-conventions.md)
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

- Frontend: dependency install、unit tests、build
- Go API: `go test ./...`
- Rust Worker: Cargo workspace tests
- E2E: helper tests、Compose runtime、Playwrightによる実パイプライン確認

変更pathに応じて必要なjobだけを実行します。

## Repository Structure

```text
streaming-video-app/
├── app/                         # 動画アプリケーション本体
│   ├── frontend/                # Vue FrontendとPlaywright E2E
│   ├── backend/
│   │   ├── api/                 # Go API
│   │   └── worker/              # Rust Worker
│   ├── infra/terraform/         # Phase 1 S3 / SQS / IAM
│   ├── contracts/               # OpenAPI、job status、storage conventions
│   ├── docs/                    # ADRとrunbook
│   ├── scripts/                 # contract validationとE2E起動
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

FrontendにはAWS credentialsを渡しません。APIとWorkerのcredentialsは分離されています。

## Phase Scope

### Phase 1

現在実装されている範囲です。

- BrowserからInput S3へのdirect upload
- S3 ObjectCreatedからSQSへのnotification
- Rust WorkerとFFmpegによる単一品質HLS生成
- PostgreSQLによるjob状態管理
- Output S3からのdirect HLS playback
- Frontendによるupload、polling、video.js playback
- S3、SQS、IAMのTerraform configuration
- ローカルCompose runtimeと実AWSを使用するE2E harness
- Phase 1を小さい実装単位へ分割したTask Specs

### Phase 2 and Phase 3

次の項目は将来計画で、現在のアプリケーションには実装されていません。

- Lease、visibility timeout heartbeat、retry policy、DLQ
- stuck-job recovery、CloudWatch monitoring
- CloudFront + OAC、private Output S3
- API、Worker、PostgreSQLのAWS deployment
- Step Functions、distributed encoding、Auto Scaling
- ABR、複数renditions、FFmpeg C APIによる最適化

Atomic `UPLOADING -> QUEUED` claimとS3/SQS/IAM Terraformは、限定されたPhase 1機能として実装済みです。

## Current Limitations

- 入力は空でないMP4 1ファイル、最大5 GiBです。
- HLSはH.264/AAC、MPEG-TSの単一品質です。
- Authentication、user management、authorizationはありません。
- Phase 1のOutput HLS prefixはpublic `s3:GetObject` を使用します。
- Worker crash後のjob recovery、体系化されたretry、DLQはありません。
- Application computeとPostgreSQLはTerraform管理されていません。
- Terraform CLIによるinit、validate、plan、applyはAgent pipelineの対象外です。
- Full E2Eには設定済みの実AWS resourcesと専用credentialsが必要です。

アプリケーション固有の制約は [app/README.md](./app/README.md#known-limitations--non-goals) を参照してください。
