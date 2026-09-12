# Reliability E2E 運用ガイド

## 全体構成

### 構成要素と責務

Reliability E2Eは専用のAWSリソースとローカルDocker上のWorker・PostgreSQLを使う。
準備、設定生成、実体確認、シナリオ実行を分ける。CIはオフライン検証のみとし、Terraformや実環境シナリオは手動で実行する。

| 要素 | 実装・設定 | 役割 |
| --- | --- | --- |
| AWS環境 | `app/infra/terraform-e2e/` | 既存Terraformを再利用し、専用S3・SQS/DLQ・通知・3アラーム・IAMを作成 |
| ローカル実行環境 | `app/compose.yaml` + `app/compose.e2e.yaml` | 専用プロジェクト・DB volume・ラベル。Worker、DB、migrationは既存定義を再利用 |
| 設定生成 | `app/scripts/generate_reliability_env.mjs` | AWS/Docker実効値から非機密の環境設定を生成。秘密情報は出力しない |
| 共通事前確認 | `safety.mjs`、`live.mjs` | 設定形式とAWS/Dockerの実体・所有範囲を確認。プロセス操作やリモート書き込みは行わない |
| 実行入口 | `app/scripts/run_reliability_e2e.py` | 検証、証跡ディレクトリ作成、実装済みシナリオ選択、Playwright起動 |
| シナリオ | `*.spec.ts`、driver、adapter | 事前確認後に操作・観測・検証・run単位のcleanupを実施 |
| 診断 | `transport-diagnostics.ts`、`../diagnostics.ts` | 固定原因分類と秘密情報を除外した証跡 |

設定の流れは **AWS準備 → Compose入力と認証設定 → コンテナ起動 → E2E設定生成・読み込み → 事前確認 → シナリオ実行**。
設定生成だけではシェルも起動済みコンテナも更新されない。事前確認成功もシナリオ成功の代わりにはならない。

### シナリオと検証範囲

| セレクター | 検証範囲 | 実装状況 |
| --- | --- | --- |
| `preflight` | ローカル・ブラウザ・APIの準備確認 | 実装済み。API/Frontendとブラウザが必要 |
| `runtime-authorization` | Reliability共通実行境界の確認 | 実装済み |
| `duplicate-delivery` | 処理中と完了後の重複配送、単一の有効処理、ack、cleanup | 実装済み。ブラウザ/APIを操作しない |
| `crash-recovery` | 取得後・永続完了前のWorker停止、可視性とDB lease expiry後の再取得 | 実装済み。停止対象は共通事前確認済みの同一Workerのみ |
| `long-heartbeat` | 複数heartbeat周期の可視性延長・lease更新、単一owner維持 | 実装済み。短すぎるfixtureは成功扱いにしない |
| `ffmpeg-exhaustion` | 不正メディアの実FFmpeg失敗、試行上限、FAILED、manifest非公開、run-owned DLQ隔離 | 実装済み。`--scenario ffmpeg-exhaustion` |
| `poison-isolation` | malformed/unknown-job poison のDLQ隔離と、同時実行する正常jobの完了 | 実装済み。`--scenario poison-isolation` |
| `queue-monitoring` | source queue backlog/age、DLQ depth、3つのCloudWatch alarm状態を読み取り、FFmpeg/poison証跡と相関 | 実装済み。`--scenario queue-monitoring`。Receive/Delete/Purge/Replayは行わない |
| `--full` / `--full-suite` | 6つのReliabilityシナリオ後に新規アップロード・実ブラウザ再生 | 実装済み。最後に既存 `@phase1-pipeline` をChromiumで実行。単独の `--scenario phase1-pipeline` はない |

最新の実装済みセレクターは `--list` で確認する。実環境の受け入れは対象環境で成功した証跡をレビューして判断する。

個別の追加設定・実行コマンド・成功判定は、後述の「シナリオ別の前提条件と実行手順」を参照する。

シナリオ追加時はこの表と「シナリオ別の前提条件と実行手順」「時間設定・検証詳細・復旧」を更新する。
各シナリオは直接Playwrightで選択されても操作前に共通事前確認を呼び、別テストの成功を認可の代用にしない。
停止を伴うシナリオでは直前にEngine ID・完全なコンテナID・開始時刻を再照合し、同じコンテナを保持して復旧する。
再作成・Compose全体の停止・プロセス名での選択を障害注入に使わない。

## 事前準備

### ツールと実行場所

コマンドはリポジトリルートで実行する。特記のないコマンドは **Windows（PowerShell）・WSL（Bash）共通**。
1行ずつ実行し、失敗した場合は後続へ進まない。
Python、Node.js、npm、npx、FFmpeg、AWS CLI、Dockerが必要。WSLでPythonのコマンド名が `python3` の場合は、以下の `python` を読み替える。
TerraformはAWS環境を作成・削除する場合だけ必要（>=1.6、mockテストは>=1.7）。
Docker Composeは `!reset` 対応版を使用する。構成確認はv2.35.1で実施している。

```text
npm --prefix app/frontend ci --include=dev
node app/frontend/node_modules/@playwright/test/cli.js --version
```

依存関係はテストを実行するOS側にインストールする。Docker内やWindows側のnode_modulesはWSL側の代用にならない。
WSLではLinux版Nodeを使い、`node -p 'process.platform'` が `linux` であることを確認する。
ブラウザを使用するシナリオでは、別途Playwrightの対象ブラウザをインストールする。

### 専用AWS環境

既存の専用環境があれば再作成は不要。新規作成時は通常環境とstate・リソース名を分離する。
E2E用Terraformはinput/output S3、Standard sourceキューとDLQ、S3通知、3アラーム、API/Worker用IAMユーザー・ポリシー、
ホストrunner用ポリシーを作成する。アクセスキー、DB、コンテナ、計算リソースは作成しない。
outputのHLSパスは既存構成と同じ公開読み取り方式。アカウント方針が公開ポリシーを禁止する場合は適用できない。
バケットは新規・非versionedで、強制オブジェクト削除は有効にしない。

`terraform.tfvars.example` を同じディレクトリの `terraform.tfvars` にコピーし、
`aws_account_id` を想定アカウントIDへ変更する。必要なら `aws_region` / `instance` も変更する。
プロファイル設定だけは使用するシェルに合わせる。

| 設定 | Windows / PowerShell | WSL / Bash |
| --- | --- | --- |
| 構築用プロファイル | `$env:AWS_PROFILE = 'e2e-provisioner'` | `export AWS_PROFILE='e2e-provisioner'` |

```text
terraform -chdir=app/infra/terraform-e2e init
terraform -chdir=app/infra/terraform-e2e validate
terraform -chdir=app/infra/terraform-e2e plan -out=e2e.tfplan
```

新規E2Eリソースだけを対象とするplanであることを確認して適用する。

```text
terraform -chdir=app/infra/terraform-e2e apply e2e.tfplan
```

両providerが想定アカウントIDを制限する。リソース名は `streaming-video-e2e-<instance>`、バケット名にはアカウント・リージョンも含む。
複数環境を持つ場合は異なるinstanceと別checkout等の独立したstateを使う。同じstateでinstanceを変えると置換planになる。
通常環境のstate・workspace・バケットを流用しない。local stateとbackupはリソースが残っている間は保持する。
state・plan・実値tfvarsはコミットせず、provider lockファイルはコミットする。チーム共有backend構築は別途扱う。

### 起動前の接続先と認証

ホスト用とWorker用の認証を分ける。`AWS_PROFILE` だけではWorkerに認証情報は渡らない。

| 用途 | 起動元シェルの変数 | 設定元・注意点 |
| --- | --- | --- |
| 接続先 | `AWS_REGION`、`VIDEO_ENCODING_QUEUE_URL`、`VIDEO_INPUT_BUCKET`、`VIDEO_OUTPUT_BUCKET` | E2E専用Terraform output、または既存専用リソースの実値 |
| Worker認証 | `WORKER_AWS_ACCESS_KEY_ID`、`WORKER_AWS_SECRET_ACCESS_KEY` | Worker用principalの認証。Composeがコンテナ内の `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` に渡す |
| Worker一時認証 | `WORKER_AWS_SESSION_TOKEN` | 一時認証なら必須。長期キーの場合は古いtokenを残さない |
| ホスト認証 | `AWS_PROFILE`、または `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / 必要なら `AWS_SESSION_TOKEN` | 設定生成・実体確認・アップロード・cleanup用。provisionerからrunner用へ切り替える |
| DB | `POSTGRES_DB`、`POSTGRES_USER`、`POSTGRES_PASSWORD`、`COMPOSE_DATABASE_URL` | 既定値を使用可能。変更時は整合させ、コンテナ内の接続先は `postgres:5432` |

Terraform outputから非機密のCompose入力とWorker時間設定を読み込む。

<details>
<summary>Terraform出力の読み込み（使用するシェルだけ実行）</summary>

PowerShell:

```powershell
$runtimeJson = terraform -chdir=app/infra/terraform-e2e output -json compose_environment
if ($LASTEXITCODE -ne 0) { throw 'Terraform output failed' }
$runtime = $runtimeJson | ConvertFrom-Json
foreach ($entry in $runtime.PSObject.Properties) {
  [Environment]::SetEnvironmentVariable($entry.Name, [string]$entry.Value, 'Process')
}
```

WSL / Bash（jqが必要）:

```bash
load_runtime() {
  local runtime_json entries entry
  runtime_json=$(terraform -chdir=app/infra/terraform-e2e output -json compose_environment) || return 1
  entries=$(printf '%s' "$runtime_json" | jq -r 'to_entries[] | "\(.key)=\(.value)"') || return 1
  while IFS= read -r entry; do export "$entry"; done <<< "$entries"
}
load_runtime || echo 'Terraform output failed; 起動せず設定を確認してください' >&2
```

</details>

Terraformを使わない場合は上表の接続先を手動設定する。例: `export VIDEO_ENCODING_QUEUE_URL='https://sqs.ap-northeast-1.amazonaws.com/<account>/専用キュー名'`。
開発用 `.env` やシェルに残った通常環境の接続先を引き継がない。

認証は手動で用意する。Terraformはキーを発行しない。使用するWorkerユーザーとrunnerポリシーは次で確認できる。

```text
terraform -chdir=app/infra/terraform-e2e output worker_identity
terraform -chdir=app/infra/terraform-e2e output runner_policy_arn
```

runner policyはホスト側principalへ手動付与する。専用DLQに限定した `sqs:ReceiveMessage` を含む。source queueのReceive、queueのDelete/Purge、DLQ replay、Terraform適用権限は含まない。既存環境では更新したrunner policyを人手で適用してからFFmpeg exhaustionを実行する。
CloudWatch DescribeAlarmsは設定生成の一覧取得に必要なため読み取りの `Resource=*` を使用する。
AWS認証情報は生成ファイル・tfvars・Git管理ファイルに追記しない。WorkerのDATABASE_URLもコピー不要。

WSLで秘密値を履歴・画面に出さず設定する例:

```bash
export AWS_PROFILE='<E2E runner用プロファイル名>'
aws sts get-caller-identity
read -rsp 'Worker access key ID: ' WORKER_AWS_ACCESS_KEY_ID; printf '\n'
read -rsp 'Worker secret access key: ' WORKER_AWS_SECRET_ACCESS_KEY; printf '\n'
read -rsp 'Worker session token (長期キーなら空欄): ' WORKER_AWS_SESSION_TOKEN; printf '\n'
export WORKER_AWS_ACCESS_KEY_ID WORKER_AWS_SECRET_ACCESS_KEY WORKER_AWS_SESSION_TOKEN
```

PowerShellでは同じ変数を `$env:変数名` に設定する。ホスト認証が有効でもWorker認証が空・期限切れならWorkerは処理できない。

### Docker環境と起動

ローカルのLinux Engineに直接接続する。WSLの既定ソケットは `unix:///var/run/docker.sock`、Windowsは `npipe:////./pipe/docker_engine`。
リモート接続・authorization plugin・共有ストレージは未対応。設定生成はDocker contextを推測しない。
必要なら `--docker-host` で実際のローカルソケットを指定する。

```text
docker compose -p streaming-video-e2e -f app/compose.yaml -f app/compose.e2e.yaml config --quiet
docker compose -p streaming-video-e2e -f app/compose.yaml -f app/compose.e2e.yaml up --build -d worker
docker compose -p streaming-video-e2e -f app/compose.yaml -f app/compose.e2e.yaml ps
```

この起動ではWorkerと依存するDB・migrationだけが対象。API/Frontendが必要なシナリオでは追加起動し、公開ポート・URL・CORSも準備する。
Workerの再起動ポリシーは専用overrideで `no` にする。通常の `app/compose.yaml` 単独では `unless-stopped` を維持する。
`start-e2e-compose.sh` は通常Compose全体を起動するため、専用overrideの代用にはしない。
DB名は `streaming-video-e2e-postgres`、volume名は `streaming-video-e2e-postgres-data`。DBホスト公開ポートは除去される。
`-p` を変えると名前・scopeも変わる。全操作で同じプロジェクト名と2ファイルを指定する。
AWSリソースはComposeで分離されないため、他consumerと共有しない専用キュー・バケットを指定する。

共通事前確認が求める条件:

- Worker/DBに `com.streaming-video.e2e.disposable=true`、対応する `com.streaming-video.e2e.scope`、`com.streaming-video.e2e.role=worker|database`。
- Running、非Paused、非Restarting。Privileged・host PID・AutoRemoveは無効。
- Workerは `/usr/local/bin/video-worker` を追加引数やwrapperなしで直接起動。
- DBは `docker-entrypoint.sh postgres` で起動し、healthcheckはhealthy。
- WorkerのDATABASE_URLは同一Dockerネットワークの対象DB・標準ポート5432を指す。
- Worker/DBに付くvolumeはlocal named volume、driver optionsなし。同じdisposable/scopeラベルを持ち、他コンテナから未使用。bind mountは不可。

ラベルだけで専有を証明したとは扱わない。事前確認はvolume利用者・ネットワーク・完全ID・開始時刻・Engine IDを検査する。
コンテナ制御能力の確認は接続条件に基づき、実際のstop/startや再起動成功の保証は行わない。

起動後に接続先・認証を変更した場合、テストが終了していることを確認してWorkerを再作成する。

```text
docker compose -p streaming-video-e2e -f app/compose.yaml -f app/compose.e2e.yaml up -d --no-deps --force-recreate worker
```

IDが変わるためE2E設定を再生成・再読込する。`VIDEO_ENCODING_QUEUE_URL` と `E2E_SOURCE_QUEUE`、各VIDEOバケットとE2Eバケットは同じ対象である必要がある。

### E2E設定の生成と読み込み

生成処理はAWS CLI認証を使い、既存ラベル・Worker実効値・STS・sourceのRedrivePolicy・DLQ・アラームを読み取る。
取得失敗・値の不整合・複数のアラーム候補はエラーにする。各コマンド10秒、全体120秒、応答4 MiBが上限。
バケット・SQS・アラームの作成、認証値の出力、シナリオ実行は行わない。

使用するシェルの手順だけ実行し、同じシェルで「実行手順」へ進む。
コンテナを再作成した場合は再生成・再読込する。

<details>
<summary>Windows / PowerShell：設定生成・読み込み</summary>

フル実行向けの生成例。正常MP4と、非空の不正 `.mp4` を別々に用意する。時計ずれはホスト・Worker・DBの時刻同期を確認して上限を指定する（以下の100 msは例）。
`--full` は環境設定生成の入力を検証するオプションで、テストを実行しない。

PowerShellの例（アカウント・両fixture・時計ずれ・URLを実環境に合わせる）:

```powershell
$workerId = docker compose -p streaming-video-e2e -f app/compose.yaml -f app/compose.e2e.yaml ps -q worker
$dbId = docker compose -p streaming-video-e2e -f app/compose.yaml -f app/compose.e2e.yaml ps -q postgres
node app/scripts/generate_reliability_env.mjs --worker $workerId --database $dbId --account 123456789012 --fixture C:/e2e/long.mp4 --invalid-fixture C:/e2e/invalid.mp4 --clock-skew-ms 100 --frontend-url http://localhost:5173 --api-url http://localhost:8080 --exclusive --full --output ./reliability-env.local.ps1
# 成功を確認し、内容をレビューしてから同じシェルに読み込む
Get-Content ./reliability-env.local.ps1
. ./reliability-env.local.ps1
```

既存ファイルは上書きしない。再生成時は別の出力ファイル名を使う。

</details>

<details>
<summary>WSL / Bash：設定生成・読み込み</summary>

CLIの出力はPowerShell専用のため、Bashでは取得関数のJSONを読み込む（jqが必要）。

```bash
worker_id=$(docker compose -p streaming-video-e2e -f app/compose.yaml -f app/compose.e2e.yaml ps -q worker)
db_id=$(docker compose -p streaming-video-e2e -f app/compose.yaml -f app/compose.e2e.yaml ps -q postgres)
# 専用・破棄可能環境であることを確認してから実行。アカウントとfixtureを実値へ置換
load_e2e() {
  local settings entries entry
  settings=$(node --input-type=module - "$worker_id" "$db_id" '123456789012' "$HOME/e2e/fixtures/test.mp4" "$HOME/e2e/fixtures/invalid.mp4" '100' <<'JS'
import { discoverEnvironment } from './app/scripts/generate_reliability_env.mjs'
const [worker, database, account, fixture, invalidFixture, clockSkewMs] = process.argv.slice(2)
try {
  const env = discoverEnvironment({ worker, database, account, fixture, invalidFixture, clockSkewMs, exclusive: true, full: true, frontendUrl: 'http://localhost:5173', apiUrl: 'http://localhost:8080' })
  console.log(JSON.stringify(env))
} catch { console.error('E2E設定生成失敗。認証・接続先・ラベル・アラーム・fixture・時計ずれの入力を確認してください'); process.exitCode = 2 }
JS
  ) || return 1
  entries=$(printf '%s' "$settings" | jq -r 'to_entries[] | "\(.key)=\(.value)"') || return 1
  while IFS= read -r entry; do export "$entry"; done <<< "$entries"
}
load_e2e || echo '設定生成失敗。後続の実行を止めて確認してください' >&2
```

</details>

フル実行用に生成すると、正常・不正fixture、時計ずれ、`E2E_PROJECT=chromium`、全共通設定が同じファイル/JSONに揃う。
`.ps1`またはBashの生成JSONを読み込んだ後、これらを個別にexportし直す必要はない。
fixture検査はファイル形式・サイズの条件のみで、正常動画としての再生可否・encode時間や、実FFmpegでの失敗は保証しない。
API/Frontend用のバケット、出力S3 endpoint、許可origin、API接続先、公開ポートも生成する。API/Frontendの起動・認証とS3 CORS、ホストFFmpeg、Chromiumのインストールは引き続き別途必要。秘密情報は生成ファイルへ含めない。
`E2E_RUN_ID` と監視の先行run IDはフルrunnerが設定するため、生成設定には含めない。

生成JSON・コマンドはいずれも非機密設定だけだが、環境固有の値なのでGitにはコミットしない。
認証を別シェルで使う場合は、そのシェルでも既存AWS CLIログイン・認証変数を手動設定する。

| 生成時の指定 | 省略時・用途 |
| --- | --- |
| `--worker` / `--database` | 必須。DB名ではなくコンテナ名またはID |
| `--account` | 推奨。STSアカウントと照合。省略時はSTS値を使用 |
| `--profile` | 任意の既存AWSプロファイル名。秘密情報は受け付けない |
| `--docker-host` | DOCKER_HOST、なければOS別ローカルソケット |
| `--frontend-url` / `--api-url` | 既定は `http://127.0.0.1:5173` / `http://127.0.0.1:8000`。自動検出・稼働確認ではない |
| `--evidence-dir` | カレントディレクトリの `artifacts/reliability-e2e` を絶対パス化 |
| `--fixture` | `E2E_DUPLICATE_FIXTURE`。正常MP4の絶対パスへ変換し、存在・拡張子・サイズを検査 |
| `--invalid-fixture` | `E2E_FFMPEG_INVALID_FIXTURE`。不正MP4の絶対パスへ変換し、存在・拡張子・サイズを検査 |
| `--clock-skew-ms` | `E2E_CLOCK_SKEW_MS`。1〜5000 msの整数を明示。lease/visibilityとの余裕も確認 |
| `--full` | `--exclusive` と上記3引数を必須にする。正常・不正fixtureに同じパスを指定した場合もエラー。省略時は不足値を空欄として生成 |
| `--exclusive` | 専用・破棄可能環境であるという利用者の宣言。省略時はdisposable/exclusiveが空欄 |
| `--alarms A,B,C` | 候補が重複・多数ある場合に実際の3アラーム名を指定 |

<details>
<summary>設定値・待機時間の詳細（調整時に参照）</summary>

生成値を上書きする場合の共通契約:

| 設定 | 必須条件 |
| --- | --- |
| `E2E_ENVIRONMENT` / `E2E_RELIABILITY_DISPOSABLE` | `disposable` / `true` |
| `AWS_REGION` / `E2E_AWS_ACCOUNT_ID` | 実対象のリージョン / 12桁アカウント。全リソースと一致 |
| `E2E_FRONTEND_URL` / `E2E_API_URL` | HTTP(S)、認証情報・query・fragmentなし。ブラウザを使わないシナリオでも現行共通契約で必須 |
| `E2E_SOURCE_QUEUE` / `E2E_DLQ` | 異なるキューの名前またはURL。ARNではない |
| `E2E_SOURCE_DLQ` / `E2E_SOURCE_DLQ_RELATIONSHIP` | E2E_DLQと同じ文字列 / `verified`。実際のRedrivePolicyも照合 |
| `E2E_SOURCE_BUCKET` / `E2E_OUTPUT_BUCKET` | Worker設定と一致する異なるバケット |
| `E2E_MAX_ATTEMPTS` | 1〜10の整数。Workerとsource maxReceiveCountに一致 |
| `E2E_ALARM_IDENTIFIERS` | 異なる3アラーム名。AWS/SQS・QueueName dimensionのみで、source最古メッセージ年齢、source可視件数、DLQ可視件数を各1個 |
| `E2E_DOCKER_HOST` | 前述の直接ローカルソケット |
| `E2E_WORKER_OBSERVATION` / `E2E_WORKER_PROCESS_CONTROL` | 同じ `docker:<完全64文字ID>` |
| `E2E_DATABASE_OBSERVATION` / `E2E_DATABASE_PROCESS_CONTROL` | 同じ `docker:<完全64文字ID>` |
| `E2E_WORKER_CONTROL_SCOPE` / `E2E_DATABASE_CONTROL_SCOPE` | 実ラベルと一致。ワイルドカードやall/host/shared/productionは不可 |
| `E2E_EVIDENCE_DIR` | 書き込み可能な絶対パス。親ディレクトリ参照 `..` は不可 |

`E2E_RUN_ID` と `E2E_INCLUDE_RELIABILITY` はrunnerが設定する。`.env` はPlaywright/runnerでは自動読込しない。
全7種類の `E2E_*_TIMEOUT_MS` は1〜900000の整数（ミリ秒）で明示設定が必要。生成値は次のとおり。

| 時間設定 | 生成値・照合 |
| --- | --- |
| NAVIGATION | 30000。配送ポーリングの余裕にも使う |
| UPLOAD | 120000。大きなMP4では実際の転送時間に合わせて延長 |
| PROCESSING | 300000。エンコード・出力検証・cleanupの各段階に使用 |
| PLAYBACK | 120000 |
| VISIBILITY | max(SQS visibility, Worker延長) ×1000 + 30000（上限900000） |
| LEASE | Worker lease ×1000 + 30000（上限900000） |
| DLQ | Worker retry ×1000 + 30000（上限900000） |

実設定自体が900000 msを超える場合、生成はエラー。E2E予算はWorker/SQSの設定を変更しない。
Worker時間設定は秒単位、`2 × heartbeat <= min(visibility延長, lease)` が必要。
DLQ予算の共通チェックは1回分のretryをカバーするだけで、全再配送の所要時間はシナリオ側で確保する。

`ffmpeg-exhaustion` の待機予算は `PROCESSING + (attempts − 1) × Worker retry(ms) + VISIBILITY + DLQ`。PROCESSINGは全試行の処理時間に対する合計予算で、試行数倍にはしない。
DLQ確認後は `VISIBILITY`（実visibilityに観測余裕を加えた値）1回分、DB状態・attempt・更新時刻、追加encodingの不在とmanifest非公開を観測する。到達済みのDLQについてretry予算を再度待つ必要はない。
Playwrightの上限はこれらにUPLOAD、cleanup用PROCESSING、事前確認等の180秒を加えた値とする。個々の環境変数の900000 ms上限は変更しない。
専用Terraformは全シナリオ共通で3試行・retry 10秒・visibility 120秒とする。生成値ではFFmpegのDLQ待機を含む上限510秒、到達後確認150秒。通常所要時間ではなく失敗判定用の上限で、setup/upload/cleanupは別枠。
poisonはWorkerのretry delayを使わず、sourceのvisibility期限切れを繰り返す。adapterは `試行上限 × E2E_VISIBILITY_TIMEOUT_MS + E2E_DLQ_TIMEOUT_MS` をpoison専用のDLQ予算として計算する。VISIBILITYは共通事前確認でsourceの実visibility以上と検証された余裕込みの値。固定設定の生成値では `3 × 150秒 + 40秒 = 490秒`。1回のDLQ受信操作の予算とFFmpegの計算にはこの増分を適用しない。

fixtureの設定、DLQ受信権限、実行コマンド、成功条件は後述の `ffmpeg-exhaustion` / `poison-isolation` の個別手順を参照する。
FFmpegイベントは同一Workerのログ出現順で検証し、UTC時刻の単調増加は要求しない。待機期限は単調時計を使う。
poisonの相関はmessage IDごとに保持し、証跡に本文ハッシュ・UTC観測・cleanup結果を残す。

</details>

## 共通事前確認

事前準備でコンテナを起動し、E2E設定と認証を読み込んだ**同じシェル・リポジトリルート**で実行する。

```text
python app/scripts/run_reliability_e2e.py --check
python app/scripts/run_reliability_e2e.py --live-preflight
```

`--check` が `configured; live resources not verified`、`--live-preflight` が `status=verified` になったら個別手順へ進む。
`not configured` / `blocked` の場合は設定を確認する。`--check` は外部ツールの存在と設定形式の確認であり、各権限・fixture・API・ブラウザの動作保証ではない。
`--live-preflight` は読み取りによる実体確認を行い、`preflight-<UUID>/live-preflight.json` を保存する。後述の `--scenario preflight` とは役割が異なる。

各シナリオも実行直前に共通事前確認を行う。`E2E_EVIDENCE_DIR` は証跡の**親ディレクトリ**のまま保持し、runnerが表示する子ディレクトリへシェル設定を変更しない。
`E2E_RUN_ID` はrunnerに生成させる。シナリオを並行実行しない。Workerの再作成・実環境の設定変更後は設定を再生成・再読込し、この確認からやり直す。

## シナリオ別の前提条件と実行手順

### 選択早見表

下表の条件は共通事前準備に**追加**する。URL設定は全シナリオの共通契約で必須だが、API・Frontendの稼働とブラウザインストールが必要なのはブラウザを使う行だけ。

| 実行対象 | 追加するもの | 先行する障害シナリオ | 主な証跡 |
| --- | --- | --- | --- |
| `preflight` | API・Frontend、対象ブラウザ、ホストFFmpeg | なし | Playwright結果・失敗時の診断添付 |
| `runtime-authorization` | 共通設定のみ | なし | Playwright結果・失敗時の認可診断 |
| `duplicate-delivery` | 下記「データ作成シナリオ共通条件」、長めの正常MP4、exclusive宣言 | なし | `duplicate-delivery-evidence.json` |
| `crash-recovery` | 同共通条件、正常MP4、時計ずれ設定、heartbeatログ、停止・再開可能なWorker | なし | `crash-recovery-evidence.json` |
| `long-heartbeat` | 同共通条件、複数heartbeatを観測できる正常MP4、時計ずれ設定、heartbeatログ | なし | `long-heartbeat-evidence.json` |
| `ffmpeg-exhaustion` | 同共通条件、不正MP4、DLQ受信権限、全再試行を待つ予算 | なし | `ffmpeg-exhaustion-evidence.json` |
| `poison-isolation` | 同共通条件、正常MP4、DLQ受信権限、poisonのredriveを待つ予算 | なし | `poison-isolation-evidence.json` |
| `queue-monitoring` | メトリクス取得権限、同じ環境のFFmpeg・poison成功証跡 | 完全な成功判定にはFFmpeg・poisonの両方 | `queue-monitoring-evidence.json` |
| `--full` | 上記すべてとChromium再生環境。正常・不正の両fixture | runnerが6シナリオを順番に実行 | `full-suite-*.json` と各runのJSON、`phase1-pipeline-evidence.json` |

### データ作成シナリオ共通条件

`duplicate-delivery`、`crash-recovery`、`long-heartbeat`、`ffmpeg-exhaustion`、`poison-isolation` は同じ基底adapterを使うため、次の条件が必要。

- 他テスト・consumerと共有しない専用Worker/DB/S3/SQS。実行前のDBに `UPLOADING` / `QUEUED` / `PROCESSING` がないこと。過去runの残存データは証跡と照合して解決する。
- 非versionedバケット（Enabled/Suspendedは不可）、Standardキュー。sourceバケットに単一の直接S3通知があり、他のSNS/Lambda/EventBridge通知がないこと。
- 通知フィルタが `videos/<video UUID>/jobs/<job UUID>/source.mp4` に一致すること。通常prefixは `videos/`、suffixは `/source.mp4`。
- Worker起動ログの `duplicate_observation_schema=1` を、起動以降の末尾2000行から確認できること。
- fixtureは実行ホストから読める絶対パスの `.mp4`、非空、1 GiB以下。Windows側のパスをWSLへそのまま渡さない。
- ホストprincipalに共通の読み取りに加えて、sourceへの `sqs:SendMessage`、S3通知/versioning/list取得、source PutObject、output HeadObject、runオブジェクトのDeleteObject権限があること。HeadBucketはListBucket、HeadObjectはGetObjectに対応する。
- DBロールが対象video/jobの作成・参照・削除を行えること。DB名・ユーザー名は英数字とunderscoreのみ対応。

重複配送・ライフサイクルでは `E2E_DUPLICATE_EXCLUSIVE=true` が必須。FFmpeg・poisonのadapterはこの値を内部設定するが、実リソースを専有してよいことの確認は同様に必要。
正常MP4の内容・処理時間は利用者が用意する。MP4の再生時間やファイル容量だけでは、Workerのencode所要時間を保証できない。

### ブラウザ使用シナリオの追加準備

`preflight` と最終 `@phase1-pipeline` には、Worker/DBに加えてAPI・Frontendを起動する。フル実行では開始前に準備する。

1. API用principalの認証を `API_AWS_ACCESS_KEY_ID` / `API_AWS_SECRET_ACCESS_KEY`、一時認証なら `API_AWS_SESSION_TOKEN` に設定する。Worker用・ホスト用の認証設定だけではAPIに渡らない。APIは同じDB、`VIDEO_INPUT_BUCKET` / `VIDEO_OUTPUT_BUCKET`、regionを参照させる。
2. 生成設定を読み込む。`--frontend-url` / `--api-url` からComposeの公開ポートも生成する。生成器のAPI URL既定は8000なので、8080で公開する場合は `--api-url http://localhost:8080` を指定する。ComposeはHTTPで配信するため、HTTPSのURLを使う場合は別途proxyの設定が必要。
3. APIの `FRONTEND_ORIGIN`、Terraformの `frontend_origin` によるS3 CORS、ブラウザが開くFrontend originを一致させる。`localhost` と `127.0.0.1` は別origin。必要なAWS変更は共通準備のplan確認手順で行う。

生成設定には次の起動用変数が含まれるため、個別設定は不要。既存専用環境のS3 CORSと異なる場合は、その環境のoriginを生成時に指定する。

| 変数 | 生成元・値 |
| --- | --- |
| `AWS_REGION` | Workerのリージョン |
| `VIDEO_INPUT_BUCKET` / `VIDEO_OUTPUT_BUCKET` | Workerと同じ入力・出力バケット |
| `OUTPUT_S3_ENDPOINT` | `https://<出力バケット>.s3.<リージョン>.amazonaws.com` |
| `FRONTEND_ORIGIN` | `--frontend-url` のorigin |
| `VITE_API_BASE_URL` | `--api-url` に `/api/v1` を追加 |
| `API_PORT` / `FRONTEND_PORT` | 指定URLのポート（省略時はHTTP 80 / HTTPS 443） |

API必須の `HTTP_ADDR` と既定の `DATABASE_URL` はComposeが設定する。DB設定を変更している場合は既存DBに合う `COMPOSE_DATABASE_URL` を別途設定する。APIのAWS認証情報は上記1のとおり手動設定する。

```text
docker compose -p streaming-video-e2e -f app/compose.yaml -f app/compose.e2e.yaml up --build -d api frontend
docker compose -p streaming-video-e2e -f app/compose.yaml -f app/compose.e2e.yaml ps
node app/frontend/node_modules/@playwright/test/cli.js install chromium
```

API・Frontendがhealthyになり、同じ専用Worker/DBが維持されていることを確認する。再生成時も `--frontend-url http://localhost:5173 --api-url http://localhost:8080` を指定してURLの不一致を戻さない。
ホストFFmpegは `libx264` を利用可能にする。`FFMPEG_PATH` を指定する場合はホストで実行できるパスを使い、Workerコンテナ内パスを流用しない。
通常はブラウザを表示するため、WSL等では表示環境も必要。`CI` 設定時はheadlessになる。
最終再生では公開HTTPSのHLS manifest/segmentをブラウザから取得でき、適切なContent-TypeとCORS応答が必要。

### preflight：ブラウザ・APIの準備確認

**追加条件：** 上記ブラウザ準備。既定ブラウザはChromium。`E2E_PROJECT` をfirefox/webkitにする場合は対象ブラウザを別途インストールする。

```text
python app/scripts/run_reliability_e2e.py --scenario preflight
```

**成功判定：** Frontend到達、ブラウザ操作、APIの `/api/v1/health`、ホストFFmpegによるfixture生成がすべて成功すること。video/jobのアップロードや再生成功は検証しない。失敗時のPlaywright診断添付を保存する。
引数省略時もこのシナリオになる。`preflight-*/live-preflight.json` を作成する `--live-preflight` と混同しない。

### runtime-authorization：共通実行境界の確認

**追加条件：** 共通事前準備のみ。API・Frontendの起動、ブラウザ、fixtureの追加準備は不要。

```text
python app/scripts/run_reliability_e2e.py --scenario runtime-authorization
```

**成功判定：** Playwrightの認可テストが成功すること。失敗時は `reliability-preflight-blocked` 添付を確認する。この成功は後続シナリオの認可・検証を省略する根拠にはならない。

### duplicate-delivery：処理中・完了後の重複配送

**追加条件：** データ作成シナリオ共通条件に加え、正常なMP4でencode中のbusy配送を観測できること。

| 設定 | PowerShellの例 | Bashの例 |
| --- | --- | --- |
| 専有宣言 | `$env:E2E_DUPLICATE_EXCLUSIVE = 'true'` | `export E2E_DUPLICATE_EXCLUSIVE='true'` |
| 正常fixture | `$env:E2E_DUPLICATE_FIXTURE = 'C:/e2e/long.mp4'` | `export E2E_DUPLICATE_FIXTURE='/home/user/e2e/long.mp4'` |

生成済み設定に正しい値が入っていれば再設定は不要。

```text
python app/scripts/run_reliability_e2e.py --scenario duplicate-delivery
```

**成功判定：** `duplicate-delivery-evidence.json` の `status=passed`、`cleanup=complete`。単一owner/attempt、処理の重複なし、元通知・busy通知のack、完了後の再配送で再encodeせずDB状態不変を確認する。
短すぎるfixtureでbusy配送を観測できない場合は未検証。長すぎてredrive上限に達する場合も失敗であり、対象Workerでの実測に合わせて調整する。

### crash-recovery：停止後の再取得・復旧

**追加条件：** 重複配送と同じ正常fixture・exclusive宣言・データ作成条件に、以下を加える。

- encode中に1回のheartbeat成功とDB lease更新を観測できるfixture。
- 起動ログに `heartbeat_observation_schema=1`。
- 時刻同期を確認し、`E2E_CLOCK_SKEW_MS` を1〜5000の整数で明示する。許容差の2倍がWorkerのlease/visibility期間より小さいこと。
- `E2E_PROCESSING_TIMEOUT_MS > 2 × heartbeat間隔(ms)`、`E2E_MAX_ATTEMPTS >= 2`。
- 保持される同一Workerコンテナをstop/startできること。restart policyは `no`。DBは停止しない。

| 設定例（実測した上限に置換） | PowerShell | Bash |
| --- | --- | --- |
| 時計ずれ上限100 ms | `$env:E2E_CLOCK_SKEW_MS = '100'` | `export E2E_CLOCK_SKEW_MS='100'` |

```text
python app/scripts/run_reliability_e2e.py --scenario crash-recovery
```

**成功判定：** `crash-recovery-evidence.json` の `status=passed`、`restoration=complete`、`cleanup=complete`。期限切れを待って同一コンテナを再開し、元messageの別delivery/owner・attempt 2で再取得して完了・ackすること。
利用者が途中でWorkerを再作成しない。復元失敗時は後続テストへ進まず、証跡の完全IDを使って同じWorkerの状態を確認する。
時間設定は後述の全シナリオ共通値を使う。個別の切り替えは不要。

### long-heartbeat：複数周期のlease・visibility更新

**追加条件：** crash-recoveryと同じ正常fixture・exclusive宣言・ログschema・時計ずれ条件。ただし停止を注入せず、2回以上の完全なheartbeat周期をencode中に観測できる長さが必要。
`E2E_PROCESSING_TIMEOUT_MS > 3 × heartbeat間隔(ms)` とする。試行上限2以上という追加制約はこの単独シナリオにはない。

```text
python app/scripts/run_reliability_e2e.py --scenario long-heartbeat
```

**成功判定：** `long-heartbeat-evidence.json` の `status=passed`、`cleanup=complete`。同じmessage/delivery/cycleに対するlease renewalとvisibility extensionの両方、期限前進、単一owner/attempt、最後の完了・ackを確認する。
片側の更新しか観測できない周期や短すぎるfixtureは未検証扱い。再生時間ではなく実encode時間を基準にfixtureを選ぶ。

### ffmpeg-exhaustion：実FFmpeg失敗・試行上限・DLQ隔離

**追加条件：** データ作成シナリオ共通条件と、専用DLQの `sqs:ReceiveMessage` 権限。不正MP4を `E2E_FFMPEG_INVALID_FIXTURE` に指定する。正常な `E2E_DUPLICATE_FIXTURE` はこのシナリオでは使わない。

新しい不正fixtureを作る例（既存ファイルは上書きしない）:

```text
node -e "require('node:fs').writeFileSync('invalid.mp4', 'not an mp4', {flag:'wx'})"
```

| 設定 | PowerShell | Bash |
| --- | --- | --- |
| 不正fixtureの絶対パス | `$env:E2E_FFMPEG_INVALID_FIXTURE = (Resolve-Path ./invalid.mp4).Path` | `export E2E_FFMPEG_INVALID_FIXTURE="$(pwd)/invalid.mp4"` |

Workerとsourceキューの試行上限・retry設定を一致させ、全試行・DLQ到達・到達後の安定観測を待てる予算にする。
全シナリオ共通のretry 10秒・試行上限3回を使う。旧環境のretry 900秒が残っている場合は、後述の固定設定への移行を先に行う。

```text
python app/scripts/run_reliability_e2e.py --scenario ffmpeg-exhaustion
```

**成功判定：** `ffmpeg-exhaustion-evidence.json` の `status=passed`、各attemptのFFmpeg非ゼロ終了、試行上限での永続FAILED、manifest非公開、run所有のDLQ通知との相関。
`cleanup=retained-dlq-message-visible-for-human-run-cleanup` はこのシナリオの正常な終了状態。DB/source/outputはrun単位でcleanupし、DLQメッセージは人手確認用に残す。
DLQ受信は事前権限確認時もvisibilityを変える。メッセージは自動削除・replayしない。後続の監視に使うrun IDを控える。

### poison-isolation：不正通知と正常jobの分離

**追加条件：** データ作成シナリオ共通条件、専用DLQ受信権限、**正常な** `E2E_DUPLICATE_FIXTURE`。
malformed本文と存在しないjobの通知はテストが生成するため、手動送信も不正fixture指定も不要。
正常jobの完了とpoisonの全redriveを `PROCESSING + VISIBILITY + NAVIGATION + poison専用DLQ予算` の範囲で待つ。固定設定の生成値では合計970秒（約16分10秒）。全段階が遅延した場合の上限であり、通常所要時間は15分以内を目標とする。poison専用DLQ予算はadapterが計算するため、シェルでDLQ変数を長くする必要はない。

```text
python app/scripts/run_reliability_e2e.py --scenario poison-isolation
```

**成功判定：** `poison-isolation-evidence.json` の `status=passed`、`result.cleanup=complete`、malformed/unknown-jobの2種類のDLQ相関、`result.unknownJobCount=0`、正常jobがattempt 1でCOMPLETEDになること。
`dlqCleanup=retained-for-human-cleanup` は想定どおり。DLQメッセージを人手確認用に残し、run IDを控える。
失敗時に `result.cleanup=retained` なら `cleanupReason` を確認し、対象runだけを復旧する。

### queue-monitoring：メトリクス・アラームと先行証跡の相関

**追加条件：** ホストに `cloudwatch:GetMetricData` と共通のSQS属性・alarm読み取り権限。fixtureは不要。
同じAWS account/region・source/DLQで成功したFFmpegとpoisonのJSONを、同じ証跡親ディレクトリに保持する。

`queue-monitoring` の観測期限はalarm取得を含む全AWS観測に適用する。期限到達時は実行中のCLIを中断し、追加取得せず最後の観測値を残す。SQS属性の件数は `attributeBacklog`、CloudWatchの件数・ageはメトリクス自身の時刻とともに別々に記録する。欠落・不正・遅延したメトリクスや未取得alarmは `outstanding` とし、実際の `INSUFFICIENT_DATA` と区別する。

先行証跡は `--ffmpeg-evidence-run` と `--poison-evidence-run` に各シナリオの証跡ディレクトリ名（`e2e-<UUIDv4>`）を指定して参照する。どちらも `--scenario queue-monitoring` 専用の任意引数であり、パスやファイル名は指定できない。`E2E_EVIDENCE_DIR` は3回の実行を通じて同じ証跡親ディレクトリを設定する。

1. `python app/scripts/run_reliability_e2e.py --scenario ffmpeg-exhaustion` を実行し、表示された `evidenceDirectory` の末尾のrun IDを控える。
2. `python app/scripts/run_reliability_e2e.py --scenario poison-isolation` を実行し、同様にrun IDを控える。
3. 実際のrun IDに置き換えて次を実行する（1行のコマンド）。

```text
python app/scripts/run_reliability_e2e.py --scenario queue-monitoring --ffmpeg-evidence-run e2e-11111111-1111-4111-8111-111111111111 --poison-evidence-run e2e-22222222-2222-4222-8222-222222222222
```

監視は新しいrun IDへ結果を保存し、先行証跡は読み取りのみで変更しない。入力は `<E2E_EVIDENCE_DIR>/<指定run ID>/ffmpeg-exhaustion-evidence.json` または `poison-isolation-evidence.json` に固定し、symlink/junctionによる別ディレクトリへの転送も拒否する。CLI引数は子プロセスへ内部環境変数で渡すが、以前の環境変数の値は引き継がない。

シナリオ名、指定run IDと証跡内run/targetの整合性、監視と同じ検証済みキュー・AWS account/region、UTC時刻、実際のDLQ相関を確認する。監視run IDと先行run IDが異なることは許容する。報告の `correlatedEvidence` に `requestedRunId`、証跡自身の `runId`、ファイル名、観測時刻、完全性を記録する。両証跡が `passed` かつ完全で、メトリクスとalarmの観測が揃ったときのみ全体を `passed` とする。

指定ファイルの欠落・不整合は `outstanding`。未指定のシナリオは従来どおり監視の証跡ディレクトリ内のみを確認し、他runの自動検索や障害シナリオの再実行はしない。通常の単独実行では、引数未指定分の先行証跡不足が残る。preflight情報のない旧poison証跡も未確認扱いとなる。先行テスト時点の隔離証拠と監視時点の近似メトリクスは別の観測であり、全alarmの強制的な `ALARM` 遷移は完了条件に含めない。

**成功判定：** `queue-monitoring-evidence.json` の `status=passed`、`outstanding=[]`、両先行証跡の完全性とメトリクス・alarm観測を確認する。
**単独実行は `outstanding` でもPlaywright終了コード0になることがあるため、終了コードだけで完了としない。** `--full` はこの状態を失敗として最終再生を止める。
現在のAWS観測期限はシナリオ内の300000 ms。`E2E_DLQ_TIMEOUT_MS` の変更では延びない。
メトリクス欠落時は下の「CloudWatchメトリクス診断」を確認し、原因を解決して監視だけを新しいrunで再実行できる。source/DLQのReceive・Delete・Purge・Replayは行わない。

### フル実行：全障害シナリオから最終ブラウザ再生まで

**追加条件：** 個別条件すべて。長めの正常MP4と不正MP4の両パス、exclusive宣言、時計ずれ、DLQ/メトリクス権限、Chromium・API・Frontendを**開始前に**揃える。`preflight` を先に実行してブラウザ側の準備も確認する。
フル実行は個別条件すべてを開始前に検証するわけではなく、後半の条件不足でも途中停止し得る。

正常fixtureは重複配送と両ライフサイクルで十分なencode時間があり、poisonの正常jobとしても完了できるものを選ぶ。
全シナリオに同じ固定時間設定を使う。実fixtureでの観測可能性は別途確認する。途中で設定変更やWorker再作成を行わない。完全コンテナIDが変わると再認可できなくなる。

```text
python app/scripts/run_reliability_e2e.py --scenario preflight
python app/scripts/run_reliability_e2e.py --full
```

順序は **duplicate-delivery → crash-recovery → long-heartbeat → ffmpeg-exhaustion → poison-isolation → queue-monitoring → 新規アップロード・Chromium再生**。
`--full-suite` は同義。監視への先行run IDの受け渡しは自動で行う。`--ffmpeg-evidence-run` / `--poison-evidence-run` はフル実行には指定しない。
`--full` は `runtime-authorization` / `preflight` を独立テストとしては実行しないが、各dispatchは共通の認可を再実行する。

最後の `@phase1-pipeline` はホストFFmpegで短い正常MP4を新規生成し、UIから1回アップロードする。正常・不正の指定fixtureを流用せず、自動再試行も行わない。
APIのCOMPLETED、HLS取得・Content-Type/CORS、player/networkの失敗不在、正の再生時間増分を検証する。単独の `--scenario phase1-pipeline` は登録されていない。

**成功判定：** 親ディレクトリの `full-suite-*.json` が `status=passed`、7行すべて `passed`、`unexecutedLiveChecks=[]`。
各行の `evidenceFile` を開き、シナリオ・run IDが一致する成功証跡を確認する。最終行は `phase1-pipeline-evidence.json` でvideo/job ID、ネットワーク、状態、再生時間の観測を保存する。失敗時も取得できた途中観測を残す。

| フル実行の終了コード | 意味・対応 |
| --- | --- |
| 0 | 全7行が成功し、対応する証跡も検証済み |
| 1 | テスト失敗、証跡の欠落・不整合・未完了。失敗行を確認し、後続の `unexecuted` を実施済みと扱わない |
| 2 | 設定・再認可・起動がblocked、または集約レポートを保存できない。標準エラーも確認する |

途中のblockedでも保存可能なら実行済み行と残りの未実行一覧を保持する。初期設定検証や保存先自体の失敗では集約JSONが存在しない場合がある。
`componentChecks` は別途実行するオフライン検証コマンドの宣言であり、このフル実行がコンポーネントテストを実施した意味ではない。
レポートだけでなく、参照される各runディレクトリを一緒に保存する。
最終Phase 1テストは一時fixtureを削除するが、アップロードしたDB/S3資源の自動cleanupは行わない。証跡のvideo/job IDで残存資源を確認する。
前半のDLQ保持分も含め、当該runの範囲で人手確認・cleanupを行う。

## 時間設定・検証詳細・復旧

### 専用環境の固定時間設定

E2E専用Terraformは次の1組を使う。シナリオごとの設定選択・切り替えは不要。
通常環境のTerraform既定値は変更しない。

| heartbeat | source visibility / Worker延長 | lease | retry | Worker試行上限 / SQS maxReceiveCount |
| --- | --- | --- | --- | --- |
| 5秒 | 120秒 / 120秒 | 60秒 | 10秒 | 3 / 3 |

通常は1シナリオ15分以内を目標とする。30分の厳密な上限や全体watchdogは追加しない。
既存の段階別タイムアウトと、復旧・cleanupを含む余裕のあるPlaywrightタイムアウトを維持する。
異常時は通常所要時間より長く待つ場合がある。タイムアウトを短くするだけでWorker復旧を中断しない。

正常fixtureはencode約25〜40秒を初期目安とし、アップロード・segment/manifest公開を含む正常処理が概ね3分以内となるものを実測して選ぶ。
重複通知の初回受信から完了までの時間は、通常の配送を前提に `(受信上限 − 1) × visibility`（固定値では240秒）を十分下回るようにする。
最後の受信枠を完了後のackに残すためであり、SQSの配送時刻を保証する式ではない。
長時間heartbeatを観測できるencode時間を維持しつつ、出力segment数・転送時間を抑える。今回のようにencode後のS3公開が長い場合も処理時間に含める。

#### 旧設定からの移行（環境ごとに一度）

`timing_profile` 変数は廃止した。実値tfvarsの該当行、`TF_VAR_timing_profile`、実行スクリプトの `-var=timing_profile=...` を削除する。
テスト・jobが稼働していないことと残存runを確認し、構築用AWS認証で専用環境の変更planを確認する。

```text
docker compose -p streaming-video-e2e -f app/compose.yaml -f app/compose.e2e.yaml stop worker
terraform -chdir=app/infra/terraform-e2e plan -out=e2e.tfplan
```

対象が当該専用環境だけであることを確認して適用する。

```text
terraform -chdir=app/infra/terraform-e2e apply e2e.tfplan
```

共通準備の手順で `compose_environment` を再読込し、Worker認証を設定したシェルでWorkerを再作成する。

```text
docker compose -p streaming-video-e2e -f app/compose.yaml -f app/compose.e2e.yaml up -d --no-deps --force-recreate worker
```

ホスト認証をrunner用に戻し、E2E設定を再生成・再読込して共通事前確認を行う。
ファイルを更新しただけではSQSや起動済みWorkerの設定は変わらない。ホストのE2E変数だけを変更して整合を取らない。
既存通知の受信回数もリセットされないため、保持runは証跡のIDで確認する。queue purgeやDLQ自動replayは行わない。

タイムアウトは `encode readiness`（開始・更新待ち）、`lease and visibility expiry`（期限切れ待ち）、
`completion and acknowledgement`（完了・ack待ち）と待機予算を表示する。

追加条件とコマンドは前述の `crash-recovery` / `long-heartbeat` の手順を使用する。以下は観測・復旧の詳細。

クラッシュ復旧はencode開始・1回のheartbeat成功・DB lease更新を確認後、共通事前確認済みのWorkerを
`docker container stop --signal SIGKILL --timeout 0` で停止する。DBは停止しない。
停止後のDB lease値とDB時計、最後のvisibility延長を記録し、安全な再開時刻を計算する。
停止直前の未記録の更新も考慮して、停止観測時刻＋`E2E_VISIBILITY_TIMEOUT_MS` をvisibilityの保守的な上限に含める。
これはSQSが返した実際の失効時刻ではない。DB上のlease失効とローカルの再開期限の両方を待ち、
同じコンテナーをstartする。新しい通知を送らず、元message IDの別delivery ID・別owner・attempt 2での再取得を確認する。
停止中の完了や所有権変更、期限より早い再取得は失敗とする。

長時間heartbeatでは実Workerを止めず、`lease_renewal` と `visibility_extension` の成功を
message/delivery/cycleで対応付け、両方そろった周期だけを数える。lease側はjob/video/worker/attemptも照合する。
要求時刻＋期間−時計ずれから得る期限は保守的な下限であり、DB/SQSの確定したexpiryとして扱わない。
両期限の前進、DB leaseの前進、単一owner/attempt、最終完了までの失敗不在を検証する。
正常終了直前のキャンセルでも周期の片側しか観測できなければ、現在は保守的に `unverified` とする。

両シナリオとも正規sourceのdownloadからencodeを経て、segment→manifest→COMPLETED→ackの証拠を確認し、
期待する決定的な出力キーとS3の実際の一覧・metadataを照合する。
待機はPROCESSING、VISIBILITY、LEASE、NAVIGATIONの設定値から制限し、観測履歴は4000件まで。
外部コマンド・相関ログ・出力検証・cleanupの上限は重複配送シナリオと共通。

停止後に失敗した場合も同じWorkerを復元してからrun専用の後始末を行う。
別の起動時刻・Engine・scopeやDB再起動を検出した場合は操作を継続しない。
復元失敗時は `restoration=failed, cleanup=retained` とし、証跡に記録された同一コンテナーの状態を
手動確認する。処理中・ack未確認・不明な更新結果ではデータを保持し、queue全体のpurgeやDLQ replayは行わない。

オフライン検証だけではライブ検証完了とはしない。マージ前に使い捨て環境で両コマンドを実行し、
上記成功条件を満たす証跡を別途保存する必要がある。

<details>
<summary>シナリオの検証内容・証跡の詳細</summary>

重複配送では新しいvideo/jobを作り、sourceをS3へアップロードする。処理中に同じsourceの通知を注入し、
同じ所有者・attempt・有効leaseのまま対象メッセージがbusy/retainedになることを確認する。
一度のdownload/encode/publication、manifest-last、COMPLETED、元メッセージとbusyメッセージのackを待つ。
完了後にもう一度通知し、already_completedとackのみ、updated_atを含むDB状態の不変を確認して出力検証・cleanupを行う。

自動シナリオ再試行は行わない。配送待機はVISIBILITY+NAVIGATION、処理完了/ack待機はPROCESSING+配送予算。
外部コマンドは10秒、source uploadのみUPLOAD予算。出力一覧は512オブジェクト、相関ログは20000イベント/16 MiBが上限。

証跡にはrun/video/job ID、3つのmessage ID、受信ごとのdelivery ID、owner/attempt、処理段階、lease・状態・cleanupを残す。
`observedAtMs` はDB時計、イベントの `at` はWorker UTC時刻。認証情報・receipt handle・DB URL・生ログ・presigned queryは含めない。
`worker_delivery` spanで配送を、`worker_attempt` spanでjob/video/worker/attemptを相関する。
処理段階は `operation=download|encode|segment_upload|manifest_upload` と `outcome=start|success` から正規化する。
Workerログに個々のオブジェクトキーはないため、upload回数と順序から期待キーを算出し、S3一覧・metadataと独立に照合する。
相関不能なunknown message IDや不足した観測はunverified。証跡は環境ごと・実行ごとに保持する。

</details>

<details>
<summary>失敗時の診断・再実行</summary>

| 診断 | 確認箇所 |
| --- | --- |
| `Cannot find module ... @playwright/test/cli.js` | 実行OS側で `npm --prefix app/frontend ci --include=dev` |
| `disposable container is not stably running` | Worker/DBのRunning・Restarting・PID。再起動中はWorkerログと認証を確認 |
| `read-only docker observation failed` | Docker接続先、CLI権限、10秒期限、再作成後の古いID、volume観測 |
| `worker resource settings do not match observed targets` | WorkerのAWS/VIDEO設定とシェルのAWS/E2E設定を照合。変更後は再生成・再読込 |
| `Source key does not match notification filters` | 実バケットとprefix/suffixの値を確認 |
| `Dedicated database contains active work` | 過去の失敗で残ったUPLOADING等を証跡のjob/video IDと照合 |
| `Upload outcome uncertain ... [分類]` | ホスト認証・ファイル・通信・UPLOAD予算。Worker認証ではない |

アップロード診断の分類は `access_denied`、`credentials_missing`、`credentials_expired`、`credentials_invalid`、
`signature_mismatch`、`timeout`、`network`、`tls`、`file_read`、`bucket_missing`、`region_mismatch`、
`cli_missing`、`process_permission`、`response_too_large`、`invalid_response`、`unknown`。
分類は原因の手掛かりであり、リモート処理の成否を断定しない。timeoutにはローカルの時間制限とCLI通信タイムアウトの両方を含む。
元エラー・秘密値は出力しない。

次はWindows・WSL共通。`<...>` は生成済み設定と今回の証跡から転記する。
DB名・ユーザーを変更した場合は `-U` / `-d` も変更する。

```text
docker compose -p streaming-video-e2e -f app/compose.yaml -f app/compose.e2e.yaml ps
aws s3api head-object --bucket "<E2E_SOURCE_BUCKETの値>" --key "<証跡のtarget.sourceKey>" --region "<AWS_REGIONの値>"
docker compose -p streaming-video-e2e -f app/compose.yaml -f app/compose.e2e.yaml exec postgres psql -U streaming_video -d streaming_video
```

S3の404は確認時点で不在、403は存在判定不能。DB接続後は次で未完了のjobを確認する。

```sql
SELECT id, video_id, status, attempt, worker_id, lease_expires_at, updated_at
FROM jobs WHERE status IN ('UPLOADING', 'QUEUED', 'PROCESSING') ORDER BY updated_at;
```

曖昧なupload/send、未ack通知、active lease、コンテナ変更、未知オブジェクト、所有権確認不能は
`cleanup=retained` / `status=unverified` とする。S3が404でも、upload前に作成したDBレコードは残り得る。
証跡の正確なID、DB状態、S3状態、未処理通知を照合し、対象runだけを手動復旧してから再実行する。
全件DELETE、状態の強制変更、queue purge、DLQ自動replayで通してはいけない。
通常cleanupは完了と既知メッセージの最新配送のackを待ち、削除対象全体を検査してsource/HLSと所有確認済みvideoを削除する（jobsはCASCADE）。
重複配送・ライフサイクルのテスト自体はReceiveMessage/DeleteMessageを使わない（FFmpeg・poisonのDLQ受信は前述のとおり）。SQSの後発再配送が永久にないことまでは保証しない。

</details>

<details>
<summary>環境の終了・削除（不要になったときだけ）</summary>

環境を終了する際は証跡と保持リソースを確認してから実行する。

```text
# コンテナ・ネットワークを終了。DB volumeは保持
docker compose -p streaming-video-e2e -f app/compose.yaml -f app/compose.e2e.yaml down
```

DBも破棄可能と確認した場合だけ同じコマンドに `--volumes` を付ける。AWSの保持データはCompose終了では削除されない。
AWS環境も不要になったら、専用Worker停止、残存オブジェクト、手動付与policy attachment・IAM認証情報を管理者が確認する。

構築時と同じ方法で `AWS_PROFILE` を `e2e-provisioner` に切り替える。

```text
terraform -chdir=app/infra/terraform-e2e plan -destroy -out=destroy.tfplan
# 当該E2E環境だけが対象であることを確認後
terraform -chdir=app/infra/terraform-e2e apply destroy.tfplan
```

非空バケットを自動で強制削除する設定にはしていない。stateは正常な削除が完了するまで保持する。

</details>

<details>
<summary>実装変更時の検証（通常のE2E実行では不要）</summary>

```text
npm --prefix app/frontend run test:e2e:helpers
npm --prefix app/frontend run test:e2e:type-check
```

helpersはfake境界で認可・redaction・シナリオ・cleanup・設定生成を検証する。

Terraformの変更を検証する場合（手動）:

```text
terraform -chdir=app/infra/terraform-e2e fmt -check
terraform -chdir=app/infra/terraform-e2e init -backend=false
terraform -chdir=app/infra/terraform-e2e validate
terraform -chdir=app/infra/terraform-e2e test
```

initはprovider取得のため通信する。テストはmockで既存構成とE2E側の受け渡しを分けて検証し、AWSを操作しない。
Workerのコンポーネント証跡も維持する。各テストは次の形式で選択できる。

```text
cargo test --manifest-path app/backend/worker/Cargo.toml <テスト名>
```

| 検証範囲 | テスト名・証拠 |
| --- | --- |
| download / manifest失敗 | `each_pipeline_failure_obeys_attempt_budget_and_cleans_up`（stage 0 / 4）。未完了・試行上限・作業領域cleanup |
| 部分segment upload | `partial_upload_redelivery_reacquires_and_publishes_before_acknowledgement`。状態・attempt・encode回数・公開/ack順序 |
| DB更新失敗・古い所有者 | `stale_owner_and_database_errors_never_report_terminal_success`。InfrastructureFailure / OwnershipLostの区別 |
| 完了後の削除失敗 | `delete_failure_redelivery_only_retries_acknowledgement`。COMPLETED維持・再encodeなし・削除のみ再試行 |

コンポーネントテスト成功は実環境シナリオの代用ではない。

</details>

<details>
<summary>DB時計の許容差エラー</summary>

`Database clock is outside the configured skew bound` はエラー本文と証跡の `clockDiagnostic` で確認する。
値はミリ秒。`dbNowMs` はDB時刻、`localBeforeMs` / `localAfterMs` は照会前後の実行側時刻、
`allowedSkewMs` は設定した許容差、`observationElapsedMs` は照会前後の時間差。
`cause=db_behind` / `db_ahead` の `excessMs` は許容範囲からの超過量。
`local_clock_reversed` は実行側の時計が逆行したことを示し、`excessMs` は逆行量。
Workerのheartbeatログは `abs((応答時刻 − 開始時刻) − elapsed_ms) <= E2E_CLOCK_SKEW_MS` で時計変動を判定する。`elapsed_ms` は単調時計による処理時間で、応答時刻が開始時刻より前という理由だけでは失敗させない。lease更新とvisibility延長の間、およびcycle間の時刻比較にも許容差を適用するが、cycle番号・所有者・操作成功・期限切れの検証は維持する。更新期限の保守的な下限には開始・応答の早い方を使って許容差を引き、再開待機用のvisibility期限には遅い方を使って許容差を加える。既存の停止時刻からの待機下限も維持する。
ローカル時計が逆行した観測はログ・DB値を含めて破棄し、最大2回再取得する（初回を含め3回）。正常な観測だけを復旧時刻の計算に使う。3回続けて逆行した場合は最後の診断を保存して失敗する。`allowedSkewMs` はDBとの時計差の許容値であり、逆行の許容値ではない。DBとの時計差が許容範囲を超えた場合やDB照会エラーは再試行しない。
この診断は時計差の観測であり、OS時刻同期やスリープ復帰などの根本原因を断定しない。
照会時間が長いだけでは失敗しない。許容差を増やす前に数値と実行環境の時計を確認する。

</details>

### CloudWatchメトリクス診断

`queueObservations[].metricRequest` にregion、QueueName、namespace、取得期間、集計周期・方法を記録する。`metricDiagnostics` は各メトリクスのquery ID、メトリクス名、返却ID、StatusCode、値・時刻の件数、最大3点のサンプル、最大5件のAWSメッセージを保持する。文字列は長さを制限し、秘密情報やURLクエリを除去する。

| reason | 意味 |
| --- | --- |
| `observed` | 有効な値と時刻を取得 |
| `no-datapoints` | Complete応答だがデータ点が0件。未配信・非活動・取得条件の不一致のどれかは、この結果だけでは断定しない |
| `missing-result` / `duplicate-result` | 要求IDが応答にない／重複 |
| `partial-data` | AWSがPartialDataを返した |
| `service-error` | AWSがForbiddenまたはInternalErrorを返した |
| `invalid-status` / `invalid-response` | 状態値や応答構造、配列長が不正 |
| `invalid-values` / `invalid-timestamps` | 数値またはUTC時刻を解析・検証できない |
| `outside-window` | データが取得期間外 |
| `request-error` | CLI失敗、タイムアウト、JSON解析失敗など。errorCodeに固定分類を記録 |

`outstanding` にキュー・query ID・理由を併記する。request-error/service-errorは待機を打ち切り、`metricObservation.status: error` として証跡を保存する。それ以外の未確認は期限まで再観測し、最後の診断を保持する。`metric-delay`だけを根拠にAWSの配信遅延と判断しない。現在の必須メトリクスと成功条件は維持している。
