# 環境変数設定コマンドの生成

`app/scripts/generate_reliability_env.mjs` は、既存のAWS/Docker設定を読み、PowerShellの
`$env:NAME = 'value'` コマンドを出力する。共通事前確認・シナリオの実装は変更しない。
生成処理はリソース作成、Terraform、SQL、コンテナ制御、E2E実行を行わない。

## 使い方

専用コンテナの準備から行う場合は [Spec43用Compose override](compose-e2e.md) を参照。

リポジトリルートから、実際の専用コンテナ名を指定する。
Node.js、Docker CLI、AWS CLIが必要。AWSから自動取得するため、生成時点で既存のAWS CLIログインが必要。
認証情報そのものを引数に渡さない。

```powershell
# まずコマンドを画面で確認する。コンテナ名とアカウントIDを置き換える
node app/scripts/generate_reliability_env.mjs --worker video-worker --database postgres --account 123456789012

# 必要な値を指定し、専用・破棄可能環境であることを確認済みなら --exclusive を付ける
node app/scripts/generate_reliability_env.mjs --worker video-worker --database postgres --account 123456789012 --profile e2e --fixture C:/e2e/long.mp4 --exclusive --output ./reliability-env.local.ps1

# 生成ファイルを確認してから、現在のPowerShellセッションに読み込む
Get-Content ./reliability-env.local.ps1
. ./reliability-env.local.ps1

python app/scripts/run_reliability_e2e.py --check
python app/scripts/run_reliability_e2e.py --live-preflight
python app/scripts/run_reliability_e2e.py --scenario duplicate-delivery
```

`--output` を省略すると設定コマンドだけを標準出力に出す。ファイル指定時は親ディレクトリが
存在する必要があり、既存ファイルを上書きしない。`.ps1` はWindows PowerShellでも読めるUTF-8 BOM付き。
生成ファイルは環境固有のローカル設定として扱い、リポジトリにはコミットしない。

## 自動取得と手動設定

| 項目 | 値の取得方法 |
| --- | --- |
| Worker/DBの観測ID・制御ID | 指定したコンテナ名を完全な64文字IDに解決 |
| 所有範囲 | 起動済みコンテナの既存disposable・role・scopeラベルを確認して取得 |
| リージョン、sourceキュー、input/outputバケット | Workerの非機密の実効環境変数のみを選択 |
| AWSアカウント | STSから取得。`--account` 指定時は期待値とも照合。指定を推奨 |
| DLQ、source→DLQ関係、最大試行回数 | sourceのRedrivePolicy、DLQのURL/ARNから取得。Workerとのattempts整合も確認 |
| アラーム3件 | CloudWatchのメトリクスとQueueNameで自動選択。複数候補なら `--alarms age,backlog,dead` で指定 |
| visibility/lease/DLQ待機予算 | 実設定の秒数をミリ秒へ変換し30秒の余裕を追加。上限900000 msを超える実設定はエラー |
| その他の待機予算 | navigation 30000、upload 120000、processing 300000、playback 120000 ms。生成後に負荷に合わせて調整 |
| Frontend/API URL | 既定値 `http://127.0.0.1:5173` / `http://127.0.0.1:8000`。自動検出ではない。異なる場合は `--frontend-url` / `--api-url` |
| Docker接続先 | `--docker-host` → `DOCKER_HOST` → OS別ローカルソケットの順。Docker contextの推測はしない |
| 証跡保存先 | `--evidence-dir` またはカレントディレクトリの `artifacts/reliability-e2e` を絶対パス化 |
| MP4 | `--fixture` を絶対パス化し、拡張子・サイズ・存在を確認。省略時は空欄で出力するため手動設定 |
| disposable/exclusive宣言 | `--exclusive` がある場合だけ両方を `true` に設定。省略時は空欄で出力し、確認後に手動設定 |

`--exclusive` は利用者による宣言であり、ラベルの存在だけで他consumerの不在を証明するものではない。
ラベル不足は生成エラーになる。生成スクリプトがラベルを追加したり共有環境を専用扱いしたりすることはない。

## 秘密情報と確認範囲

AWSアクセスキー・セッションtoken・パスワード・DATABASE_URL・Worker認証情報は出力しない。
既存AWSプロファイルを使う場合、出力するのは `AWS_PROFILE` の名前だけ。
別の実行シェルで認証が必要なら、生成後にそのシェルでAWS CLIログインまたは認証環境変数を手動設定する。
秘密情報を生成した `.ps1` に追記する必要はない。DBの接続情報は既存コンテナに保持する。

設定値は出力用の許可リストに限定し、PowerShellの単一引用符をエスケープする。
外部コマンドの生エラー、inspect全体、認証値はエラー時にも出力しない。
取得は各コマンド最大10秒・全体120秒・出力4 MiBに制限する。アラーム一覧のページ取得はAWS CLIに任せる。
大量のアラームで制限に達する場合は `--alarms` で対象を指定する。

生成は設定補助であり、実環境の事前確認に成功した証拠ではない。
ストレージ専有、ネットワーク、DB healthcheck、実際のS3アクセス、シナリオ固有のfixture・通知条件などは
既存の `--live-preflight` とシナリオの準備処理で確認する。
MP4のエンコード時間に応じた待機予算の調整も引き続き必要。

引数一覧: `node app/scripts/generate_reliability_env.mjs --help`。
テストはfake AWS/Docker応答を使い、通常の `npm --prefix app/frontend run test:e2e:helpers` に含まれる。
