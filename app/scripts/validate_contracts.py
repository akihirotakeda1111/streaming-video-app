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
EXPECTED_INTERNAL_FIELDS = ["worker_id", "attempt", "lease_expires_at"]
FORBIDDEN_PUBLIC_FIELDS = {
    "worker_id",
    "workerId",
    "attempt",
    "lease_expires_at",
    "leaseExpiresAt",
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
        raise ContractError("reliability contract must define the three Phase 2 lease fields")
    if metadata.get("public_api_exposes_internal_fields") is not False:
        raise ContractError("reliability fields must remain internal")

    publication = metadata.get("publication")
    if publication != {
        "manifest_name": "index.m3u8",
        "segments_before_manifest": True,
        "completed_after_manifest": True,
    }:
        raise ContractError("reliability publication metadata contradicts manifest-last ordering")

    component_schemas = api.get("components", {}).get("schemas", {})
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

    collect_property_names(component_schemas)
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

    print(
        f"contracts valid: {len(referenced_examples)} API examples, "
        "1 S3 event example, FAILED/failure semantics, and Phase 2 reliability"
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ContractError as exc:
        print(f"contract validation failed: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
