# Spec43用Compose override

`app/compose.e2e.yaml` を既存の `app/compose.yaml` に重ねる。
Worker、PostgreSQL、migrationの既存定義を使い、専用ラベル・DBコンテナ名・DB volume名だけを追加/変更する。
DBのホスト公開ポートは削除する。Worker/DB間は専用プロジェクトのDockerネットワークで接続する。
通常のComposeファイルと共通事前確認は変更しない。

## 準備

専用AWSリソースが未作成の場合は [E2E用Terraform](../../../infra/terraform-e2e/README.md) で手動準備できる。

- Docker Composeの `!reset` タグに対応したバージョンを使用する。構成確認はCompose v2.35.1で実施。
- `streaming-video-e2e` をこのE2Eだけのプロジェクト名として使用する。
- 既存のE2E専用AWSキュー・バケット、Worker認証情報を手動設定する。
  通常環境のWorkerと同じキューを使うと、Dockerを分離しても競合する。
- Compose入力は既存と同じ `AWS_REGION`、`VIDEO_ENCODING_QUEUE_URL`、`VIDEO_INPUT_BUCKET`、
  `VIDEO_OUTPUT_BUCKET`、`WORKER_AWS_ACCESS_KEY_ID`、`WORKER_AWS_SECRET_ACCESS_KEY`、必要なら `WORKER_AWS_SESSION_TOKEN`。
  Workerの認証と、設定生成スクリプトが使うホスト側AWS CLIの認証は別々に準備する。
- `WORKER_MAXIMUM_ATTEMPTS` はsourceのmaxReceiveCountに合わせる。各Worker時間設定も既存の制約に従う。
- DB設定は既存の既定値を使える。変更する場合は `POSTGRES_DB` / `POSTGRES_USER` / `POSTGRES_PASSWORD` と
  `COMPOSE_DATABASE_URL` を揃え、接続先をこのプロジェクトの `postgres:5432` にする。
  開発用 `.env` やシェルに残る別環境の接続先・認証情報をそのまま引き継がない。

## 起動・設定生成・実行

リポジトリルートのPowerShellで実行する。`worker` を明示することでAPI/Frontendは起動せず、
依存するPostgreSQLとmigrationだけが起動する。既存の `start-e2e-compose.sh` は通常のCompose全体を起動するため使わない。

```powershell
# 設定内容そのもの（認証情報を含み得る）は画面に出さず、構文を確認
docker compose -p streaming-video-e2e -f app/compose.yaml -f app/compose.e2e.yaml config --quiet
docker compose -p streaming-video-e2e -f app/compose.yaml -f app/compose.e2e.yaml up --build -d worker
docker compose -p streaming-video-e2e -f app/compose.yaml -f app/compose.e2e.yaml ps

# コンテナ名を手で調べず、対象プロジェクトからIDを取得する
$workerId = docker compose -p streaming-video-e2e -f app/compose.yaml -f app/compose.e2e.yaml ps -q worker
$dbId = docker compose -p streaming-video-e2e -f app/compose.yaml -f app/compose.e2e.yaml ps -q postgres

# アカウント・fixtureを実値に置き換える。--exclusive は専用環境と確認した場合だけ指定
node app/scripts/generate_reliability_env.mjs --worker $workerId --database $dbId --account 123456789012 --fixture C:/e2e/long.mp4 --exclusive --output ./reliability-env.local.ps1
. ./reliability-env.local.ps1
python app/scripts/run_reliability_e2e.py --check
python app/scripts/run_reliability_e2e.py --live-preflight
python app/scripts/run_reliability_e2e.py --scenario duplicate-delivery
```

生成ファイルが既にある場合は別の出力ファイル名を使う。生成値は読み込み前に確認する。
Spec43ではブラウザ/APIを使わないが、現行共通設定がURLを要求するため生成スクリプトの既定値が入る。
これはAPI/Frontendの稼働確認ではない。生成オプションと確認範囲は [設定生成手順](environment-generator.md) を参照。

既定のDBコンテナ名は `streaming-video-e2e-postgres`、volume名は `streaming-video-e2e-postgres-data`。
`-p` を変えると両方とscopeラベルも変わる。起動・ID取得・終了では必ず同じプロジェクト名と2つのファイルを指定する。
E2Eには新しい専用volumeを使い、通常環境の `streaming-video-postgres-data` を移行・流用しない。

## 終了

```powershell
# 専用コンテナとネットワークを終了する。DB volumeは保持
docker compose -p streaming-video-e2e -f app/compose.yaml -f app/compose.e2e.yaml down
```

証跡を確認し、この専用DBのデータも破棄してよい場合だけ同じコマンドに `--volumes` を付ける。
AWS上に保持された失敗時リソースはComposeの終了では削除されない。
シナリオの `cleanup=retained` がある場合は [重複配送手順](duplicate-runbook.md) に従って確認する。

このoverrideはAWS構築、Terraform、IAM変更、通常環境の再作成を行わない。
ラベル付与だけで安全性が証明されるわけではなく、既存の実環境事前確認を引き続き実行する。
