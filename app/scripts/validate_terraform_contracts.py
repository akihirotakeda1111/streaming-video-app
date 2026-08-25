#!/usr/bin/env python3
"""Statically validate the Phase 1 Terraform architecture contract.

This validator deliberately does not invoke Terraform, contact AWS, install providers,
or evaluate HCL expressions. It checks only the structural and security properties that
the Phase 1 infrastructure task spec makes deterministic enough to verify statically.
It does not prescribe Terraform filenames, resource names, or policy decomposition.
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path


# Mirrors the Phase 1 infra spec: application compute and PostgreSQL stay local,
# while CloudFront, orchestration, retry infrastructure, and production hardening
# are deferred. Change this boundary only when the task spec changes.
FORBIDDEN_RESOURCE_PREFIXES = (
    "aws_alb",
    "aws_appautoscaling_",
    "aws_autoscaling_",
    "aws_cloudfront_",
    "aws_cloudwatch_",
    "aws_db_",
    "aws_dynamodb_",
    "aws_ec2_",
    "aws_ecr_",
    "aws_ecs_",
    "aws_elasticache_",
    "aws_lambda_",
    "aws_lb",
    "aws_pipes_",
    "aws_rds_",
    "aws_sfn_",
)

FORBIDDEN_RESOURCE_TYPES = {
    "aws_iam_access_key",
    "aws_sqs_queue_redrive_allow_policy",
}

POLICY_RESOURCE_TYPES = {
    "aws_iam_policy",
    "aws_iam_role_policy",
    "aws_iam_user_policy",
    "aws_s3_bucket_policy",
    "aws_sqs_queue_policy",
}

WRITE_ACTIONS = {
    "s3:abortmultipartupload",
    "s3:deleteobject",
    "s3:deleteobjectversion",
    "s3:putbucketacl",
    "s3:putbucketpolicy",
    "s3:putobject",
    "s3:putobjectacl",
}

BLOCK_RE = re.compile(
    r'(?m)^\s*(resource|data|variable|output|provider)\s+"([^"\r\n]+)"'
    r'(?:\s+"([^"\r\n]+)")?\s*\{'
)
STRING_RE = re.compile(r'"((?:\\.|[^"\\])*)"', re.DOTALL)
ATTRIBUTE_RE_TEMPLATE = r"(?m)^\s*{name}\s*=\s*([^\r\n]+)"


class TerraformContractError(RuntimeError):
    """Raised when Terraform configuration violates the Phase 1 task spec."""


@dataclass(frozen=True)
class Block:
    kind: str
    type_name: str
    name: str | None
    body: str
    path: Path
    line: int

    @property
    def address(self) -> str:
        if self.name is None:
            return f"{self.kind}.{self.type_name}"
        return f"{self.kind}.{self.type_name}.{self.name}"

    @property
    def location(self) -> str:
        return f"{self.path.name}:{self.line}"


@dataclass(frozen=True)
class Configuration:
    root: Path
    files: tuple[Path, ...]
    text: str
    blocks: tuple[Block, ...]

    def resources(self, type_name: str | None = None) -> list[Block]:
        resources = [block for block in self.blocks if block.kind == "resource"]
        if type_name is not None:
            resources = [block for block in resources if block.type_name == type_name]
        return resources

    def data(self, type_name: str | None = None) -> list[Block]:
        blocks = [block for block in self.blocks if block.kind == "data"]
        if type_name is not None:
            blocks = [block for block in blocks if block.type_name == type_name]
        return blocks


class Checks:
    def __init__(self) -> None:
        self.errors: list[str] = []

    def require(self, condition: bool, message: str) -> None:
        if not condition:
            self.errors.append(message)

    def reject(self, condition: bool, message: str) -> None:
        if condition:
            self.errors.append(message)


def _matching_brace(text: str, opening: int, path: Path) -> int:
    depth = 0
    index = opening
    quote = False
    escaped = False
    line_comment = False
    block_comment = False

    while index < len(text):
        char = text[index]
        following = text[index + 1] if index + 1 < len(text) else ""

        if line_comment:
            if char == "\n":
                line_comment = False
            index += 1
            continue
        if block_comment:
            if char == "*" and following == "/":
                block_comment = False
                index += 2
            else:
                index += 1
            continue
        if quote:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                quote = False
            index += 1
            continue

        if char == '"':
            quote = True
        elif char == "#":
            line_comment = True
        elif char == "/" and following == "/":
            line_comment = True
            index += 1
        elif char == "/" and following == "*":
            block_comment = True
            index += 1
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return index
        index += 1

    raise TerraformContractError(f"unclosed HCL block in {path}")


def _parse_blocks(path: Path, text: str) -> list[Block]:
    blocks: list[Block] = []
    for match in BLOCK_RE.finditer(text):
        opening = match.end() - 1
        closing = _matching_brace(text, opening, path)
        blocks.append(
            Block(
                kind=match.group(1),
                type_name=match.group(2),
                name=match.group(3),
                body=text[opening + 1 : closing],
                path=path,
                line=text.count("\n", 0, match.start()) + 1,
            )
        )
    return blocks


def load_configuration(root: Path) -> Configuration:
    if not root.is_dir():
        raise TerraformContractError(f"Terraform root does not exist: {root}")

    files = tuple(sorted(root.glob("*.tf")))
    if not files:
        raise TerraformContractError(f"no Terraform files found in {root}")

    texts: list[str] = []
    blocks: list[Block] = []
    for path in files:
        try:
            text = path.read_text(encoding="utf-8")
        except OSError as exc:
            raise TerraformContractError(f"cannot read {path}: {exc}") from exc
        texts.append(text)
        blocks.extend(_parse_blocks(path, text))

    return Configuration(root=root, files=files, text="\n".join(texts), blocks=tuple(blocks))


def _strings(text: str) -> set[str]:
    return {match.group(1).replace('\\"', '"') for match in STRING_RE.finditer(text)}


def _lower_strings(text: str) -> set[str]:
    return {value.lower() for value in _strings(text)}


def _has(text: str, value: str) -> bool:
    return value.lower() in text.lower()


def _attribute(text: str, name: str) -> str | None:
    match = re.search(ATTRIBUTE_RE_TEMPLATE.format(name=re.escape(name)), text)
    return match.group(1).strip() if match else None


def _collection_attribute(text: str, name: str) -> str | None:
    match = re.search(
        rf"(?is)\b{re.escape(name)}\b\s*=\s*(\[[^\]]*\]|\"[^\"]*\"|[^\r\n]+)",
        text,
    )
    return match.group(1).strip() if match else None


def _attribute_is_true(text: str, name: str) -> bool:
    value = _attribute(text, name)
    return value is not None and re.match(r"true\b", value, re.IGNORECASE) is not None


def _attribute_is_false(text: str, name: str) -> bool:
    value = _attribute(text, name)
    return value is not None and re.match(r"false\b", value, re.IGNORECASE) is not None


def _normalized_expression(value: str | None) -> str:
    return re.sub(r"\s+", "", value or "").lower()


def _resource_references(text: str, type_name: str) -> set[str]:
    return set(
        re.findall(
            rf"\b{re.escape(type_name)}\.([A-Za-z_][A-Za-z0-9_-]*)\b",
            text,
        )
    )


def _named_blocks(config: Configuration, kind: str, type_name: str) -> dict[str, Block]:
    return {
        block.name: block
        for block in config.blocks
        if block.kind == kind and block.type_name == type_name and block.name is not None
    }


def _policy_text(config: Configuration, block: Block) -> str:
    """Return a policy resource plus any referenced aws_iam_policy_document bodies."""
    parts = [block.body]
    documents = _named_blocks(config, "data", "aws_iam_policy_document")
    for name in _resource_references(block.body, "data.aws_iam_policy_document"):
        document = documents.get(name)
        if document is not None:
            parts.append(document.body)
    return "\n".join(parts)


def _find_linked_block(
    blocks: list[Block], resource_type: str, resource_name: str
) -> list[Block]:
    return [
        block
        for block in blocks
        if resource_name in _resource_references(block.body, resource_type)
    ]


def _cors_origins(blocks: list[Block]) -> set[str]:
    return {
        _normalized_expression(value)
        for block in blocks
        if (value := _collection_attribute(block.body, "allowed_origins")) is not None
    }


def check_foundation(config: Configuration, checks: Checks) -> None:
    checks.require(
        _has(config.text, "required_providers") and _has(config.text, "hashicorp/aws"),
        "Terraform configuration must declare hashicorp/aws in required_providers",
    )
    checks.require(
        any(
            block.kind == "provider" and block.type_name == "aws"
            for block in config.blocks
        ),
        'an explicit provider "aws" block is required',
    )

    providers = [
        block
        for block in config.blocks
        if block.kind == "provider" and block.type_name == "aws"
    ]
    if providers:
        checks.require(
            _attribute(providers[0].body, "region") is not None,
            f"{providers[0].location}: AWS region configuration is required",
        )


def check_forbidden_resources(config: Configuration, checks: Checks) -> None:
    for block in config.resources():
        forbidden = block.type_name in FORBIDDEN_RESOURCE_TYPES or block.type_name.startswith(
            FORBIDDEN_RESOURCE_PREFIXES
        )
        checks.reject(
            forbidden,
            f"{block.location}: resource {block.type_name} is outside Phase 1 scope",
        )

        if block.type_name == "aws_sqs_queue":
            checks.reject(
                _has(block.body, "redrive_policy")
                or _has(block.body, "redrive_allow_policy")
                or _has(block.body, "dead_letter"),
                f"{block.location}: DLQ/redrive configuration is outside Phase 1 scope",
            )


def _bucket_reference(block: Block) -> set[str]:
    return _resource_references(block.body, "aws_s3_bucket")


def check_storage_queue(config: Configuration, checks: Checks) -> tuple[str | None, str | None]:
    buckets = _named_blocks(config, "resource", "aws_s3_bucket")
    queues = _named_blocks(config, "resource", "aws_sqs_queue")
    notifications = config.resources("aws_s3_bucket_notification")
    queue_policies = config.resources("aws_sqs_queue_policy")
    cors_blocks = config.resources("aws_s3_bucket_cors_configuration")
    bucket_policies = config.resources("aws_s3_bucket_policy")
    public_access_blocks = config.resources("aws_s3_bucket_public_access_block")

    checks.require(len(buckets) >= 2, "input and output S3 bucket resources are required")
    checks.require(bool(queues), "a Standard SQS encoding queue is required")
    checks.require(bool(notifications), "an S3 ObjectCreated notification is required")
    checks.require(bool(queue_policies), "an S3-to-SQS queue policy is required")
    checks.require(bool(cors_blocks), "S3 CORS configuration is required")
    checks.require(bool(bucket_policies), "an output HLS read policy is required")
    checks.require(bool(public_access_blocks), "S3 public access controls are required")

    for queue in queues.values():
        queue_name = _attribute(queue.body, "name") or ""
        checks.reject(
            _attribute_is_true(queue.body, "fifo_queue") or ".fifo" in queue_name.lower(),
            f"{queue.location}: the encoding queue must be a Standard queue",
        )

    canonical_notifications = [
        block
        for block in notifications
        if "s3:ObjectCreated:*" in _strings(block.body)
        and "videos/" in _strings(block.body)
        and "/source.mp4" in _strings(block.body)
        and _resource_references(block.body, "aws_sqs_queue")
    ]
    checks.require(
        bool(canonical_notifications),
        "an S3 notification must route videos/.../source.mp4 ObjectCreated events to SQS",
    )

    input_name: str | None = None
    encoding_queue_name: str | None = None
    if canonical_notifications:
        notification = canonical_notifications[0]
        bucket_refs = _bucket_reference(notification)
        checks.require(
            len(bucket_refs) == 1 and next(iter(bucket_refs), "") in buckets,
            f"{notification.location}: canonical notification must reference a declared bucket",
        )
        if len(bucket_refs) == 1 and next(iter(bucket_refs)) in buckets:
            input_name = next(iter(bucket_refs))

        queue_refs = _resource_references(notification.body, "aws_sqs_queue")
        checks.require(
            bool(queue_refs) and queue_refs.issubset(queues),
            f"{notification.location}: notification must target a declared Standard queue",
        )
        if queue_refs and queue_refs.issubset(queues):
            encoding_queue_name = next(iter(queue_refs))

    input_origins: set[str] = set()
    if input_name is not None:
        for notification in notifications:
            bucket_refs = _bucket_reference(notification)
            checks.reject(
                bool(bucket_refs) and bucket_refs != {input_name},
                f"{notification.location}: only the input bucket may publish S3 notifications",
            )

    output_name: str | None = None
    output_policy_candidates: list[tuple[Block, str, set[str]]] = []
    for block in bucket_policies:
        policy = _policy_text(config, block)
        actions = _policy_actions(policy)
        if (
            "s3:getobject" in actions
            and _has(policy, "videos/*/jobs/*/hls/*")
            and _has_public_principal(policy)
        ):
            output_policy_candidates.append((block, policy, _bucket_reference(block)))
    checks.require(
        bool(output_policy_candidates),
        "a public s3:GetObject policy restricted to Phase 1 HLS keys is required",
    )
    if output_policy_candidates:
        policy_block, _, bucket_refs = output_policy_candidates[0]
        checks.require(
            len(bucket_refs) == 1 and next(iter(bucket_refs), "") in buckets,
            f"{policy_block.location}: HLS read policy must reference a declared output bucket",
        )
        if len(bucket_refs) == 1 and next(iter(bucket_refs)) in buckets:
            output_name = next(iter(bucket_refs))

    if input_name is not None and output_name is not None:
        checks.require(input_name != output_name, "input and output S3 buckets must be distinct")
        input_bucket_value = _normalized_expression(
            _attribute(buckets[input_name].body, "bucket")
        )
        output_bucket_value = _normalized_expression(
            _attribute(buckets[output_name].body, "bucket")
        )
        checks.require(
            bool(input_bucket_value)
            and bool(output_bucket_value)
            and input_bucket_value != output_bucket_value,
            "input and output bucket resources must resolve from distinct expressions",
        )

    if input_name is not None:
        public_access = _find_linked_block(
            public_access_blocks,
            "aws_s3_bucket",
            input_name,
        )
        checks.require(
            bool(public_access),
            "the input bucket must have a public access block",
        )
        for block in public_access:
            for setting in (
                "block_public_acls",
                "block_public_policy",
                "ignore_public_acls",
                "restrict_public_buckets",
            ):
                checks.require(
                    _attribute_is_true(block.body, setting),
                    f"{block.location}: input bucket must set {setting} = true",
                )

        input_cors = _find_linked_block(cors_blocks, "aws_s3_bucket", input_name)
        checks.require(bool(input_cors), "input bucket must have CORS configuration")
        checks.require(
            any("put" in _lower_strings(block.body) for block in input_cors),
            "input bucket CORS must allow PUT",
        )
        input_origins = _cors_origins(input_cors)
        checks.require(bool(input_origins), "input bucket CORS must define allowed origins")
        checks.reject(
            any('"*"' in origin for origin in input_origins),
            "input bucket CORS must not allow every origin",
        )

    if output_name is not None:
        output_public_access = _find_linked_block(
            public_access_blocks,
            "aws_s3_bucket",
            output_name,
        )
        checks.require(
            bool(output_public_access),
            "the output bucket must have a public access block",
        )
        for block in output_public_access:
            for setting in ("block_public_acls", "ignore_public_acls"):
                checks.require(
                    _attribute_is_true(block.body, setting),
                    f"{block.location}: output bucket must set {setting} = true",
                )
            for setting in ("block_public_policy", "restrict_public_buckets"):
                checks.require(
                    _attribute_is_false(block.body, setting),
                    f"{block.location}: output bucket must set {setting} = false "
                    "for direct HLS reads",
                )

        output_cors = _find_linked_block(cors_blocks, "aws_s3_bucket", output_name)
        checks.require(bool(output_cors), "output bucket must have CORS configuration")
        checks.require(
            any("get" in _lower_strings(block.body) for block in output_cors),
            "output bucket CORS must allow GET",
        )
        output_origins = _cors_origins(output_cors)
        checks.require(bool(output_origins), "output bucket CORS must define allowed origins")
        checks.reject(
            any('"*"' in origin for origin in output_origins),
            "output bucket CORS must not allow every origin",
        )
        if input_origins and output_origins:
            checks.require(
                bool(input_origins & output_origins),
                "input and output CORS must share an explicit frontend origin",
            )

        linked_policies = _find_linked_block(bucket_policies, "aws_s3_bucket", output_name)
        checks.require(
            bool(linked_policies),
            "the public-read policy must be attached only to the output bucket",
        )
        for linked_policy in linked_policies:
            policy = _policy_text(config, linked_policy)
            values = _lower_strings(policy)
            actions = _policy_actions(policy)
            checks.require(
                "s3:getobject" in actions,
                f"{linked_policy.location}: output public policy must grant s3:GetObject",
            )
            checks.require(
                "*" in values,
                f"{linked_policy.location}: output policy must grant unauthenticated reads",
            )
            checks.require(
                _has(policy, "videos/*/jobs/*/hls/*"),
                f"{linked_policy.location}: public read must be limited to Phase 1 HLS keys",
            )
            checks.reject(
                bool(actions & WRITE_ACTIONS) or "s3:listbucket" in actions,
                f"{linked_policy.location}: output public policy must not grant list or write",
            )

    if input_name is not None and encoding_queue_name is not None:
        matching_queue_policies: list[tuple[Block, str]] = []
        for policy_block in queue_policies:
            queue_refs = _resource_references(policy_block.body, "aws_sqs_queue")
            policy = _policy_text(config, policy_block)
            if encoding_queue_name in queue_refs and "sqs:sendmessage" in _policy_actions(policy):
                matching_queue_policies.append((policy_block, policy))
        checks.require(
            bool(matching_queue_policies),
            "the encoding queue must have an S3 SendMessage policy",
        )
        for policy_block, policy in matching_queue_policies:
            values = _lower_strings(policy)
            checks.require(
                "s3.amazonaws.com" in values,
                f"{policy_block.location}: queue policy principal must be s3.amazonaws.com",
            )
            checks.require(
                input_name in _resource_references(policy, "aws_s3_bucket"),
                f"{policy_block.location}: SourceArn must restrict publication to input S3",
            )
            checks.require(
                _has(policy, "aws:SourceArn") and _has(policy, "aws:SourceAccount"),
                f"{policy_block.location}: SourceArn and SourceAccount conditions are required",
            )

    return input_name, output_name


def _policy_actions(policy: str) -> set[str]:
    actions: set[str] = set()
    for match in re.finditer(
        r'(?is)["\']?\b(?:actions?|not_actions?)\b["\']?\s*[:=]\s*'
        r'(\[[^\]]*\]|"[^\"]*")',
        policy,
    ):
        actions.update(value for value in _lower_strings(match.group(1)) if ":" in value)
    return actions


def check_iam_separation(
    config: Configuration,
    checks: Checks,
    input_name: str | None,
    output_name: str | None,
) -> None:
    policies = [
        block for block in config.resources() if block.type_name in POLICY_RESOURCE_TYPES
    ]
    identity_policies = [
        block
        for block in policies
        if block.type_name
        in {"aws_iam_policy", "aws_iam_role_policy", "aws_iam_user_policy"}
    ]
    checks.require(
        bool(identity_policies),
        "API and worker IAM permissions must be defined",
    )

    policy_texts = [(block, _policy_text(config, block)) for block in identity_policies]
    allowed_identity_actions = {
        "s3:getobject",
        "s3:putobject",
        "sqs:deletemessage",
        "sqs:getqueueattributes",
        "sqs:getqueueurl",
        "sqs:receivemessage",
    }
    for block, policy in policy_texts:
        unexpected = _policy_actions(policy) - allowed_identity_actions
        checks.require(
            not unexpected,
            f"{block.location}: identity policy has out-of-scope actions: "
            + ", ".join(sorted(unexpected)),
        )

    api_grants = [
        (block, text)
        for block, text in policy_texts
        if _policy_actions(text) == {"s3:putobject"}
        and _has(text, "source.mp4")
        and not _has(text, "/hls/")
        and (
            input_name is None
            or input_name in _resource_references(text, "aws_s3_bucket")
        )
    ]
    checks.require(
        bool(api_grants),
        "API permissions must be limited to canonical input s3:PutObject",
    )

    worker_queue_receive = False
    worker_queue_delete = False
    worker_input_read = False
    worker_output_write = False
    for _, policy in policy_texts:
        actions = _policy_actions(policy)
        queue_refs = _resource_references(policy, "aws_sqs_queue")
        bucket_refs = _resource_references(policy, "aws_s3_bucket")
        if queue_refs:
            worker_queue_receive |= "sqs:receivemessage" in actions
            worker_queue_delete |= "sqs:deletemessage" in actions
        if input_name is not None and input_name in bucket_refs and _has(policy, "source.mp4"):
            worker_input_read |= "s3:getobject" in actions
        if output_name is not None and output_name in bucket_refs and _has(policy, "/hls/"):
            worker_output_write |= "s3:putobject" in actions

    checks.require(
        worker_queue_receive and worker_queue_delete,
        "Worker permissions must allow SQS receive and delete",
    )
    checks.require(worker_input_read, "Worker permissions must read canonical input objects")
    checks.require(worker_output_write, "Worker permissions must write only HLS output objects")


def check_outputs(
    config: Configuration,
    checks: Checks,
    input_name: str | None,
    output_name: str | None,
) -> None:
    outputs = [block for block in config.blocks if block.kind == "output"]
    checks.require(bool(outputs), "non-secret runtime Terraform outputs are required")
    if input_name is not None:
        checks.require(
            any(
                input_name in _resource_references(block.body, "aws_s3_bucket")
                for block in outputs
            ),
            "an output must expose the resolved input bucket value",
        )
    if output_name is not None:
        checks.require(
            any(
                output_name in _resource_references(block.body, "aws_s3_bucket")
                for block in outputs
            ),
            "an output must expose the resolved output bucket value",
        )
    checks.require(
        any(
            _resource_references(block.body, "aws_sqs_queue")
            and re.search(r"\baws_sqs_queue\.[A-Za-z_][A-Za-z0-9_-]*\.(?:url|id)\b", block.body)
            for block in outputs
        ),
        "an output must expose the encoding queue URL",
    )


def _has_wildcard_action(policy: str) -> bool:
    return any(action == "*" or action.endswith(":*") for action in _policy_actions(policy))


def _has_wildcard_resource(policy: str) -> bool:
    for match in re.finditer(
        r'(?is)["\']?\b(?:resources?|not_resources?)\b["\']?\s*[:=]\s*'
        r'(\[[^\]]*\]|"[^\"]*")',
        policy,
    ):
        if "*" in _lower_strings(match.group(1)):
            return True
    return False


def _has_public_principal(policy: str) -> bool:
    return re.search(
        r'(?is)["\']?(?:principal|identifiers)["\']?\s*[:=]\s*'
        r'(?:\[[^\]]*"\*"|\{[^}]*"\*"[^}]*\}|"\*")',
        policy,
    ) is not None


def check_dangerous_configuration(config: Configuration, checks: Checks) -> None:
    for block in config.resources():
        if block.type_name == "aws_s3_bucket_acl":
            values = _lower_strings(block.body)
            checks.reject(
                bool(values & {"public-read", "public-read-write", "authenticated-read"}),
                f"{block.location}: public S3 ACLs are forbidden",
            )

        if block.type_name in POLICY_RESOURCE_TYPES:
            policy = _policy_text(config, block)
            checks.reject(
                _has_wildcard_action(policy),
                f"{block.location}: wildcard IAM actions are forbidden",
            )
            checks.reject(
                _has_wildcard_resource(policy),
                f"{block.location}: wildcard IAM resources are forbidden",
            )
            if _has_public_principal(policy):
                actions = _policy_actions(policy)
                checks.reject(
                    bool(actions & WRITE_ACTIONS),
                    f"{block.location}: unauthenticated S3 write/delete access is forbidden",
                )

    provider_blocks = [
        block
        for block in config.blocks
        if block.kind == "provider" and block.type_name == "aws"
    ]
    for block in provider_blocks:
        for name in ("access_key", "secret_key", "token"):
            checks.reject(
                _attribute(block.body, name) is not None,
                f"{block.location}: AWS provider must not configure {name}",
            )

    scanned_files = list(config.files) + sorted(config.root.glob("*.tfvars*"))
    for path in scanned_files:
        text = path.read_text(encoding="utf-8")
        checks.reject(
            re.search(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b", text) is not None,
            f"{path.name}: possible AWS access key is committed",
        )
        checks.reject(
            "-----BEGIN " in text and " PRIVATE KEY-----" in text,
            f"{path.name}: private key material is committed",
        )
        checks.reject(
            re.search(
                r'(?im)^\s*(?:aws_)?(?:secret_access_key|access_key|password|token)\s*=\s*"[^"$]+"',
                text,
            )
            is not None,
            f"{path.name}: credential or secret appears to be hard-coded",
        )


def validate(config: Configuration, stage: str) -> list[str]:
    checks = Checks()
    check_foundation(config, checks)
    check_forbidden_resources(config, checks)
    check_dangerous_configuration(config, checks)

    input_name: str | None = None
    output_name: str | None = None
    if stage in {"storage-queue", "complete"}:
        input_name, output_name = check_storage_queue(config, checks)
    if stage == "complete":
        check_iam_separation(config, checks, input_name, output_name)
        check_outputs(config, checks, input_name, output_name)
    return checks.errors


def parse_args() -> argparse.Namespace:
    repo_root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--terraform-dir",
        type=Path,
        default=repo_root / "app" / "infra" / "terraform",
        help="Terraform root to inspect (default: app/infra/terraform)",
    )
    parser.add_argument(
        "--stage",
        choices=("foundation", "storage-queue", "complete"),
        default="complete",
        help="Task completion stage to validate (default: complete)",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        config = load_configuration(args.terraform_dir.resolve())
        errors = validate(config, args.stage)
    except TerraformContractError as exc:
        print(f"Terraform contract validation failed: {exc}", file=sys.stderr)
        return 1

    if errors:
        print("Terraform contract validation failed:", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1

    print(
        f"Terraform contracts valid: stage={args.stage}, "
        f"files={len(config.files)}, resources={len(config.resources())}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
