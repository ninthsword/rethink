"""Fail-closed evaluator for narrowly reviewed Semgrep findings."""

from __future__ import annotations

import argparse
import bisect
import hashlib
import json
import os
import re
import stat
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any


RESULT_SCHEMA = "semgrep-reviewed-filter-result-v1"
EXCEPTION_SCHEMA = "semgrep-reviewed-exceptions-v1"
INSECURE_WEBSOCKET_RULE = (
    "javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket"
)
MCP_SOURCE_PATH = "tools/mcp-server.ts"
REQUIRED_SPAN_LENGTH = 5
REQUIRED_SPAN_SHA256 = (
    "2edfb372706c7f539289f553822d89cc0747e34c746deadffa3fe22fc5ca00c7"
)
MAX_REPORT_BYTES = 32 * 1024 * 1024
MAX_EXCEPTION_BYTES = 1024 * 1024
MAX_SOURCE_BYTES = 8 * 1024 * 1024
MAX_TOTAL_SOURCE_BYTES = 64 * 1024 * 1024
MAX_SOURCE_FILES = 256
MAX_FINDINGS = 10_000
MAX_EXCEPTIONS = 128
HASH_PATTERN = re.compile(r"[0-9a-f]{64}\Z")
ID_PATTERN = re.compile(r"[a-z0-9][a-z0-9._-]{0,127}\Z")


class PolicyError(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class StrictArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        del message
        raise PolicyError("INVALID_ARGUMENTS")


@dataclass(frozen=True)
class Position:
    line: int
    col: int
    offset: int

    def key(self) -> tuple[int, int, int]:
        return (self.line, self.col, self.offset)


@dataclass(frozen=True)
class SourceDocument:
    data: bytes
    sha256: str
    line_starts: tuple[int, ...]

    @classmethod
    def from_bytes(cls, data: bytes) -> SourceDocument:
        try:
            data.decode("utf-8")
        except UnicodeDecodeError as error:
            raise PolicyError("INVALID_SOURCE_ENCODING") from error
        starts = [0]
        starts.extend(index + 1 for index, byte in enumerate(data) if byte == 0x0A)
        return cls(data, hashlib.sha256(data).hexdigest(), tuple(starts))

    def position_at(self, offset: int) -> Position:
        if offset < 0 or offset > len(self.data):
            raise PolicyError("INVALID_POSITION")
        line_index = bisect.bisect_right(self.line_starts, offset) - 1
        line_start = self.line_starts[line_index]
        try:
            self.data[line_start:offset].decode("utf-8")
        except UnicodeDecodeError as error:
            raise PolicyError("INVALID_POSITION") from error
        return Position(line_index + 1, offset - line_start + 1, offset)

    def line_at(self, offset: int) -> bytes:
        line_index = bisect.bisect_right(self.line_starts, offset) - 1
        line_start = self.line_starts[line_index]
        if line_index + 1 < len(self.line_starts):
            line_end = self.line_starts[line_index + 1] - 1
        else:
            line_end = len(self.data)
        return self.data[line_start:line_end]


@dataclass(frozen=True)
class Finding:
    rule_id: str
    path: str
    start: Position
    end: Position
    source_sha256: str
    source_range_sha256: str
    source_line_sha256: str


@dataclass(frozen=True)
class ExceptionSpec:
    exception_id: str
    rule_id: str
    path: str
    source_sha256: str
    start: Position
    end: Position
    source_line_sha256: str
    max_count: int
    rationale: str


class SourceRepository:
    def __init__(self, root: Path) -> None:
        if not root.is_absolute() or ".." in root.parts:
            raise PolicyError("INVALID_ROOT")
        try:
            root_info = root.lstat()
        except OSError as error:
            raise PolicyError("INVALID_ROOT") from error
        if stat.S_ISLNK(root_info.st_mode) or not stat.S_ISDIR(root_info.st_mode):
            raise PolicyError("INVALID_ROOT")
        self.root = root
        self.cache: dict[str, SourceDocument] = {}
        self.total_bytes = 0

    def read(self, relative_path: str) -> SourceDocument:
        cached = self.cache.get(relative_path)
        if cached is not None:
            return cached
        if len(self.cache) >= MAX_SOURCE_FILES:
            raise PolicyError("TOO_MANY_SOURCE_FILES")

        parts = _safe_path_parts(relative_path)
        current = self.root
        for index, part in enumerate(parts):
            current /= part
            try:
                info = current.lstat()
            except FileNotFoundError as error:
                raise PolicyError("MISSING_SOURCE") from error
            except OSError as error:
                raise PolicyError("UNSAFE_SOURCE") from error
            if stat.S_ISLNK(info.st_mode):
                raise PolicyError("UNSAFE_SOURCE")
            if index < len(parts) - 1:
                if not stat.S_ISDIR(info.st_mode):
                    raise PolicyError("UNSAFE_SOURCE")
            elif not stat.S_ISREG(info.st_mode):
                raise PolicyError("UNSAFE_SOURCE")

        if info.st_size > MAX_SOURCE_BYTES:
            raise PolicyError("SOURCE_TOO_LARGE")
        try:
            descriptor = os.open(current, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
            with os.fdopen(descriptor, "rb") as source_file:
                data = source_file.read(MAX_SOURCE_BYTES + 1)
        except OSError as error:
            raise PolicyError("UNSAFE_SOURCE") from error
        if len(data) > MAX_SOURCE_BYTES:
            raise PolicyError("SOURCE_TOO_LARGE")
        self.total_bytes += len(data)
        if self.total_bytes > MAX_TOTAL_SOURCE_BYTES:
            raise PolicyError("SOURCE_BUDGET_EXCEEDED")

        document = SourceDocument.from_bytes(data)
        self.cache[relative_path] = document
        return document


def _safe_path_parts(value: str) -> tuple[str, ...]:
    if not isinstance(value, str) or not value or len(value) > 1024:
        raise PolicyError("UNSAFE_SOURCE_PATH")
    if value.startswith("/") or "\\" in value or "\x00" in value:
        raise PolicyError("UNSAFE_SOURCE_PATH")
    parts = tuple(value.split("/"))
    if any(not part or part in {".", ".."} or ":" in part for part in parts):
        raise PolicyError("UNSAFE_SOURCE_PATH")
    return parts


def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise PolicyError("DUPLICATE_JSON_KEY")
        result[key] = value
    return result


def _reject_json_constant(value: str) -> None:
    del value
    raise PolicyError("INVALID_JSON_CONSTANT")


def _read_json(path: Path, limit: int, error_code: str) -> Any:
    try:
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
            raise PolicyError(error_code)
        if info.st_size > limit:
            raise PolicyError(error_code)
        raw = path.read_bytes()
        if len(raw) > limit:
            raise PolicyError(error_code)
        text = raw.decode("utf-8")
        return json.loads(
            text,
            object_pairs_hook=_reject_duplicate_keys,
            parse_constant=_reject_json_constant,
        )
    except PolicyError:
        raise
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, RecursionError) as error:
        raise PolicyError(error_code) from error


def _exact_object(value: Any, keys: set[str], error_code: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != keys:
        raise PolicyError(error_code)
    return value


def _bounded_string(value: Any, maximum: int, error_code: str) -> str:
    if not isinstance(value, str) or not value or len(value) > maximum:
        raise PolicyError(error_code)
    return value


def _hash_string(value: Any, error_code: str) -> str:
    if not isinstance(value, str) or HASH_PATTERN.fullmatch(value) is None:
        raise PolicyError(error_code)
    return value


def _position(value: Any, error_code: str) -> Position:
    item = _exact_object(value, {"line", "col", "offset"}, error_code)
    line = item["line"]
    col = item["col"]
    offset = item["offset"]
    if type(line) is not int or type(col) is not int or type(offset) is not int:
        raise PolicyError(error_code)
    if line < 1 or col < 1 or offset < 0:
        raise PolicyError(error_code)
    return Position(line, col, offset)


def _validated_span(
    source: SourceDocument,
    start: Position,
    end: Position,
) -> tuple[bytes, str]:
    if start.offset >= len(source.data) or end.offset > len(source.data):
        raise PolicyError("INVALID_POSITION")
    if end.offset <= start.offset:
        raise PolicyError("INVALID_SOURCE_SPAN")
    if source.position_at(start.offset) != start or source.position_at(end.offset) != end:
        raise PolicyError("INVALID_POSITION")
    span = source.data[start.offset : end.offset]
    source_line_sha256 = hashlib.sha256(source.line_at(start.offset)).hexdigest()
    return span, source_line_sha256


def _validate_rule_span(rule_id: str, start: Position, end: Position, span: bytes) -> None:
    if rule_id != INSECURE_WEBSOCKET_RULE:
        return
    if start.line != end.line:
        raise PolicyError("INVALID_SOURCE_SPAN")
    if len(span) != REQUIRED_SPAN_LENGTH:
        raise PolicyError("INVALID_SOURCE_SPAN")
    if hashlib.sha256(span).hexdigest() != REQUIRED_SPAN_SHA256:
        raise PolicyError("INVALID_SOURCE_SPAN")


def _report_parts(document: Any) -> tuple[list[Any], list[Any]]:
    if not isinstance(document, dict):
        raise PolicyError("INVALID_REPORT")
    results = document.get("results")
    errors = document.get("errors")
    if not isinstance(results, list) or not isinstance(errors, list):
        raise PolicyError("INVALID_REPORT")
    if len(results) > MAX_FINDINGS:
        raise PolicyError("TOO_MANY_FINDINGS")
    return results, errors


def _finding(value: Any, sources: SourceRepository) -> Finding:
    if not isinstance(value, dict):
        raise PolicyError("INVALID_REPORT")
    rule_id = _bounded_string(value.get("check_id"), 512, "INVALID_REPORT")
    path = _bounded_string(value.get("path"), 1024, "INVALID_REPORT")
    _safe_path_parts(path)
    start = _position(value.get("start"), "INVALID_POSITION")
    end = _position(value.get("end"), "INVALID_POSITION")
    source = sources.read(path)
    span, source_line_sha256 = _validated_span(source, start, end)
    _validate_rule_span(rule_id, start, end, span)
    return Finding(
        rule_id=rule_id,
        path=path,
        start=start,
        end=end,
        source_sha256=source.sha256,
        source_range_sha256=hashlib.sha256(span).hexdigest(),
        source_line_sha256=source_line_sha256,
    )


def _exception_specs(document: Any) -> list[ExceptionSpec]:
    root = _exact_object(document, {"schema", "exceptions"}, "INVALID_EXCEPTIONS")
    if root["schema"] != EXCEPTION_SCHEMA or not isinstance(root["exceptions"], list):
        raise PolicyError("INVALID_EXCEPTIONS")
    if not root["exceptions"] or len(root["exceptions"]) > MAX_EXCEPTIONS:
        raise PolicyError("INVALID_EXCEPTIONS")

    fields = {
        "id",
        "rule_id",
        "path",
        "source_sha256",
        "start",
        "end",
        "source_line_sha256",
        "max_count",
        "rationale",
    }
    specs: list[ExceptionSpec] = []
    seen_ids: set[str] = set()
    seen_bindings: set[tuple[Any, ...]] = set()
    for value in root["exceptions"]:
        item = _exact_object(value, fields, "INVALID_EXCEPTIONS")
        exception_id = _bounded_string(item["id"], 128, "INVALID_EXCEPTIONS")
        if ID_PATTERN.fullmatch(exception_id) is None or exception_id in seen_ids:
            raise PolicyError("INVALID_EXCEPTIONS")
        seen_ids.add(exception_id)
        rule_id = _bounded_string(item["rule_id"], 512, "INVALID_EXCEPTIONS")
        path = _bounded_string(item["path"], 1024, "INVALID_EXCEPTIONS")
        if rule_id != INSECURE_WEBSOCKET_RULE or path != MCP_SOURCE_PATH:
            raise PolicyError("INVALID_EXCEPTIONS")
        max_count = item["max_count"]
        if type(max_count) is not int or max_count != 1:
            raise PolicyError("INVALID_EXCEPTIONS")
        rationale = _bounded_string(item["rationale"], 512, "INVALID_EXCEPTIONS")
        if len(rationale) < 20 or rationale.strip() != rationale:
            raise PolicyError("INVALID_EXCEPTIONS")
        spec = ExceptionSpec(
            exception_id=exception_id,
            rule_id=rule_id,
            path=path,
            source_sha256=_hash_string(item["source_sha256"], "INVALID_EXCEPTIONS"),
            start=_position(item["start"], "INVALID_EXCEPTIONS"),
            end=_position(item["end"], "INVALID_EXCEPTIONS"),
            source_line_sha256=_hash_string(
                item["source_line_sha256"], "INVALID_EXCEPTIONS"
            ),
            max_count=max_count,
            rationale=rationale,
        )
        binding = (
            spec.rule_id,
            spec.path,
            spec.source_sha256,
            spec.start.key(),
            spec.end.key(),
            spec.source_line_sha256,
        )
        if binding in seen_bindings:
            raise PolicyError("AMBIGUOUS_EXCEPTION")
        seen_bindings.add(binding)
        specs.append(spec)
    return specs


def _validate_exception(spec: ExceptionSpec, sources: SourceRepository) -> None:
    source = sources.read(spec.path)
    span, source_line_sha256 = _validated_span(source, spec.start, spec.end)
    _validate_rule_span(spec.rule_id, spec.start, spec.end, span)
    if source.sha256 != spec.source_sha256:
        raise PolicyError("SOURCE_HASH_MISMATCH")
    if source_line_sha256 != spec.source_line_sha256:
        raise PolicyError("SOURCE_LINE_HASH_MISMATCH")


def _matches(finding: Finding, spec: ExceptionSpec) -> bool:
    return (
        finding.rule_id == spec.rule_id
        and finding.path == spec.path
        and finding.source_sha256 == spec.source_sha256
        and finding.start.key() == spec.start.key()
        and finding.end.key() == spec.end.key()
        and finding.source_line_sha256 == spec.source_line_sha256
    )


def evaluate(report: Any, exceptions_path: Path, root: Path) -> tuple[int, list[str]]:
    sources = SourceRepository(root)
    results, errors = _report_parts(report)

    # Authenticate every record before making any allow/deny decision.
    findings = [_finding(value, sources) for value in results]
    if errors:
        raise PolicyError("SEMGREP_ERRORS")

    exception_document = _read_json(
        exceptions_path, MAX_EXCEPTION_BYTES, "INVALID_EXCEPTIONS"
    )
    specs = _exception_specs(exception_document)
    for spec in specs:
        _validate_exception(spec, sources)

    counts = {spec.exception_id: 0 for spec in specs}
    used_ids: set[str] = set()
    for finding in findings:
        matches = [spec for spec in specs if _matches(finding, spec)]
        if not matches:
            raise PolicyError("UNLISTED_FINDING")
        if len(matches) != 1:
            raise PolicyError("AMBIGUOUS_EXCEPTION")
        match = matches[0]
        counts[match.exception_id] += 1
        if counts[match.exception_id] > match.max_count:
            raise PolicyError("COUNT_OVERFLOW")
        used_ids.add(match.exception_id)
    return len(findings), sorted(used_ids)


def _emit(status: str, finding_count: int, exception_ids: list[str], error: str | None) -> None:
    payload = {
        "schema": RESULT_SCHEMA,
        "status": status,
        "finding_count": finding_count,
        "exception_ids": exception_ids,
        "error": error,
    }
    print(json.dumps(payload, separators=(",", ":"), sort_keys=True))


def main(argv: list[str]) -> int:
    parser = StrictArgumentParser(allow_abbrev=False)
    parser.add_argument("--report", required=True)
    parser.add_argument("--exceptions", required=True)
    parser.add_argument("--root", required=True)
    finding_count = 0
    try:
        args = parser.parse_args(argv)
        report_path = Path(args.report)
        exceptions_path = Path(args.exceptions)
        report_document = _read_json(report_path, MAX_REPORT_BYTES, "INVALID_REPORT")
        results, _ = _report_parts(report_document)
        finding_count = len(results)
        finding_count, exception_ids = evaluate(report_document, exceptions_path, Path(args.root))
        _emit("pass", finding_count, exception_ids, None)
        return 0
    except PolicyError as error:
        _emit("fail", finding_count, [], error.code)
        return 1
    except Exception:
        _emit("fail", finding_count, [], "INTERNAL_ERROR")
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
