# Recovery E2E: 環境変数の値の確認方法

[手動実行手順](recovery-runbook.md)の設定値を調べるためのガイドです。
以下はPowerShell用です。Docker/AWSコマンドは読み取りのみで、資源の作成・停止・設定変更は行いません。
`<...>` は専用環境の実際の値に置き換え、同じPowerShellセッションで上から順に確認してください。
これは値の取得方法であり、対象がdisposableかどうかは環境管理者の確認が必要です。

## 設定値と確認元の一覧

| 環境変数 | 設定する値・確認元 |
|---|---|
| `AWS_PROFILE` | 実行端末で利用できる専用環境用profile名。`aws configure list-profiles`で候補確認。通常の認証チェーンを使う場合は必須ではない |
| `AWS_REGION` | 対象workerコンテナの`AWS_REGION`。AWS profileの既定regionだけで決めない |
| `E2E_AWS_ACCOUNT_ID` | 実行する認証でのSTS `Account`。環境管理者から確認した専用環境の12桁account IDと一致させる |
| `E2E_DOCKER_HOST` | 対象コンテナを管理する直接接続のローカルDocker Engine endpoint |
| `E2E_WORKER_OBSERVATION` | `docker:`＋専用workerの64文字のfull container ID |
| `E2E_WORKER_PROCESS_CONTROL` | `E2E_WORKER_OBSERVATION`と完全に同じ値 |
| `E2E_DATABASE_OBSERVATION` | `docker:`＋workerの接続先PostgreSQLコンテナのfull ID |
| `E2E_DATABASE_PROCESS_CONTROL` | `E2E_DATABASE_OBSERVATION`と完全に同じ値 |
| `E2E_WORKER_CONTROL_SCOPE` | workerラベル`com.streaming-video.e2e.scope`の実値 |
| `E2E_DATABASE_CONTROL_SCOPE` | PostgreSQLラベル`com.streaming-video.e2e.scope`の実値 |
| `E2E_SOURCE_QUEUE` | workerの`VIDEO_ENCODING_QUEUE_URL`を使用できる。queue名でも可。ARNは指定しない |
| `E2E_SOURCE_BUCKET` | workerの`VIDEO_INPUT_BUCKET`。bucket名のみ |
| `E2E_OUTPUT_BUCKET` | workerの`VIDEO_OUTPUT_BUCKET`。bucket名のみ |
| `E2E_DLQ` | source queueの実`RedrivePolicy.deadLetterTargetArn`から特定したDLQ名またはURL。ARNは指定しない |
| `E2E_SOURCE_DLQ` | 確認済みの`E2E_DLQ`と完全に同じ値 |
| `E2E_SOURCE_DLQ_RELATIONSHIP` | source queueのredrive先が上記DLQであると確認した後、`verified` |
| `E2E_MAX_ATTEMPTS` | workerの`WORKER_MAXIMUM_ATTEMPTS`とsource queueの`maxReceiveCount`の一致値。crashは2～10 |
| `E2E_ALARM_IDENTIFIERS` | 対象source/DLQに紐づく3種類のCloudWatch metric alarmの名前をカンマ区切り。ARNは指定しない |
| `E2E_FRONTEND_URL` | 実行端末からfrontendへアクセスするHTTP(S) URL。公開ポートから確認 |
| `E2E_API_URL` | 実行端末からAPIへアクセスするURL。通常は`http://127.0.0.1:<公開ポート>`。health確認は末尾に`/api/v1/health`を付ける |
| `E2E_RECOVERY_FIXTURE` | 実行端末にある長いMP4の絶対パス。`Resolve-Path`と`Get-Item`で確認 |
| `E2E_EVIDENCE_DIR` | 実行者が選ぶ書き込み可能な絶対ディレクトリ。runごとの子ディレクトリが作られる |
| `E2E_ENVIRONMENT` | 対象がdisposableであることを確認した上で`disposable` |
| `E2E_RELIABILITY_DISPOSABLE` | 同じ確認の上で`true` |
| `E2E_RECOVERY_EXCLUSIVE` | worker/DB/queue/bucketを他のconsumer・作業・E2Eと共有しないことを確認した上で`true` |
| `E2E_*_TIMEOUT_MS` | 実行者が決める観測予算。下記の実worker設定との下限比較が必要 |
| `E2E_RUN_ID` | 設定不要。Python runnerが毎回生成する |

## 1. Docker endpoint、コンテナID、scope

現在選択されているDocker contextの接続先を確認できます。
[Docker公式: context inspect](https://docs.docker.com/reference/cli/docker/context/inspect/)

```powershell
$recoveryContext = docker context show
docker context inspect $recoveryContext --format '{{.Endpoints.docker.Host}}'
```

現行adapterが対応する値は次の形式です。

- Windows: `npipe:////./pipe/docker_engine`
- Linux/WSL: `unix:///var/run/docker.sock`等の直接接続ローカルUnix socket

`tcp://`、`ssh://`、別名のWindows pipeは現行validatorの対象外です。
contextの出力が対象外だった場合、文字列だけを対応形式に書き換えないでください。
同じ専用コンテナに到達できる対応endpointがあるかを環境管理者に確認してください。

```powershell
$env:E2E_DOCKER_HOST = '<確認した対応endpoint>'
docker --host $env:E2E_DOCKER_HOST info --format '{{.ID}} {{.OSType}}'
docker --host $env:E2E_DOCKER_HOST container ls --all --no-trunc --filter 'label=com.streaming-video.e2e.disposable=true' --format '{{.ID}} {{.Names}}'
```

候補からworkerと、そのworkerが接続するPostgreSQLを選びます。候補がない場合は専用環境の準備が先です。

```powershell
$recoveryWorkerRef = '<専用workerの名前またはID>'
$recoveryDatabaseRef = '<接続先の専用PostgreSQLの名前またはID>'
$recoveryWorkerId = (docker --host $env:E2E_DOCKER_HOST container inspect --format '{{.Id}}' $recoveryWorkerRef).Trim()
$recoveryDatabaseId = (docker --host $env:E2E_DOCKER_HOST container inspect --format '{{.Id}}' $recoveryDatabaseRef).Trim()
if ($recoveryWorkerId -notmatch '^[a-f0-9]{64}$' -or $recoveryDatabaseId -notmatch '^[a-f0-9]{64}$') { throw 'full container IDを取得できませんでした' }

$env:E2E_WORKER_OBSERVATION = "docker:$recoveryWorkerId"
$env:E2E_WORKER_PROCESS_CONTROL = $env:E2E_WORKER_OBSERVATION
$env:E2E_DATABASE_OBSERVATION = "docker:$recoveryDatabaseId"
$env:E2E_DATABASE_PROCESS_CONTROL = $env:E2E_DATABASE_OBSERVATION

$env:E2E_WORKER_CONTROL_SCOPE = (docker --host $env:E2E_DOCKER_HOST container inspect --format '{{index .Config.Labels "com.streaming-video.e2e.scope"}}' $recoveryWorkerId).Trim()
$env:E2E_DATABASE_CONTROL_SCOPE = (docker --host $env:E2E_DOCKER_HOST container inspect --format '{{index .Config.Labels "com.streaming-video.e2e.scope"}}' $recoveryDatabaseId).Trim()

docker --host $env:E2E_DOCKER_HOST container inspect --format '{{index .Config.Labels "com.streaming-video.e2e.disposable"}} {{index .Config.Labels "com.streaming-video.e2e.role"}} {{.HostConfig.RestartPolicy.Name}}' $recoveryWorkerId
docker --host $env:E2E_DOCKER_HOST container inspect --format '{{index .Config.Labels "com.streaming-video.e2e.disposable"}} {{index .Config.Labels "com.streaming-video.e2e.role"}}' $recoveryDatabaseId
```

期待する出力はworkerが`true worker no`、DBが`true database`です。
scopeが空・`<no value>`・汎用的な`shared`等の場合は条件不成立です。
DBのnamed volumeにも同じdisposable/scopeラベルが必要で、他のコンテナとの共有は不可です。
最終的なDB接続先・network・volumeの一致はpreflightが検査します。

**リポジトリの通常のComposeは、専用ラベルがなくworkerのrestart policyが`unless-stopped`です。**
そのままでは今回のE2Eに使用できません。これらはE2E環境変数で上書きできる条件ではありません。

## 2. workerが実際に使っている非秘密の設定を確認する

コンテナ作成時の実値を使います。`.env.example`、Compose既定値、Terraform入力値だけを根拠にしません。
以下は環境配列をメモリに受け取り、必要な非秘密キーだけを表示します。
ブロック全体で実行し、`$recoveryRawEnv`や無加工のinspect結果を表示・保存しないでください。

```powershell
$recoveryRawEnv = docker --host $env:E2E_DOCKER_HOST container inspect --format '{{json .Config.Env}}' $recoveryWorkerId | ConvertFrom-Json
$recoveryAllowedKeys = @('AWS_REGION', 'VIDEO_ENCODING_QUEUE_URL', 'VIDEO_INPUT_BUCKET', 'VIDEO_OUTPUT_BUCKET', 'WORKER_HEARTBEAT_INTERVAL_SECONDS', 'WORKER_VISIBILITY_EXTENSION_SECONDS', 'WORKER_LEASE_DURATION_SECONDS', 'WORKER_RETRY_DELAY_SECONDS', 'WORKER_MAXIMUM_ATTEMPTS', 'TMPDIR')
$recoverySettings = @{}
foreach ($entry in $recoveryRawEnv) {
    $parts = $entry -split '=', 2
    if ($recoveryAllowedKeys -contains $parts[0]) { $recoverySettings[$parts[0]] = $parts[1] }
}
$recoverySettings.GetEnumerator() | Sort-Object Name | Format-Table Name, Value
Remove-Variable recoveryRawEnv

$env:AWS_REGION = $recoverySettings['AWS_REGION']
$env:E2E_SOURCE_QUEUE = $recoverySettings['VIDEO_ENCODING_QUEUE_URL']
$env:E2E_SOURCE_BUCKET = $recoverySettings['VIDEO_INPUT_BUCKET']
$env:E2E_OUTPUT_BUCKET = $recoverySettings['VIDEO_OUTPUT_BUCKET']
$env:E2E_MAX_ATTEMPTS = $recoverySettings['WORKER_MAXIMUM_ATTEMPTS']
```

不足キーがある場合は専用workerの起動設定を確認します。特にTMPDIRは`/tmp/video-worker`が必要です。
コンテナ再作成後はIDと設定値を取り直してください。

Terraformの管理済み専用環境から候補値を確認する場合は、その環境のstate/workspaceで
`aws_region`、`video_encoding_queue_url`、`video_input_bucket_name`、`video_output_bucket_name`の
個別outputを参照できます。ただし実workerと一致することを別途確認します。
全stateや全outputのダンプは不要です。現行outputs.tfにDLQ・alarm名の個別outputはありません。

## 3. AWS profileとaccount

```powershell
aws configure list-profiles
$env:AWS_PROFILE = '<専用環境にアクセスするprofile名>'
aws configure get region --profile $env:AWS_PROFILE
$recoveryAccount = aws sts get-caller-identity --profile $env:AWS_PROFILE --region $env:AWS_REGION --query Account --output text
if ($LASTEXITCODE -ne 0 -or $recoveryAccount -notmatch '^\d{12}$') { throw 'AWS account確認に失敗しました' }
$env:E2E_AWS_ACCOUNT_ID = $recoveryAccount.Trim()
```

このIDを、利用予定の専用環境のaccount IDと照合してください。
STSで取得できたというだけでdisposableと判定しません。
profileの既定regionとworkerのregionが異なる場合も、各コマンドにはworkerのregionを明示します。
E2E用認証はworkerの認証と同一である必要はありませんが、同じaccountの対象資源を操作できる必要があります。

## 4. DLQ、redrive、attempt数

`RedrivePolicy`には実際のDLQ ARNとmaxReceiveCountが入っています。
[ AWS公式: GetQueueAttributes ](https://docs.aws.amazon.com/cli/latest/reference/sqs/get-queue-attributes.html)

```powershell
$recoveryQueueResponse = aws sqs get-queue-attributes --queue-url $env:E2E_SOURCE_QUEUE --attribute-names QueueArn RedrivePolicy VisibilityTimeout --region $env:AWS_REGION --output json
if ($LASTEXITCODE -ne 0) { throw 'source queueの確認に失敗しました' }
$recoveryQueueAttributes = ($recoveryQueueResponse | ConvertFrom-Json).Attributes
$recoveryRedrive = $recoveryQueueAttributes.RedrivePolicy | ConvertFrom-Json
$recoveryRedrive | Select-Object deadLetterTargetArn, maxReceiveCount

$recoveryDlqArn = [string]$recoveryRedrive.deadLetterTargetArn
if (-not $recoveryDlqArn.StartsWith("arn:aws:sqs:$($env:AWS_REGION):$($env:E2E_AWS_ACCOUNT_ID):")) { throw 'DLQのaccount/regionが一致しません' }
$recoveryDlqName = ($recoveryDlqArn -split ':')[-1]
$recoveryDlqUrl = aws sqs get-queue-url --queue-name $recoveryDlqName --region $env:AWS_REGION --query QueueUrl --output text
if ($LASTEXITCODE -ne 0) { throw 'DLQのURLを取得できませんでした' }
$recoveryObservedDlqArn = aws sqs get-queue-attributes --queue-url $recoveryDlqUrl --attribute-names QueueArn --region $env:AWS_REGION --query Attributes.QueueArn --output text
if ($LASTEXITCODE -ne 0 -or $recoveryObservedDlqArn -ne $recoveryDlqArn) { throw 'DLQの実ARNが一致しません' }
if ([int]$recoveryRedrive.maxReceiveCount -ne [int]$env:E2E_MAX_ATTEMPTS) { throw 'workerとqueueのattempt設定が不一致です' }
if ([int]$env:E2E_MAX_ATTEMPTS -lt 2 -or [int]$env:E2E_MAX_ATTEMPTS -gt 10) { throw 'crash試験のattempt数は2～10が必要です' }

$env:E2E_DLQ = $recoveryDlqUrl.Trim()
$env:E2E_SOURCE_DLQ = $env:E2E_DLQ
$env:E2E_SOURCE_DLQ_RELATIONSHIP = 'verified'
```

不一致があった場合、E2Eの値だけ合わせて通過させないでください。専用環境のworker/queue構成を確認します。

## 5. alarm名

対象regionのSQS metric alarmsを、metricとQueueNameで確認します。
[ AWS公式: DescribeAlarms ](https://docs.aws.amazon.com/cli/latest/reference/cloudwatch/describe-alarms.html)

```powershell
aws cloudwatch describe-alarms --region $env:AWS_REGION --query "MetricAlarms[?Namespace=='AWS/SQS'].{Name:AlarmName,Metric:MetricName,Dimensions:Dimensions}" --output json
```

以下に一致する、異なる名前の3件を選びます。

| 対象QueueName | MetricName |
|---|---|
| source queue名（URL末尾） | `ApproximateAgeOfOldestMessage` |
| source queue名（URL末尾） | `ApproximateNumberOfMessagesVisible` |
| DLQ名 | `ApproximateNumberOfMessagesVisible` |

Dimensionは`QueueName`の1つだけ、Namespaceは`AWS/SQS`が必要です。
metric mathやcomposite alarmはこのadapterの対象ではありません。順番は問いません。

```powershell
$env:E2E_ALARM_IDENTIFIERS = '<確認したsource-age名>,<確認したsource-count名>,<確認したDLQ-count名>'
```

該当alarmがない場合はPhase 2の専用環境準備が未完了です。架空の名前は設定しません。

## 6. frontend/API URL

専用環境のコンテナを指定して、ホスト公開ポートを確認します。

```powershell
docker --host $env:E2E_DOCKER_HOST container port '<専用frontendの名前またはID>'
docker --host $env:E2E_DOCKER_HOST container port '<専用APIの名前またはID>'
```

例: APIが`8080/tcp -> 0.0.0.0:8080`なら同じ端末からは`http://127.0.0.1:8080`。
通常のComposeの既定値はAPIが8080、frontendが5173です。
手動手順に書いた8000は一例であり、実際の公開ポートを優先してください。

```powershell
$env:E2E_API_URL = 'http://127.0.0.1:<実際のAPI公開ポート>'
$env:E2E_FRONTEND_URL = 'http://127.0.0.1:<実際のfrontend公開ポート>'
Invoke-RestMethod "$($env:E2E_API_URL)/api/v1/health"
(Invoke-WebRequest $env:E2E_FRONTEND_URL).StatusCode
```

APIは`status: ok`、frontendは成功HTTP応答を確認します。
URLにはユーザー名・パスワード・query・fragmentを含めません。
今回のrecoveryシナリオ自体はAPI/UIを呼びませんが、共通設定では両URLが必須です。

## 7. fixture、証跡ディレクトリ、確認フラグ

```powershell
$env:E2E_RECOVERY_FIXTURE = (Resolve-Path -LiteralPath 'C:\e2e\fixtures\long.mp4').Path
Get-Item -LiteralPath $env:E2E_RECOVERY_FIXTURE | Select-Object FullName, Length
ffprobe -v error -show_entries format=duration,size -of json $env:E2E_RECOVERY_FIXTURE
$env:E2E_EVIDENCE_DIR = 'C:\e2e\evidence'
```

fixtureは1 GiB以下。再生時間だけでなく、workerでの実encodeがheartbeat間隔の2倍を超える必要があります。
証跡ディレクトリは既存でも未作成でも構いませんが、実行ユーザーが作成・書込できる場所を選びます。
共有出力先ではなく専用の絶対パスを指定し、`..`を含めません。

以下は検出値ではなく、実行者の確認・同意を表す固定値です。
対象資源が専用disposableで、他のconsumer・試験と同時使用しないことを確認した後に設定します。

```powershell
$env:E2E_ENVIRONMENT = 'disposable'
$env:E2E_RELIABILITY_DISPOSABLE = 'true'
$env:E2E_RECOVERY_EXCLUSIVE = 'true'
```

## 8. timeoutの決め方

全項目とも**ミリ秒の整数、1～900000**です。
workerの設定とqueue VisibilityTimeoutは**秒**なので、1000倍して比較します。

| 変数 | 決め方 |
|---|---|
| `E2E_LEASE_TIMEOUT_MS` | `WORKER_LEASE_DURATION_SECONDS × 1000`以上。観測の余裕を追加 |
| `E2E_VISIBILITY_TIMEOUT_MS` | `max(queue VisibilityTimeout, WORKER_VISIBILITY_EXTENSION_SECONDS) × 1000`以上 |
| `E2E_DLQ_TIMEOUT_MS` | `WORKER_RETRY_DELAY_SECONDS × 1000`以上。今回の2シナリオでDLQを直接pollする値ではない |
| `E2E_PROCESSING_TIMEOUT_MS` | 実encode・公開・ack観測までを待てる値。各処理段階や失敗時のcleanup待ちにも使用。初回候補は900000 |
| `E2E_NAVIGATION_TIMEOUT_MS` | 共通設定として必須。今回browser操作はしない。候補30000 |
| `E2E_UPLOAD_TIMEOUT_MS` | 共通設定として必須。候補120000。今回のAWS CLI PUTの10秒制限を延長する値ではない |
| `E2E_PLAYBACK_TIMEOUT_MS` | 共通設定として必須。今回playback操作はしない。候補120000 |

下限を確認する例:

```powershell
[pscustomobject]@{
    LeaseMinimumMs = 1000 * [int]$recoverySettings['WORKER_LEASE_DURATION_SECONDS']
    VisibilityMinimumMs = 1000 * [Math]::Max([int]$recoveryQueueAttributes.VisibilityTimeout, [int]$recoverySettings['WORKER_VISIBILITY_EXTENSION_SECONDS'])
    DlqMinimumMs = 1000 * [int]$recoverySettings['WORKER_RETRY_DELAY_SECONDS']
    HeartbeatMs = 1000 * [int]$recoverySettings['WORKER_HEARTBEAT_INTERVAL_SECONDS']
}
```

必要下限が900000を超える場合、E2E側だけで対応できません。専用環境のタイミング設定を見直します。
また実worker設定は`2 × heartbeat <= min(visibility extension, lease duration)`が必要です。
heartbeat用のE2E環境変数はありません。実workerから読み取ります。

## 9. 最終照合

確認した値を設定した同じ端末で実行します。

```powershell
python app/scripts/run_reliability_e2e.py --check
python app/scripts/run_reliability_e2e.py --live-preflight
```

`--check`はローカルのツール・設定形式だけの確認です。
`--live-preflight`でaccount、region、queue/DLQ関係、worker設定、Docker/DB、alarmを照合し、
終了コード0と`status: verified`を確認します。fixture・restart policy・排他宣言等の
シナリオ固有条件はシナリオ開始時に追加検査されます。
この確認はworker停止やencodeを行いません。
