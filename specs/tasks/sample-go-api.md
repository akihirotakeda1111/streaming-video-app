---
schema_version: 1
id: sample-go-api
title: Sample Go Video API
status: PENDING
base_branch: sample
target_branch: feature/sample-go-api

allowed_paths:
  - app/backend/api/**

forbidden_paths:
  - specs/**
  - .agent/**
  - agent/**
  - .github/**

repair_attempt_limit: 3
review_attempt_limit: 3
---

# Objective

Go標準ライブラリだけを使用して、疎通確認用のhealth endpointと空の動画一覧を返す小さなHTTP APIを実装する。API handlerを単体テスト可能な形で分離し、既存のAPI entrypointから起動できる状態にする。

# Non-Goals

- 動画のアップロード、再生、エンコード処理は実装しない。
- Database、Queue、Object Storage、AWS SDKには接続しない。
- 認証、認可、永続化、OpenAPI生成は追加しない。
- 外部Go moduleを追加しない。
- Frontend、Rust worker、Terraformは変更しない。

# Forbidden Actions

- `allowed_paths`以外のファイルを編集しない。
- Task Spec、Execution State、Agent runtime、GitHub Workflowを変更しない。
- Git historyを書き換えたり、force-pushや自動mergeを行ったりしない。
- 外部サービスへの通信や破壊的なインフラ操作を行わない。

# Architecture Invariants

- HTTP実装にはGo標準ライブラリの`net/http`と`encoding/json`を使用する。
- Routeとhandlerの構築は、portのlisten処理から分離して単体テスト可能にする。
- API responseは`application/json`を返し、globalなmutable stateを持たない。
- 未実装のDatabase、Queue、Storage packageへ依存しない。
- HTTP serverには無制限なheader readを避けるtimeoutを設定する。

# Tasks

## task-1: Implement sample HTTP handlers

### Requirement

`app/backend/api/internal/httpapi` packageを作成し、`NewHandler() http.Handler`から次のendpointを提供する。

- `GET /healthz`はHTTP 200と`{"status":"ok"}`をJSONで返す。
- `GET /api/v1/videos`はHTTP 200と`{"videos":[]}`をJSONで返す。
- 対象routeへのGET以外のmethodはHTTP 405と適切な`Allow` headerを返す。
- 未知のpathはHTTP 404とJSON error responseを返す。

`httptest`を使ったtable-driven unit testを追加し、status code、Content-Type、response body、method制約を検証する。

### Acceptance Criteria

- `NewHandler()`がlisten処理なしでテスト可能な`http.Handler`を返す。
- `/healthz`と`/api/v1/videos`の正常系responseが要件どおりである。
- method不一致と未知のpathがそれぞれ405、404を返す。
- handler testが外部networkや外部serviceを必要としない。
- 新しい外部dependencyが`go.mod`へ追加されない。

### Validation

```text
go -C app/backend/api test ./internal/httpapi/...
```

## task-2: Wire the API server entrypoint

depends_on: task-1

### Requirement

`app/backend/api/cmd/api/main.go`を更新し、task-1のhandlerを使用するHTTP serverを起動する。listen addressは環境変数`API_ADDR`から取得し、未指定時は`:8080`を使用する。`http.Server`へheader read timeoutを設定し、起動失敗を標準的なloggingで報告する。

### Acceptance Criteria

- entrypointが`httpapi.NewHandler()`をHTTP serverへ接続する。
- `API_ADDR`未指定時のlisten addressが`:8080`である。
- HTTP serverに正の`ReadHeaderTimeout`が設定される。
- server startup errorが無視されない。
- API module全体がbuildおよびtest可能である。

### Validation

```text
go -C app/backend/api test ./...
```

# Final Verification

```text
go -C app/backend/api vet ./...
go -C app/backend/api test ./...
```
