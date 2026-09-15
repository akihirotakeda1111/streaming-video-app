#!/usr/bin/env python3
"""Validate the shared API, storage, and reliability contract set."""

from __future__ import annotations

import copy
import json
import re
import sys
from pathlib import Path
from typing import Any
from urllib.parse import unquote_plus, urlparse

import yaml
from jsonschema import Draft202012Validator, FormatChecker


JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema"
EXPECTED_STATUSES = ["UPLOADING", "QUEUED", "PROCESSING", "COMPLETED", "FAILED"]
EXPECTED_API_EXAMPLES = {
    "create-video-request.json",
    "create-video-response.json",
    "get-video-response.json",
    "get-video-completed-response.json",
    "get-playback-response.json",
    "playback-not-ready-response.json",
}
EXPECTED_INTERNAL_FIELDS = [
    "worker_id",
    "attempt",
    "lease_expires_at",
    "published_manifest_key",
    "mode",
]
FORBIDDEN_PUBLIC_FIELDS = {
    "worker_id",
    "workerId",
    "attempt",
    "lease_expires_at",
    "leaseExpiresAt",
    "published_manifest_key",
    "publishedManifestKey",
    "mode",
}
CANONICAL_SOURCE_KEY = "videos/{video_id}/jobs/{job_id}/source.mp4"


class ContractError(RuntimeError):
    """Raised when contract files disagree with each other."""


def load_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ContractError(f"cannot load JSON {path}: {exc}") from exc


def load_yaml(path: Path) -> Any:
    try:
        return yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError) as exc:
        raise ContractError(f"cannot load YAML {path}: {exc}") from exc


def load_markdown_contract(path: Path) -> tuple[dict[str, Any], str]:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise ContractError(f"cannot load reliability contract {path}: {exc}") from exc

    match = re.match(r"\A---\s*\n(.*?)\n---\s*(?:\n|\Z)", text, re.DOTALL)
    if match is None:
        raise ContractError("reliability-contract.md must start with YAML metadata")
    try:
        metadata = yaml.safe_load(match.group(1))
    except yaml.YAMLError as exc:
        raise ContractError(f"invalid reliability contract metadata: {exc}") from exc
    if not isinstance(metadata, dict):
        raise ContractError("reliability contract metadata must be an object")
    return metadata, text[match.end() :]


def rewrite_refs(value: Any) -> Any:
    """Turn OpenAPI component refs into refs usable by a JSON Schema validator."""
    if isinstance(value, dict):
        rewritten = {key: rewrite_refs(item) for key, item in value.items()}
        ref = rewritten.get("$ref")
        if isinstance(ref, str):
            if ref.startswith("#/components/schemas/"):
                rewritten["$ref"] = ref.replace("#/components/schemas/", "#/$defs/", 1)
            elif ref == "../domain/job-status.schema.json":
                rewritten["$ref"] = "#/$defs/JobStatus"
        return rewritten
    if isinstance(value, list):
        return [rewrite_refs(item) for item in value]
    return value


def schema_validator(
    media_schema: dict[str, Any],
    definitions: dict[str, Any],
) -> Draft202012Validator:
    root_schema = {
        "$schema": JSON_SCHEMA_DIALECT,
        "$defs": definitions,
        **rewrite_refs(copy.deepcopy(media_schema)),
    }
    Draft202012Validator.check_schema(root_schema)
    return Draft202012Validator(root_schema, format_checker=FormatChecker())


def validate_openapi_examples(
    api: dict[str, Any],
    api_path: Path,
    job_status_schema: dict[str, Any],
) -> tuple[set[Path], dict[str, Draft202012Validator]]:
    if api.get("openapi") != "3.1.0":
        raise ContractError("contracts/openapi/api.yaml must use OpenAPI 3.1.0")

    component_schemas = api.get("components", {}).get("schemas", {})
    if not isinstance(component_schemas, dict):
        raise ContractError("OpenAPI components.schemas is missing")

    definitions = rewrite_refs(copy.deepcopy(component_schemas))
    definitions["JobStatus"] = copy.deepcopy(job_status_schema)
    validators = {
        name: schema_validator({"$ref": f"#/$defs/{name}"}, definitions)
        for name in component_schemas
    }

    referenced_examples: set[Path] = set()

    def validate_content(content: Any, context: str) -> None:
        if not isinstance(content, dict) or "application/json" not in content:
            return
        media = content["application/json"]
        schema = media.get("schema")
        examples = media.get("examples", {})
        if not isinstance(schema, dict) or not isinstance(examples, dict):
            return
        validator = schema_validator(schema, definitions)
        for example_name, example in examples.items():
            if not isinstance(example, dict) or "externalValue" not in example:
                continue
            example_path = (api_path.parent / example["externalValue"]).resolve()
            if not example_path.is_file():
                raise ContractError(f"missing external example {example_path}")
            instance = load_json(example_path)
            errors = sorted(validator.iter_errors(instance), key=lambda error: list(error.path))
            if errors:
                locations = ", ".join(
                    f"{'/'.join(map(str, error.path)) or '<root>'}: {error.message}"
                    for error in errors
                )
                raise ContractError(
                    f"{context} example {example_name} ({example_path.name}) is invalid: "
                    f"{locations}"
                )
            referenced_examples.add(example_path)

    paths = api.get("paths", {})
    for route, path_item in paths.items():
        if not isinstance(path_item, dict):
            continue
        for method, operation in path_item.items():
            if method.lower() not in {"get", "post", "put", "patch", "delete"}:
                continue
            if not isinstance(operation, dict):
                continue
            request_body = operation.get("requestBody", {})
            if isinstance(request_body, dict):
                validate_content(request_body.get("content"), f"{method.upper()} {route} request")
            for status, response in operation.get("responses", {}).items():
                if isinstance(response, dict):
                    validate_content(
                        response.get("content"), f"{method.upper()} {route} response {status}"
                    )

    referenced_names = {path.name for path in referenced_examples}
    missing_references = EXPECTED_API_EXAMPLES - referenced_names
    if missing_references:
        raise ContractError(
            "OpenAPI does not reference required examples: "
            + ", ".join(sorted(missing_references))
        )

    return referenced_examples, validators


def validate_external_references(api: dict[str, Any], api_path: Path) -> None:
    def walk(value: Any) -> None:
        if isinstance(value, dict):
            ref = value.get("$ref")
            if isinstance(ref, str) and not ref.startswith("#"):
                local_ref = ref.split("#", 1)[0]
                if "://" not in local_ref and not (api_path.parent / local_ref).is_file():
                    raise ContractError(f"missing external schema reference: {ref}")
            for item in value.values():
                walk(item)
        elif isinstance(value, list):
            for item in value:
                walk(item)

    walk(api)


def validate_failure_semantics(job_validator: Draft202012Validator) -> None:
    failed = {
        "jobId": "018f47a2-4699-7892-9fc0-fbe46d3bbd67",
        "status": "FAILED",
        "failure": {"code": "ENCODING_FAILED", "message": "FFmpeg exited with code 1."},
    }
    processing = {
        "jobId": "018f47a2-4699-7892-9fc0-fbe46d3bbd67",
        "status": "PROCESSING",
        "failure": None,
    }
    if not job_validator.is_valid(failed) or not job_validator.is_valid(processing):
        raise ContractError("Job schema rejects a valid FAILED or PROCESSING job")
    if job_validator.is_valid({"jobId": failed["jobId"], "status": "FAILED"}):
        raise ContractError("Job schema must require failure when status is FAILED")
    if job_validator.is_valid({**processing, "failure": failed["failure"]}):
        raise ContractError("Job schema must reject failure details for a non-FAILED status")


def validate_storage_example(
    contracts_dir: Path,
    api: dict[str, Any],
    examples_dir: Path,
) -> None:
    storage_path = contracts_dir / "domain" / "storage-conventions.md"
    storage_text = storage_path.read_text(encoding="utf-8")
    normalized_storage = re.sub(r"\s+", " ", storage_text)
    if "Upload segments first and `index.m3u8` last." not in normalized_storage:
        raise ContractError("storage contract must preserve manifest-last publication")
    if (
        "Set the job to `COMPLETED` only after all referenced objects have been "
        "uploaded successfully."
        not in normalized_storage
    ):
        raise ContractError("storage contract must complete only after publication")
    s3_path = contracts_dir / "examples" / "s3" / "object-created.json"
    if "contracts/examples/s3/object-created.json" not in storage_text:
        raise ContractError("storage-conventions.md must reference the S3 example")

    event = load_json(s3_path)
    records = event.get("Records")
    if not isinstance(records, list) or not records:
        raise ContractError("object-created.json must contain at least one Records item")

    key_pattern = api["components"]["schemas"]["StorageObject"]["properties"]["key"][
        "pattern"
    ]
    canonical_uuid = api["components"]["schemas"]["CanonicalUuid"]["pattern"]
    id_capture = canonical_uuid.removeprefix("^").removesuffix("$")
    input_capture = re.compile(
        rf"^videos/(?P<video_id>{id_capture})/jobs/(?P<job_id>{id_capture})/source\.mp4$"
    )

    for index, record in enumerate(records):
        if record.get("eventSource") != "aws:s3":
            raise ContractError(f"S3 record {index} has an invalid eventSource")
        if not str(record.get("eventName", "")).startswith("ObjectCreated:"):
            raise ContractError(f"S3 record {index} is not an ObjectCreated event")
        try:
            bucket = record["s3"]["bucket"]["name"]
            decoded_key = unquote_plus(record["s3"]["object"]["key"])
        except (KeyError, TypeError) as exc:
            raise ContractError(f"S3 record {index} is missing bucket or object key") from exc
        if re.fullmatch(key_pattern, decoded_key) is None:
            raise ContractError(f"S3 record {index} key violates StorageObject.pattern")
        match = input_capture.fullmatch(decoded_key)
        if match is None:
            raise ContractError(f"S3 record {index} key cannot be parsed into canonical IDs")

    create_response = load_json(examples_dir / "create-video-response.json")
    status_response = load_json(examples_dir / "get-video-response.json")
    completed_response = load_json(examples_dir / "get-video-completed-response.json")
    playback_response = load_json(examples_dir / "get-playback-response.json")
    upload_object = create_response["upload"]["object"]
    first_record = records[0]
    event_bucket = first_record["s3"]["bucket"]["name"]
    event_key = unquote_plus(first_record["s3"]["object"]["key"])
    ids = input_capture.fullmatch(event_key)
    if ids is None:
        raise ContractError("canonical S3 example key cannot be parsed")

    if upload_object != {"bucket": event_bucket, "key": event_key}:
        raise ContractError("create response upload object and S3 event do not match")

    video_id = create_response["videoId"]
    job_id = create_response["job"]["jobId"]
    if ids.groupdict() != {"video_id": video_id, "job_id": job_id}:
        raise ContractError("video/job IDs do not match the canonical S3 key")

    for name, example in {
        "get-video-response.json": status_response,
        "get-video-completed-response.json": completed_response,
    }.items():
        if example["videoId"] != video_id or example["job"]["jobId"] != job_id:
            raise ContractError(f"{name} uses different video/job IDs")

    if completed_response["job"]["status"] != "COMPLETED":
        raise ContractError("completed video example must use COMPLETED status")
    if playback_response["videoId"] != video_id or playback_response["jobId"] != job_id:
        raise ContractError("playback example uses different video/job IDs")
    expected_manifest = f"videos/{video_id}/jobs/{job_id}/hls/index.m3u8"
    actual_manifest = urlparse(playback_response["manifestUrl"]).path.lstrip("/")
    if actual_manifest != expected_manifest:
        raise ContractError("playback manifest URL violates the HLS output key convention")


def canonical_source_key_pattern(api: dict[str, Any]) -> str:
    canonical_uuid = api["components"]["schemas"]["CanonicalUuid"]["pattern"]
    id_capture = canonical_uuid.removeprefix("^").removesuffix("$")
    return rf"^videos/{id_capture}/jobs/{id_capture}/source\.mp4$"


def validate_reliability_contract(contracts_dir: Path, api: dict[str, Any]) -> None:
    reliability_path = contracts_dir / "domain" / "reliability-conventions.md"
    metadata, body = load_markdown_contract(reliability_path)

    if metadata.get("contract_version") != 1:
        raise ContractError("reliability contract must use contract_version 1")
    if metadata.get("contract_id") != "phase2-reliability":
        raise ContractError("reliability contract has an unexpected contract_id")

    expected_references = {
        "status_schema": contracts_dir / "domain" / "job-status.schema.json",
        "storage_contract": contracts_dir / "domain" / "storage-conventions.md",
        "s3_event_fixture": contracts_dir / "examples" / "s3" / "object-created.json",
    }
    for field, expected_path in expected_references.items():
        reference = metadata.get(field)
        if not isinstance(reference, str):
            raise ContractError(f"reliability contract is missing {field}")
        actual_path = (reliability_path.parent / reference).resolve()
        if actual_path != expected_path.resolve() or not actual_path.is_file():
            raise ContractError(f"reliability contract {field} must reference {expected_path.name}")

    if metadata.get("internal_fields") != EXPECTED_INTERNAL_FIELDS:
        raise ContractError("reliability contract must define lease fields, manifest pointer, and mode")
    if metadata.get("public_api_exposes_internal_fields") is not False:
        raise ContractError("reliability fields must remain internal")

    publication = metadata.get("publication")
    if publication != {
        "manifest_name": "index.m3u8",
        "segments_before_manifest": True,
        "completed_after_manifest": True,
    }:
        raise ContractError("reliability publication metadata contradicts manifest-last ordering")

    public_property_names: set[str] = set()

    def collect_property_names(value: Any) -> None:
        if isinstance(value, dict):
            properties = value.get("properties")
            if isinstance(properties, dict):
                public_property_names.update(properties)
            for item in value.values():
                collect_property_names(item)
        elif isinstance(value, list):
            for item in value:
                collect_property_names(item)

    collect_property_names(api)
    exposed_fields = FORBIDDEN_PUBLIC_FIELDS & public_property_names
    if exposed_fields:
        raise ContractError(
            "OpenAPI exposes internal reliability fields: "
            + ", ".join(sorted(exposed_fields))
        )

    key_pattern = api["components"]["schemas"]["StorageObject"]["properties"]["key"]["pattern"]
    expected_source_pattern = canonical_source_key_pattern(api)
    if key_pattern != expected_source_pattern:
        raise ContractError(
            "StorageObject.key.pattern must equal the canonical source object key "
            f"{CANONICAL_SOURCE_KEY}"
        )
    if (
        "multi-record notification is acknowledged only when every record is durably"
        not in body
    ):
        raise ContractError(
            "reliability contract must aggregate SQS acknowledgement across S3 Records"
        )


def validate_orchestration_payload(
    kind: str,
    payload: dict[str, Any],
    validator: Draft202012Validator,
    parent: dict[str, Any] | None = None,
    child: dict[str, Any] | None = None,
) -> None:
    """Check schema plus semantic equalities also required of runtime consumers."""
    errors = sorted(validator.iter_errors(payload), key=lambda error: str(list(error.path)))
    if errors:
        raise ContractError(f"{kind} orchestration payload is invalid: {errors[0].message}")
    identity = ("video_id", "job_id", "attempt", "execution_id", "source_key")
    source = f"videos/{payload['video_id']}/jobs/{payload['job_id']}/source.mp4"
    execution = f"job-{payload['job_id']}-a{payload['attempt']}"
    prefix = (
        f"videos/{payload['video_id']}/jobs/{payload['job_id']}/hls/attempts/"
        f"{payload['attempt']}/{payload['execution_id']}"
    )
    if payload["source_key"] != source or payload["execution_id"] != execution:
        raise ContractError(f"{kind} source/execution must match declared identity")
    if kind != "parent":
        prefix += f"/{payload['rendition']}"
        if parent is None or any(payload[field] != parent[field] for field in identity):
            raise ContractError(f"{kind} identity must match parent")
        if payload["rendition"] not in parent["renditions"]:
            raise ContractError(f"{kind} rendition must be requested by parent")
    if payload["output_prefix"] != prefix:
        raise ContractError(f"{kind} output prefix must match declared identity")
    if kind == "result":
        if child is None or any(payload[field] != child[field] for field in (*identity, "rendition", "output_prefix")):
            raise ContractError("result must match assigned child")
        if payload["media_playlist"]["key"] != f"{prefix}/index.m3u8":
            raise ContractError("result media playlist must be in its assigned prefix")
        for index, segment in enumerate(payload["segments"]):
            if segment["key"] != f"{prefix}/segment-{index:05d}.ts":
                raise ContractError("result segments must be contiguous, ordered, and in their assigned prefix")


def validate_orchestration_rejections(
    schemas: dict[str, Draft202012Validator],
    parent: dict[str, Any],
    child: dict[str, Any],
    result: dict[str, Any],
) -> None:
    """Protect identity isolation and result boundaries with small in-memory probes."""
    fixtures = {"parent": parent, "child": child, "result": result}
    other_id = "00000000-0000-0000-0000-000000000000"
    probes: list[tuple[str, dict]] = []
    for kind, original in fixtures.items():
        for field, value in (
            ("video_id", other_id), ("job_id", other_id), ("attempt", 2),
            ("execution_id", "wrong-execution"),
            ("source_key", original["source_key"].replace(original["job_id"], other_id)),
            ("output_prefix", original["output_prefix"].replace("/attempts/1/", "/attempts/2/")),
            ("output_prefix", original["output_prefix"].replace(original["job_id"], other_id)),
        ):
            probes.append((kind, {**original, field: value}))
    probes.append(("child", {**child, "output_prefix": child["output_prefix"].rsplit("/", 1)[0] + "/360p"}))
    probes.append(("child", {**child, "source_key": "videos/a/jobs/b/source.mp4"}))
    for path, value in (
        (("media_playlist", "key"), result["media_playlist"]["key"].replace("/attempts/1/", "/attempts/2/")),
        (("segments", 0, "key"), result["segments"][0]["key"].replace("segment-00000", "segment-00001")),
        (("segments", 0, "key"), "../segment-00000.ts"),
        (("segments", 0, "size_bytes"), 0),
        (("segments", 0, "content_type"), "application/json"),
        (("segments",), []),
        (("width",), 1281),
        (("rendition",), "1080p"),
    ):
        mutated = copy.deepcopy(result)
        target = mutated
        for key in path[:-1]:
            target = target[key]
        target[path[-1]] = value
        probes.append(("result", mutated))
    for kind, payload in probes:
        schema_name = "child_result_schema" if kind == "result" else f"{kind}_input_schema"
        try:
            validate_orchestration_payload(kind, payload, schemas[schema_name], parent, child)
        except ContractError:
            continue
        raise ContractError(f"{kind} validation accepts an invalid identity/result probe")


def validate_scalability_contract(contracts_dir: Path, api: dict[str, Any]) -> None:
    contract_path = contracts_dir / "domain" / "scalability-conventions.md"
    metadata, body = load_markdown_contract(contract_path)
    if metadata.get("contract_version") != 1 or metadata.get("contract_id") != "phase3-scalability":
        raise ContractError("scalability contract metadata is invalid")

    expected_paths = {
        "status_schema": contracts_dir / "domain" / "job-status.schema.json",
        "storage_contract": contracts_dir / "domain" / "storage-conventions.md",
        "reliability_contract": contracts_dir / "domain" / "reliability-conventions.md",
        "parent_input_schema": contracts_dir / "domain" / "orchestration-parent-input.schema.json",
        "child_input_schema": contracts_dir / "domain" / "orchestration-child-input.schema.json",
        "child_result_schema": contracts_dir / "domain" / "orchestration-child-result.schema.json",
        "parent_input_fixture": contracts_dir / "examples" / "internal" / "parent-input.json",
        "child_input_fixture": contracts_dir / "examples" / "internal" / "child-input.json",
        "child_result_fixture": contracts_dir / "examples" / "internal" / "child-result.json",
    }
    for field, expected in expected_paths.items():
        reference = metadata.get(field)
        if not isinstance(reference, str) or (contract_path.parent / reference).resolve() != expected.resolve():
            raise ContractError(f"scalability contract {field} has an invalid reference")
        if not expected.is_file():
            raise ContractError(f"scalability contract reference is missing: {expected}")

    schemas = {}
    for name in ("parent_input_schema", "child_input_schema", "child_result_schema"):
        schema_path = expected_paths[name]
        schema = load_json(schema_path)
        Draft202012Validator.check_schema(schema)
        schemas[name] = Draft202012Validator(schema, format_checker=FormatChecker())
    parent = load_json(expected_paths["parent_input_fixture"])
    child = load_json(expected_paths["child_input_fixture"])
    result = load_json(expected_paths["child_result_fixture"])
    for name, validator, instance in (
        ("parent", schemas["parent_input_schema"], parent),
        ("child", schemas["child_input_schema"], child),
        ("result", schemas["child_result_schema"], result),
    ):
        validate_orchestration_payload(name, instance, validator, parent, child)

    validate_orchestration_rejections(schemas, parent, child, result)
    if metadata.get("modes") != {
        "default": "cli", "supported": ["cli", "distributed"],
        "immutable_after_first_acquisition": True,
    }:
        raise ContractError("scalability mode metadata is invalid")
    if metadata.get("results") != {
        "transport": "s3", "bucket": "VIDEO_OUTPUT_BUCKET", "filename": "result.json",
        "content_type": "application/json", "ecs_integration": "ecs:runTask.sync",
        "cloudfront_readable": False,
    }:
        raise ContractError("scalability results must use private S3 JSON and ECS sync")
    if metadata.get("delivery") != {
        "playback_base_url": "PLAYBACK_BASE_URL",
        "scheme": "https",
        "bucket_private": True,
        "origin_access_control": True,
        "path_has_bucket_name": False,
    }:
        raise ContractError("scalability delivery metadata contradicts private HTTPS delivery")

    normalized = re.sub(r"\s+", " ", body)
    required_phrases = (
        "Inline Map with `MaxConcurrency: 2`",
        "`cli` or `distributed`",
        "The mode is persisted when the job is first acquired",
        "four distributed parents with two children each imply at most eight",
        "strictly inside the original visibility lifetime",
        "min=1 and max=4",
        "published_manifest_key",
        "A child receives no SQS receipt handle, database credential, or completion authority",
        "videos/{video_id}/jobs/{job_id}/hls/index.m3u8",
        "hls/attempts/{attempt}/{execution_id}/{rendition}/index.m3u8",
        "hls/attempts/{attempt}/{execution_id}/index.m3u8",
        "publishes its master last",
        "media playlist next, and `result.json` last",
        "result_key = child.output_prefix/result.json",
        "Parent, child, and result must have identical video_id, job_id, attempt",
        "result.json` objects are never viewer content",
        "an API that resolves published pointers and CloudFront URLs",
    )
    for phrase in required_phrases:
        if phrase.lower() not in normalized.lower():
            raise ContractError(f"scalability contract is missing required rule: {phrase}")

    storage = re.sub(r"\s+", " ", (contracts_dir / "domain" / "storage-conventions.md").read_text(encoding="utf-8"))
    for phrase in (
        "Phase 3 introduces CloudFront",
        "output bucket MUST reject anonymous S3 GET/HEAD",
        "result.json objects MUST NOT be readable through CloudFront",
    ):
        if phrase not in storage:
            raise ContractError(f"storage delivery contract is missing: {phrase}")
    for obsolete in ("allow unauthenticated", "Phase 2 delivery baseline", "Phase 2 owns the CloudFront"):
        if obsolete in storage or obsolete in normalized:
            raise ContractError(f"obsolete public-S3/Phase 2 delivery requirement: {obsolete}")

    playback_schema = api["components"]["schemas"]["PlaybackResponse"]["properties"]["manifestUrl"]
    if playback_schema.get("pattern") != r"^https://[^?#]+$":
        raise ContractError("PlaybackResponse.manifestUrl must require an HTTPS delivery URL")
    playback_url = load_json(contracts_dir / "examples" / "api" / "get-playback-response.json")["manifestUrl"]
    parsed = urlparse(playback_url)
    if parsed.scheme != "https" or not parsed.netloc or ".s3." in parsed.netloc:
        raise ContractError("playback example must use PLAYBACK_BASE_URL, not an S3 endpoint")
    if "/streaming-video-output/" in parsed.path:
        raise ContractError("playback URL must not insert the bucket name into delivery paths")


def main() -> int:
    repo_root = Path(__file__).resolve().parents[2]
    contracts_dir = repo_root / "app" / "contracts"
    api_path = contracts_dir / "openapi" / "api.yaml"
    examples_dir = contracts_dir / "examples" / "api"

    job_status_path = contracts_dir / "domain" / "job-status.schema.json"
    job_status_schema = load_json(job_status_path)
    Draft202012Validator.check_schema(job_status_schema)
    if job_status_schema.get("enum") != EXPECTED_STATUSES:
        raise ContractError("job-status.schema.json does not contain the exact Phase 1 statuses")

    api = load_yaml(api_path)
    validate_external_references(api, api_path)
    referenced_examples, validators = validate_openapi_examples(api, api_path, job_status_schema)
    validate_failure_semantics(validators["Job"])
    validate_storage_example(contracts_dir, api, examples_dir)
    validate_reliability_contract(contracts_dir, api)
    validate_scalability_contract(contracts_dir, api)

    print(
        f"contracts valid: {len(referenced_examples)} API examples, "
        "1 S3 event example, FAILED/failure semantics, and Phase 2/3 contracts"
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ContractError as exc:
        print(f"contract validation failed: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
