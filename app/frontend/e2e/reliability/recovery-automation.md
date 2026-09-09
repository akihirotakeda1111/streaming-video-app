# Recovery E2E: 専用環境の自動準備（WSL）

`app/scripts/reliability_environment.py` は通常のCompose/Terraformから分離した環境を作成します。
対象テストは `long-heartbeat` → `crash-recovery` の2件です。CIからは呼び出しません。
API/frontendも起動しますが、Phase 1のブラウザ回帰試験はこのコマンドの対象外です。

## 自動化の範囲

- ランダムな専用名を生成し、S3 input/output、SQS source/DLQ、直接S3通知、3監視アラームを作成。
- 専用PostgreSQL volume、DB、migration、観測ログを含むworker、API/frontendを作成。
- Dockerの所有ラベル、restart=no、worker時間設定、full container IDを自動設定。
- 空いているループバックポートをDockerに割り当てさせ、接続URLを取得。
- E2E設定生成、既存のlive-preflight、2シナリオの順次実行。
- 明示した専用環境の削除。失敗時の自動削除は行わず、証跡と資源を保持。

設定・Terraform状態・plan・証跡はリポジトリ直下の `.reliability-local/` に保存します。
Git管理対象外です。秘密値はこのスクリプトが生成する設定、tfvars、Composeファイルに書き込みません。
Composeには環境変数の参照だけを保存します（[Dockerの環境変数展開仕様](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/)）。
実行時のDB接続文字列やAWS鍵は既存アプリ仕様に従いコンテナ環境へ渡すため、Docker管理者には参照可能です。
`docker inspect` 全体や展開済み `compose config` をログ・PRへ貼らないでください。

## 1. 前提と手動入力

WSLでDocker DesktopのWSL Integrationを有効にし、このリポジトリへ移動してください。
WSL側の Python 3.10以上、Node/npm（frontend/package.jsonのengines準拠）、FFmpeg、AWS CLI v2、
Terraform 1.6以上2未満、Docker Compose v2が必要です。Windows側のnode_modulesは流用しません。

```bash
command -v python3 node npm ffmpeg aws terraform docker
node -p process.platform  # linux
docker --host unix:///var/run/docker.sock info >/dev/null
npm --prefix app/frontend ci
export PYTHON="$(command -v python3)"
export AWS_PROFILE='使用するプロビジョニング用プロファイル名'
# SSOプロファイルの場合のみ
aws sso login --profile "$AWS_PROFILE"
```

プロビジョニング用の認証はAWS CLI標準のプロファイルまたは環境変数を使います。
AWS資源の作成・読み取り・更新・タグ付け・削除権限が必要です。IAMユーザーや鍵自体は作成しません。
テスト実行側にもS3のread/write/delete、SQS/CloudWatchの構成読み取り権限が必要です。

別途、**同じアカウント内のworker/API用資格情報**を手動入力します。自動的にプロビジョニング用資格情報を転用しません。
worker/API用には専用bucketへのread/write/list、専用queueのreceive/delete/change visibilityなど、
既存アプリの実行に必要な権限を付与してください。AWS_SESSION_TOKENのある一時資格情報も利用できます。
一時資格情報はビルドと両テストの終了まで有効である必要があります。

```bash
read -rsp '専用DBパスワード: ' E2E_DB_PASSWORD; echo
read -rsp 'worker/API AWS access key ID: ' E2E_WORKER_AWS_ACCESS_KEY_ID; echo
read -rsp 'worker/API AWS secret access key: ' E2E_WORKER_AWS_SECRET_ACCESS_KEY; echo
read -rsp 'worker/API AWS session token（不要なら空）: ' E2E_WORKER_AWS_SESSION_TOKEN; echo
export E2E_DB_PASSWORD E2E_WORKER_AWS_ACCESS_KEY_ID
export E2E_WORKER_AWS_SECRET_ACCESS_KEY E2E_WORKER_AWS_SESSION_TOKEN
```

入力値はシェル履歴に残りません。同じシェルで以降を実行してください。
後日再度 `up` する場合は、既存DBと同じパスワードを設定します。

## 2. 初期設定と動画の準備

アカウントIDとリージョンは非秘密情報ですが、意図する対象を明示指定します。
`init` はローカルファイルのみを作成し、AWSには接続しません。

```bash
python3 app/scripts/reliability_environment.py init \
  --account 123456789012 --region ap-northeast-1
python3 app/scripts/reliability_environment.py fixture
```

アカウントIDは実際の値へ置き換えてください。既存MP4を使う場合は `init` に
`--fixture /mnt/c/e2e/fixtures/long.mp4` を付け、`fixture` を省略します。
動画は1GiB以下で、実エンコードが60秒を超える必要があります。
生成する10分・1080p動画でも端末性能によっては条件を満たさず、テストが失敗する場合があります。
`fixture` は平均6Mbps・最大8Mbpsで生成し、生成後に1GiB以下であることを確認します。
既存ファイルは通常上書きしません。旧版で生成した動画が1GiBを超えている場合は、
`python3 app/scripts/reliability_environment.py fixture --replace-fixture` で作り直してください。
生成・サイズ検査が成功してから置き換えるため、失敗時は既存動画を保持します。

動画の長さは `--duration-seconds` で正の整数（秒）を指定できます。省略時は600秒です。
例えば、サイズ超過時に300秒（5分）へ短縮して作り直す場合:

```bash
python3 app/scripts/reliability_environment.py fixture --duration-seconds 300 --replace-fixture
```

指定する長さは動画の再生時間です。短縮後もE2Eの条件である実エンコード60秒超を
満たす必要があります。生成後のサイズ検査は引き続き行います。

## 3. 作成内容を確認して起動

```bash
python3 app/scripts/reliability_environment.py plan
scope=$(python3 -c 'import json; print(json.load(open(".reliability-local/config.json"))["scope"])')
python3 app/scripts/reliability_environment.py up --confirm-scope "$scope"
```

`plan` はAWSアカウントとDocker Engineを照合して作成予定を表示します。
`up --confirm-scope` はその専用環境の作成・AWS利用料金の発生を承認する操作です。
`up` でもplanを取り直し、既存資源の更新・削除を含む計画は拒否します。
通常環境のTerraform状態を使わず、既存資源をimportしません。
S3通知は専用queueのみを参照します（[TerraformのS3通知リソース仕様](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/s3_bucket_notification)）。

ビルド・初回イメージ取得には時間がかかります。外部コマンドのエラーには秘密値が入り得るため、
生の出力は保存・表示せず、失敗したツール名を返します。失敗しても状態ファイルを消さず、
認証期限・権限・Docker稼働・ビルド前提条件を確認して `up` を再実行してください。
`up` 完了時に `.reliability-local/environment.json` へ非秘密のE2E設定が保存されます。
このファイルをシェルへ読み込む操作は不要です。

## 4. 検査と実行

```bash
python3 app/scripts/reliability_environment.py check
python3 app/scripts/reliability_environment.py run
```

`check` はローカル依存と実資源の所有・設定を確認します。
`run` はlong-heartbeatが成功した場合だけcrash-recoveryへ進みます。
秘密値の再入力は `up` 時に必要で、`check` / `run` は端末のAWS認証と起動済みコンテナを使います。
結果は `.reliability-local/evidence/` に保存します。
終了コード0と、各証跡の `status=passed`、cleanup完了、worker復元成功を確認してください。
詳細な合否条件・失敗時の扱いは [recovery-runbook.md](recovery-runbook.md) を参照してください。

同じ専用資源を他のconsumerや通常作業で使用しないでください。
スクリプト同士は `operation.lock` で排他しますが、外部からの利用は防ぎません。
端末強制終了でlockだけ残った場合は、記載PIDの処理とテスト子プロセスが終了していることを確認してから
そのlockファイルのみを手動で削除してください。

## 5. 専用環境の削除

```bash
scope=$(python3 -c 'import json; print(json.load(open(".reliability-local/config.json"))["scope"])')
python3 app/scripts/reliability_environment.py down --confirm-scope "$scope"
unset E2E_DB_PASSWORD E2E_WORKER_AWS_ACCESS_KEY_ID
unset E2E_WORKER_AWS_SECRET_ACCESS_KEY E2E_WORKER_AWS_SESSION_TOKEN
```

この操作は**専用DBデータ、S3内の残存データ、queue内の残存メッセージを含めて破棄**します。
失敗原因を調べる場合は証跡・状態を確認してから実行してください。
コンテナの所有ラベルとvolumeの共有有無を確認し、記録したDocker Engineだけを操作します。
AWS側は専用Terraform状態の資源だけを削除します。途中で失敗した場合は同じコマンドを再実行できます。
ローカル証跡・Terraform状態・ビルド済みイメージ・依存キャッシュは保持します。
資源が残っている間に `.reliability-local/` を削除・移動しないでください。

## オフライン検証

```bash
python3 -m unittest discover -s app/scripts -p test_reliability_environment.py
```

このテストは外部コマンドをモックし、秘密値の非保存、別アカウント/Engine拒否、共有volumeの保護、
作成・削除の明示指定、テスト失敗時の停止などを確認します。実AWSでの合格を代替するものではありません。
