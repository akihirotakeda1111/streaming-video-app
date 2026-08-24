# ADR-001: 動画配信MVPのアーキテクチャとPhase構成

## Context

動画配信MVPを、次の3段階で構築する。

| Phase | テーマ | 概要 |
|---|---|---|
| Phase 1 | Functional | Upload → Encode → HLS → Playbackの正常系をE2Eで成立させる |
| Phase 2 | Reliability | パイプラインが壊れることを前提に、信頼性、監視、IaCを追加する |
| Phase 3 | Scalability / Performance | 大量動画、高負荷、並列エンコードを想定してCompute層を高度化する |

Phase 1では、単一MP4をそのままブラウザで再生する構成ではなく、HLS manifestとmedia segmentsを生成し、フロントエンドから再生できる構成が必要である。

また、APIサーバー内でFFmpegを同期実行せず、API、ストレージ、キュー、エンコードWorkerの責務を分離する。

## Decision

### Phase 1: 正常系E2E

以下の非同期動画配信パイプラインを構築する。

```text
Client
  │
  │ POST /videos
  ▼
Go API
  │
  │ Presigned URL
  ▼
Client
  │
  │ Upload
  ▼
S3 Input
  │
  │ ObjectCreated
  ▼
SQS
  │
  ▼
Rust Worker
  │
  │ FFmpeg
  ▼
S3 Output
  │
  ▼
Frontend / video.js
```

Go APIは動画ジョブを作成し、S3へ直接アップロードするためのPresigned URLを発行する。アップロード完了後のキュー投入は、`S3 ObjectCreated → SQS`を利用する。

Rust WorkerはSQSからジョブを取得し、FFmpegでHLS manifest（`.m3u8`）とmedia segments（`.ts`または`.m4s`）を生成してS3 Outputへ配置する。フロントエンドはvideo.jsなどを利用してHLSを再生する。

ジョブには最低限、次の状態を持たせる。

```text
UPLOADING
QUEUED
PROCESSING
COMPLETED
FAILED
```

Phase 1の目標は、正常系の非同期動画配信パイプラインをE2Eで完成させることである。

### Phase 2: 信頼性とIaC

Phase 1の正常系は維持し、その周囲に信頼性を追加する。

対象とする主な事象は次のとおり。

- SQSメッセージの重複配送
- 複数Workerによる同一ジョブの受信
- Workerの処理途中での停止
- FFmpegの失敗
- 処理時間の超過
- S3への一部アップロードだけが成功した状態
- 繰り返し失敗するジョブ

主要な実装項目は次のとおり。

- 冪等性
- DBによるAtomic State Transition
- Lease
- Visibility Timeout heartbeat
- Retry
- DLQ
- CloudWatchによる監視
- TerraformによるIaC
- CloudFront + OAC
- Private S3

DBには、次のような情報を保持する。

```text
status
attempt
worker_id
lease_expires_at
error_code
```

Phase 2の目標は、パイプラインで障害や重複実行が発生しても、安全に復旧できる構成にすることである。

**個人開発MVPでは、Phase 2を主要な到達点とする。**

### Phase 3: スケーラビリティと性能高度化

Phase 2までの次の境界を維持し、主にCompute層を交換・拡張する。

```text
API
 ↓
Queue
 ↓
Compute
 ↓
Storage
```

主要な実装候補は次のとおり。

- Step Functions
- ECS/FargateまたはAWS Batchによる分散処理
- Distributed Map
- 動画、rendition、segment単位の並列処理
- Auto Scaling
- ABR
- 必要に応じたFFmpeg C APIによる最適化

長時間処理では、Lambdaを主軸にするのではなく、Step FunctionsとECS/FargateまたはAWS Batchを中心に検討する。

Phase 3の目標は、大量動画、高負荷、並列エンコードを想定し、Compute層のスケーラビリティと性能を高度化することである。

## Consequences

### Positive

- APIとエンコード処理の責務が分離される
- アップロードからHLS再生までの処理を非同期パイプラインとして構成できる
- Phase 2で重複配送、Worker停止、処理失敗などを扱える
- Phase 2までの境界を維持したまま、Phase 3でCompute層を拡張できる

### Trade-offs

- Phase 1だけでは正常系の完成に留まり、異常系への対応はPhase 2で追加する必要がある
- Phase 2では、冪等性、Lease、Retry、DLQ、監視、IaCの実装が必要になる
- Phase 3では、分散処理と性能最適化によって構成がさらに複雑になる

## Completion criteria

### Phase 1

- S3への直接アップロードができる
- S3イベントからSQSへジョブが送信される
- Rust WorkerがFFmpegでHLSを生成できる
- HLS manifestとmedia segmentsがS3 Outputへ配置される
- フロントエンドからHLSを再生できる
- 最低限のジョブ状態を確認できる

### Phase 2

- 同じメッセージが複数回来ても安全に処理できる
- 同じジョブを複数Workerが受信しても安全に処理できる
- Workerが途中で停止しても処理を復旧できる
- FFmpegの失敗と処理時間超過を扱える
- 一部だけ成功したS3アップロードを扱える
- 繰り返し失敗するジョブをDLQへ送信できる
- CloudWatchで処理を監視できる
- Terraformでインフラを管理できる
- CloudFront + OACとPrivate S3で配信できる

### Phase 3

- Compute層を分散・並列処理へ拡張できる
- 負荷に応じてスケールできる
- ABRに対応できる
- 必要に応じた性能最適化を実施できる

## Outcome

ロードマップ上の位置づけを次のように定める。

| Phase | 到達点 |
|---|---|
| Phase 1 | 正常系の非同期動画配信パイプラインを完成させる |
| **Phase 2** | **信頼性とIaCを備えた個人開発MVPの主要到達点** |
| Phase 3 | スケーラビリティと性能を高度化する |
