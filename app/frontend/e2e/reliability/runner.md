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
| 未登録 | 不正メディア、試行上限、DLQ隔離・アラーム | 追加予定。実行可能なセレクターは未登録 |
| 未登録 | Reliabilityシナリオ後のブラウザ再生回帰 | 追加予定。既存ブラウザテストとは別に拡張 |

最新の実装済みセレクターは `--list` で確認する。実環境の受け入れは対象環境で成功した証跡をレビューして判断する。
シナリオ追加時はこの表と、以下の「シナリオ別の追加条件」「実行」「証跡・復旧」を追記する。
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

runner policyはホスト側principalへ手動付与する。Terraform適用権限は含まず、queueのReceive/Delete/PurgeやDLQ replay権限も付与しない。
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

PowerShellの例（アカウントとfixtureを実値へ置換）:

```powershell
$workerId = docker compose -p streaming-video-e2e -f app/compose.yaml -f app/compose.e2e.yaml ps -q worker
$dbId = docker compose -p streaming-video-e2e -f app/compose.yaml -f app/compose.e2e.yaml ps -q postgres
node app/scripts/generate_reliability_env.mjs --worker $workerId --database $dbId --account 123456789012 --fixture C:/e2e/long.mp4 --exclusive --output ./reliability-env.local.ps1
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
  settings=$(node --input-type=module - "$worker_id" "$db_id" '123456789012' "$HOME/e2e/fixtures/test.mp4" <<'JS'
import { discoverEnvironment } from './app/scripts/generate_reliability_env.mjs'
const [worker, database, account, fixture] = process.argv.slice(2)
try {
  const env = discoverEnvironment({ worker, database, account, fixture, exclusive: true })
  console.log(JSON.stringify(env))
} catch { console.error('E2E設定生成失敗。認証・接続先・ラベル・アラームを確認してください'); process.exitCode = 2 }
JS
  ) || return 1
  entries=$(printf '%s' "$settings" | jq -r 'to_entries[] | "\(.key)=\(.value)"') || return 1
  while IFS= read -r entry; do export "$entry"; done <<< "$entries"
}
load_e2e || echo '設定生成失敗。後続の実行を止めて確認してください' >&2
```

</details>

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
| `--fixture` | 絶対パスへ変換し存在・拡張子・サイズを検査。省略時は空欄を手動補完 |
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

</details>

### シナリオ別の追加条件

| シナリオ | 条件 |
| --- | --- |
| 重複配送 | 他のテスト・consumerと対象を共有せず `E2E_DUPLICATE_EXCLUSIVE=true`。DB内のUPLOADING/QUEUED/PROCESSINGが0件 |
| 重複配送 | `E2E_DUPLICATE_FIXTURE` は有効なMP4の絶対パス、非空、1 GiB以下。WSLでは `/home/.../test.mp4` 形式 |
| 重複配送 | encode中にbusy配送を観測できる処理時間が必要。短すぎればunverified、長すぎてredrive上限に達しても失敗 |
| 重複配送 | 非versionedバケット。Enabled/Suspendedは不可。Standardキューに単一の直接S3通知、他のSNS/Lambda/EventBridge通知なし |
| 重複配送 | 通知フィルタが `videos/<video UUID>/jobs/<job UUID>/source.mp4` に一致。通常prefix `videos/`、suffix `/source.mp4`。フィルタ名の大小文字は吸収するが値は厳密比較 |
| 重複配送 | Worker起動ログに `duplicate_observation_schema=1`。起動以降の末尾2000行から確認できること |

ホストには共通のSTS、S3 HeadBucket/GetBucketLocation、SQS GetQueueUrl/GetQueueAttributes、CloudWatch DescribeAlarmsの読み取りが必要。
重複配送ではさらにsource SendMessage、S3通知/versioning/list、source PutObject、output HeadObject、runオブジェクトDeleteObjectを使う。
HeadBucketのIAM権限はListBucket、HeadObjectはGetObject。DBロールには対象video/jobの作成・参照・削除が必要で、DB名・ユーザー名は英数字とunderscoreのみ対応。

## 実行手順

事前準備でコンテナを起動し、E2E設定と認証を読み込んだ**同じシェル**で実行する。
以下のコマンドはWindows（PowerShell）・WSL（Bash）共通。

### 1. 事前確認

```text
python app/scripts/run_reliability_e2e.py --check
python app/scripts/run_reliability_e2e.py --live-preflight
```

`--check` が `configured; live resources not verified`、`--live-preflight` が `status=verified` になったら次へ進む。
`not configured` / `blocked` の場合は設定を確認する。
実環境の事前確認は読み取りだけを行い、結果を `preflight-<UUID>/live-preflight.json` に保存する。
シナリオ固有のfixture・通知・DB等の条件は実行時にも確認する。

### 2. シナリオ実行

```text
python app/scripts/run_reliability_e2e.py --scenario duplicate-delivery
python app/scripts/run_reliability_e2e.py --scenario crash-recovery
python app/scripts/run_reliability_e2e.py --scenario long-heartbeat
```

`duplicate-delivery` は実行対象に置き換える。選択肢は次で確認できる。

```text
python app/scripts/run_reliability_e2e.py --list
```

実行時にも共通事前確認を行い、runごとに新しい証跡ディレクトリを作成する。自動再試行は行わない。

### 3. 結果確認

終了コード0とテストの `passed` を確認し、表示された `evidenceDirectory` 内のシナリオ証跡を開く。
重複配送では `duplicate-delivery-evidence.json` の **`status=passed`、`cleanup=complete`** が成功条件。
クラッシュ復旧・長時間heartbeatは、それぞれ `crash-recovery-evidence.json` / `long-heartbeat-evidence.json` の
`status=passed`、`cleanup=complete` を確認する。クラッシュ復旧では `restoration=complete` も必要。
Slow test警告だけでは失敗ではない。`unverified` / `retained` の場合は下の診断を確認してから再実行する。

### クラッシュ復旧・長時間heartbeatの追加条件

E2E専用Terraformの `timing_profile` で時間設定を選択する。既定は `standard`。

| プロファイル | heartbeat | source visibility / Worker延長 | lease | 用途 |
| --- | --- | --- | --- | --- |
| `standard` | 30秒 | 120秒 | 300秒 | 重複配送など通常のE2E |
| `lifecycle` | 5秒 | 30秒 | 30秒 | 復旧・heartbeat検証の待ち時間短縮 |

**設定はその専用環境全体に適用される。シナリオ選択による自動切り替え・自動復元は行わない。**
同時に別シナリオを実行しない。並行実行が必要なら別instance・別state・別Composeプロジェクトを用意する。

<details>
<summary>短い時間設定への切り替え・元に戻す手順（Windows・WSL共通）</summary>

実行中のテスト・jobと保持リソースを確認し、切り替えてよい状態にしてWorkerを停止する。
AWS認証は構築用プロファイルを使用する。

```text
docker compose -p streaming-video-e2e -f app/compose.yaml -f app/compose.e2e.yaml stop worker
terraform -chdir=app/infra/terraform-e2e plan -var="timing_profile=lifecycle" -out=lifecycle.tfplan
```

対象が専用環境であることをplanで確認して適用する。

```text
terraform -chdir=app/infra/terraform-e2e apply lifecycle.tfplan
```

`compose_environment` を再読込し、Worker用認証を設定した同じシェルで再作成する。

```text
docker compose -p streaming-video-e2e -f app/compose.yaml -f app/compose.e2e.yaml up -d --no-deps --force-recreate worker
```

ホスト認証をrunner用に戻し、E2E設定を再生成・再読込して事前確認と対象シナリオを実行する。
CLIの `-var` は次回のplanには引き継がれない。継続利用する専用環境なら実値tfvarsで明示する。

他のE2Eへ戻す前に同じ停止・確認手順を行い、以下で標準設定へ戻す。

```text
terraform -chdir=app/infra/terraform-e2e plan -var="timing_profile=standard" -out=standard.tfplan
```

planを確認後に適用する。

```text
terraform -chdir=app/infra/terraform-e2e apply standard.tfplan
```

戻す場合もCompose出力再読込・Worker再作成・E2E設定再生成が必要。tfvarsで変更した場合も `standard` に戻す。
以前の一律短縮設定を適用済みの環境にも、この標準設定への復元手順を使用する。
通常環境のTerraformと復旧後の完了・ack検証は変更しない。

</details>

タイムアウトは `encode readiness`（開始・更新待ち）、`lease and visibility expiry`（期限切れ待ち）、
`completion and acknowledgement`（完了・ack待ち）と待機予算を表示する。

両シナリオは上記の共通事前確認と同じ専用Worker/DB/S3/SQSを使用する。
`E2E_DUPLICATE_EXCLUSIVE=true` と `E2E_DUPLICATE_FIXTURE` の絶対MP4パスも共通で使用する。
クラッシュ復旧はencode中に1回のheartbeat成功とDB leaseの前進を確認して停止する。
長時間heartbeatは2回以上の更新を観測できるfixtureを使う。容量ではなく実際の処理時間で判断する。
短いfixture、観測不足、失敗イベントは `unverified` となり、skipや成功にはしない。

- Workerには `heartbeat_observation_schema=1` と `duplicate_observation_schema=1` が必要。
- `E2E_CLOCK_SKEW_MS` を1〜5000の整数で明示する。実行ホスト・Worker・DBの時計ずれの上限であり、
  時刻同期を確認した上で設定する。DB時計は各観測の要求〜応答区間とこの許容幅で照合する。
  heartbeat要求・応答の時刻差と単調時計によるelapsedも照合する。
- `E2E_PROCESSING_TIMEOUT_MS` はクラッシュ復旧ではheartbeat間隔の2倍、長時間heartbeatでは3倍より大きくする。
  時計ずれの許容幅の2倍はlease/visibility期間より小さい必要がある。
- クラッシュ復旧には残り試行回数が必要で、`E2E_MAX_ATTEMPTS >= 2` とする。
  Workerは保持される専用コンテナーで、restart policyが `no` であることが必要。
  設定が合わなければ停止せずに失敗する。シナリオ自身はrestart policyを変更しない。

```text
# 共通設定に加えて、確認した時計ずれ上限を設定する例
E2E_CLOCK_SKEW_MS=100

python app/scripts/run_reliability_e2e.py --scenario crash-recovery
python app/scripts/run_reliability_e2e.py --scenario long-heartbeat
```

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
テスト自体はReceiveMessage/DeleteMessageを使わない。SQSの後発再配送が永久にないことまでは保証しない。

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
