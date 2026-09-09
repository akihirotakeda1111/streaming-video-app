# 手動実行用E2E AWS環境

既存の `../terraform` をローカルモジュールとして再利用する独立したTerraformルート。
通常環境を移行・importせず、新しいE2E専用リソースとこのディレクトリ専用のlocal stateを作る。
CIからTerraformを実行する設定は追加しない。

作成対象はinput/output S3、Standard sourceキューとDLQ、S3通知、既存の3アラーム、
API/Worker用IAMユーザー・ポリシーと、ホスト側E2E runner用ポリシー。
アクセスキー、DB、コンテナ、ネットワーク、計算リソースは作成しない。
既存構成と同じくoutputのHLSパスは公開読み取りを使用する。公開アクセスを禁止したアカウントでは
そのポリシーを適用できないため、既存の環境方針を確認する。実データは投入しない。
両バケットは新規・非versionedで、`force_destroy` は有効にしない。

## 手動で準備

Terraform >=1.6とAWS認証が必要。mockテストはTerraform >=1.7。
認証は環境変数または既存AWSプロファイルで設定し、tfvarsに秘密情報を書かない。

```powershell
Copy-Item app/infra/terraform-e2e/terraform.tfvars.example app/infra/terraform-e2e/terraform.tfvars
# terraform.tfvars の aws_account_id を想定アカウントIDに変更する
# 必要なら aws_region / instance を変更する
$env:AWS_PROFILE = 'e2e-provisioner'
terraform -chdir=app/infra/terraform-e2e init
terraform -chdir=app/infra/terraform-e2e validate
terraform -chdir=app/infra/terraform-e2e plan -out=e2e.tfplan
# planが新規E2Eリソースだけを対象にしていることを確認して実行
terraform -chdir=app/infra/terraform-e2e apply e2e.tfplan
```

両方のAWS providerにアカウントallowlistを設定するため、認証先が `aws_account_id` と違う場合は停止する。
名前には必ず `streaming-video-e2e-<instance>` を含める。バケット名にはアカウント・リージョンも含める。
同じアカウントで複数環境を作る場合は、**別checkout等の独立したstate保存先と異なるinstance**を使う。
既存stateのままinstanceを切り替えると置換planになる。通常環境のstate、workspace、既存バケットを流用しない。
local stateとbackupは適切に保管し、リソースが残っている間は削除しない。チーム共有backendの構築は今回の範囲外。

## Composeへの受け渡し

Terraform outputは非機密の環境設定マップ。既存モジュールのplaceholder出力ではなく、作成されたキューURLを使用する。

```powershell
$runtimeJson = terraform -chdir=app/infra/terraform-e2e output -json compose_environment
if ($LASTEXITCODE -ne 0) { throw 'Terraform output failed' }
$runtime = $runtimeJson | ConvertFrom-Json
foreach ($entry in $runtime.PSObject.Properties) {
  [Environment]::SetEnvironmentVariable($entry.Name, [string]$entry.Value, 'Process')
}
terraform -chdir=app/infra/terraform-e2e output worker_identity
terraform -chdir=app/infra/terraform-e2e output runner_policy_arn
```

Workerの認証は出力されたWorker IAMユーザー用に別途手動で用意し、`WORKER_AWS_ACCESS_KEY_ID`、
`WORKER_AWS_SECRET_ACCESS_KEY`、必要なら `WORKER_AWS_SESSION_TOKEN` に設定する。
runner policyは既存のホスト側テスト実行principalへ手動で付与する。Terraform適用権限は含まない。
runnerには専用バケット内のrunオブジェクト操作、sourceへのSendMessage、読み取り確認権限のみを与え、
ReceiveMessage、DeleteMessage、PurgeQueue、DLQ replay権限は付与しない。
CloudWatch DescribeAlarmsは設定生成時の一覧取得に必要なため読み取りの `Resource=*` を使用する。

その後は [専用Compose起動手順](../../frontend/e2e/reliability/compose-e2e.md) と
[環境変数生成手順](../../frontend/e2e/reliability/environment-generator.md) に従う。
ホスト側AWS_PROFILEはrunner用に切り替え、provisioner認証をコンテナに渡さない。
Spec43の共通事前確認は変更しない。Terraform apply成功も実環境E2Eの成功証跡にはならない。

## 検証と終了

```powershell
terraform -chdir=app/infra/terraform-e2e fmt -check
terraform -chdir=app/infra/terraform-e2e init -backend=false
terraform -chdir=app/infra/terraform-e2e validate
terraform -chdir=app/infra/terraform-e2e test
```

テストはmock providerでplanのみを行い、AWSには接続しない。initはprovider取得のためネットワークを使う。
終了時はまず専用Workerを停止し、E2E証跡と保持されたデータを確認する。
残ったオブジェクトは当該専用バケットであることを確認して手動処理する。自動purgeや強制バケット削除はしない。
手動付与したrunner policyのattachmentと、手動作成したIAM認証情報も管理者が処理する。

```powershell
$env:AWS_PROFILE = 'e2e-provisioner'
terraform -chdir=app/infra/terraform-e2e plan -destroy -out=destroy.tfplan
# 専用リソースだけであることをレビューした後
terraform -chdir=app/infra/terraform-e2e apply destroy.tfplan
```

生成されるstate・plan・実値tfvarsはgitignore対象。providerのlockファイルはコミットして再利用する。
