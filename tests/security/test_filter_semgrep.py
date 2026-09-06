"""Subprocess tests for the reviewed Semgrep finding evaluator."""

from __future__ import annotations

import copy
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
FILTER = REPOSITORY_ROOT / ".github/security/filter-semgrep.py"
SOURCE = REPOSITORY_ROOT / "tools/mcp-server.ts"
POLICY = REPOSITORY_ROOT / ".github/security/semgrep-reviewed-exceptions.json"
MCP_PATH = "tools/mcp-server.ts"
MATCH_LENGTH = 5
MATCH_SHA256 = "2edfb372706c7f539289f553822d89cc0747e34c746deadffa3fe22fc5ca00c7"
RESULT_FIELDS = {"schema", "status", "finding_count", "exception_ids", "error"}
UNSET = object()


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def position_at(source: bytes, offset: int) -> dict[str, int]:
    line_start = source.rfind(b"\n", 0, offset) + 1
    source[line_start:offset].decode("utf-8")
    return {
        "line": source.count(b"\n", 0, offset) + 1,
        "col": offset - line_start + 1,
        "offset": offset,
    }


def line_bytes_at(source: bytes, offset: int) -> bytes:
    line_start = source.rfind(b"\n", 0, offset) + 1
    line_end = source.find(b"\n", offset)
    if line_end < 0:
        line_end = len(source)
    return source[line_start:line_end]


class FilterSemgrepTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = (Path(self.temporary.name) / "repository").resolve()
        self.source_path = self.root / MCP_PATH
        self.policy_path = self.root / ".github/security/semgrep-reviewed-exceptions.json"
        self.report_path = self.root / "semgrep-report.json"
        self.source_path.parent.mkdir(parents=True)
        self.policy_path.parent.mkdir(parents=True)
        shutil.copyfile(SOURCE, self.source_path)
        shutil.copyfile(POLICY, self.policy_path)

        self.source = SOURCE.read_bytes()
        self.policy = json.loads(POLICY.read_text(encoding="utf-8"))
        self.entry = self.policy["exceptions"][0]
        self.finding = self.finding_from_entry(self.entry)
        self.report = {
            "version": "1.174.0",
            "results": [self.finding],
            "errors": [],
            "paths": {"scanned": [MCP_PATH]},
        }

    def tearDown(self) -> None:
        self.temporary.cleanup()

    @staticmethod
    def finding_from_entry(entry: dict[str, Any]) -> dict[str, Any]:
        return {
            "check_id": entry["rule_id"],
            "path": entry["path"],
            "start": copy.deepcopy(entry["start"]),
            "end": copy.deepcopy(entry["end"]),
            "extra": {
                "lines": "requires login",
                "fingerprint": "requires login",
            },
        }

    def finding_at(
        self,
        start_offset: int,
        end_offset: int,
        *,
        rule_id: str | None = None,
        path: str | None = None,
        source: bytes | None = None,
    ) -> dict[str, Any]:
        source_bytes = self.source if source is None else source
        return {
            "check_id": rule_id or self.entry["rule_id"],
            "path": path or self.entry["path"],
            "start": position_at(source_bytes, start_offset),
            "end": position_at(source_bytes, end_offset),
            "extra": {"lines": "presentation only"},
        }

    def write_source(self, data: bytes | None = None) -> None:
        if self.source_path.is_symlink() or self.source_path.exists():
            if self.source_path.is_dir() and not self.source_path.is_symlink():
                self.source_path.rmdir()
            else:
                self.source_path.unlink()
        self.source_path.write_bytes(self.source if data is None else data)

    def run_filter(
        self,
        *,
        report: Any = UNSET,
        policy: Any = UNSET,
        raw_report: str | None = None,
        raw_policy: str | None = None,
        root: Path | None = None,
    ) -> tuple[subprocess.CompletedProcess[str], dict[str, Any]]:
        if raw_report is None:
            report_value = self.report if report is UNSET else report
            self.report_path.write_text(
                json.dumps(report_value, ensure_ascii=False),
                encoding="utf-8",
            )
        else:
            self.report_path.write_text(raw_report, encoding="utf-8")

        if raw_policy is None:
            policy_value = self.policy if policy is UNSET else policy
            self.policy_path.write_text(
                json.dumps(policy_value, ensure_ascii=False),
                encoding="utf-8",
            )
        else:
            self.policy_path.write_text(raw_policy, encoding="utf-8")

        completed = subprocess.run(
            [
                sys.executable,
                "-B",
                str(FILTER),
                "--report",
                str(self.report_path),
                "--exceptions",
                str(self.policy_path),
                "--root",
                str(self.root if root is None else root),
            ],
            check=False,
            capture_output=True,
            text=True,
            timeout=10,
            env={**os.environ, "PYTHONHASHSEED": "0"},
        )
        self.assertEqual(completed.stderr, "")
        output_lines = completed.stdout.splitlines()
        self.assertEqual(len(output_lines), 1, completed.stdout)
        payload = json.loads(output_lines[0])
        self.assertEqual(set(payload), RESULT_FIELDS)
        return completed, payload

    def assert_pass(
        self,
        result: tuple[subprocess.CompletedProcess[str], dict[str, Any]],
        finding_count: int,
        exception_ids: list[str],
    ) -> None:
        completed, payload = result
        self.assertEqual(completed.returncode, 0)
        self.assertEqual(payload["schema"], "semgrep-reviewed-filter-result-v1")
        self.assertEqual(payload["status"], "pass")
        self.assertEqual(payload["finding_count"], finding_count)
        self.assertEqual(payload["exception_ids"], exception_ids)
        self.assertIsNone(payload["error"])

    def assert_fail(
        self,
        result: tuple[subprocess.CompletedProcess[str], dict[str, Any]],
        error: str | None = None,
    ) -> None:
        completed, payload = result
        self.assertNotEqual(completed.returncode, 0)
        self.assertEqual(payload["schema"], "semgrep-reviewed-filter-result-v1")
        self.assertEqual(payload["status"], "fail")
        self.assertEqual(payload["exception_ids"], [])
        self.assertIsInstance(payload["finding_count"], int)
        if error is not None:
            self.assertEqual(payload["error"], error)

    def test_real_source_policy_and_bound_finding_pass(self) -> None:
        self.assertEqual(len(self.policy["exceptions"]), 1)
        self.assertEqual(self.entry["path"], MCP_PATH)
        self.assertEqual(self.entry["source_sha256"], sha256(self.source))
        start = self.entry["start"]["offset"]
        end = self.entry["end"]["offset"]
        self.assertEqual(end - start, MATCH_LENGTH)
        self.assertEqual(sha256(self.source[start:end]), MATCH_SHA256)
        self.assertEqual(self.entry["start"], position_at(self.source, start))
        self.assertEqual(self.entry["end"], position_at(self.source, end))
        self.assertEqual(
            self.entry["source_line_sha256"],
            sha256(line_bytes_at(self.source, start)),
        )

        self.assert_pass(
            self.run_filter(),
            1,
            [self.entry["id"]],
        )

    def test_display_fields_are_ignored(self) -> None:
        reports = []
        missing_line = copy.deepcopy(self.report)
        missing_line["results"][0]["extra"] = {"fingerprint": "masked"}
        reports.append(missing_line)

        missing_extra = copy.deepcopy(self.report)
        del missing_extra["results"][0]["extra"]
        reports.append(missing_extra)

        arbitrary = copy.deepcopy(self.report)
        marker = "ARBITRARY-DISPLAY-TEXT-DO-NOT-EMIT"
        arbitrary["results"][0]["extra"] = {
            "lines": {"nested": [marker]},
            "fingerprint": False,
        }
        reports.append(arbitrary)

        for report in reports:
            with self.subTest(report=report):
                completed, payload = self.run_filter(report=report)
                self.assert_pass((completed, payload), 1, [self.entry["id"]])
                self.assertNotIn("ARBITRARY-DISPLAY-TEXT-DO-NOT-EMIT", completed.stdout)

    def test_empty_results_still_authenticate_the_source_pin(self) -> None:
        empty = {"version": "1.174.0", "results": [], "errors": []}
        self.assert_pass(self.run_filter(report=empty), 0, [])

        self.write_source(self.source + b"\n// changed\n")
        self.assert_fail(self.run_filter(report=empty), "SOURCE_HASH_MISMATCH")

        self.write_source()
        self.source_path.unlink()
        self.assert_fail(self.run_filter(report=empty), "MISSING_SOURCE")

        target = self.root / "source-target.ts"
        target.write_bytes(self.source)
        self.source_path.symlink_to(target)
        self.assert_fail(self.run_filter(report=empty), "UNSAFE_SOURCE")

    def test_duplicate_and_extra_findings_fail_closed(self) -> None:
        duplicate = copy.deepcopy(self.report)
        duplicate["results"].append(copy.deepcopy(self.finding))
        self.assert_fail(self.run_filter(report=duplicate), "COUNT_OVERFLOW")

        other_rule = copy.deepcopy(self.report)
        other_rule["results"][0]["check_id"] = "example.rules.other-finding"
        self.assert_fail(self.run_filter(report=other_rule), "UNLISTED_FINDING")

        other_path = "tools/other-source.ts"
        other_source = self.root / other_path
        other_source.write_bytes(self.source)
        moved = copy.deepcopy(self.report)
        moved["results"][0]["path"] = other_path
        self.assert_fail(self.run_filter(report=moved), "UNLISTED_FINDING")

        matching_offsets = [
            offset
            for offset in range(len(self.source) - MATCH_LENGTH + 1)
            if sha256(self.source[offset : offset + MATCH_LENGTH]) == MATCH_SHA256
        ]
        other_offsets = [
            offset for offset in matching_offsets if offset != self.entry["start"]["offset"]
        ]
        self.assertTrue(other_offsets)
        extra = copy.deepcopy(self.report)
        extra["results"].append(
            self.finding_at(other_offsets[0], other_offsets[0] + MATCH_LENGTH)
        )
        self.assert_fail(self.run_filter(report=extra), "UNLISTED_FINDING")

    def test_nonempty_and_malformed_error_collections_fail(self) -> None:
        with_errors = copy.deepcopy(self.report)
        with_errors["errors"] = [{"type": "synthetic parser error"}]
        self.assert_fail(self.run_filter(report=with_errors), "SEMGREP_ERRORS")

        bad_errors = copy.deepcopy(self.report)
        bad_errors["errors"] = {}
        self.assert_fail(self.run_filter(report=bad_errors), "INVALID_REPORT")

    def test_report_position_controls_fail(self) -> None:
        mutations: list[tuple[str, dict[str, Any]]] = []
        for name, member, value in [
            (
                "wrong line",
                ("start", "line"),
                self.finding["start"]["line"] + 1,
            ),
            (
                "wrong column",
                ("start", "col"),
                self.finding["start"]["col"] + 1,
            ),
            (
                "wrong offset",
                ("start", "offset"),
                self.finding["start"]["offset"] + 1,
            ),
            ("boolean line", ("start", "line"), True),
            ("floating column", ("start", "col"), 1.5),
            (
                "out of bounds",
                ("end", "offset"),
                len(self.source) + 1,
            ),
        ]:
            finding = copy.deepcopy(self.finding)
            finding[member[0]][member[1]] = value
            mutations.append((name, finding))

        reversed_finding = copy.deepcopy(self.finding)
        reversed_finding["end"] = copy.deepcopy(reversed_finding["start"])
        mutations.append(("reversed", reversed_finding))

        missing = copy.deepcopy(self.finding)
        del missing["start"]["col"]
        mutations.append(("missing coordinate", missing))

        unknown = copy.deepcopy(self.finding)
        unknown["end"]["byte"] = unknown["end"]["offset"]
        mutations.append(("unknown coordinate", unknown))

        for name, finding in mutations:
            with self.subTest(name=name):
                report = copy.deepcopy(self.report)
                report["results"] = [finding]
                self.assert_fail(self.run_filter(report=report))

    def test_wrong_and_cross_line_rule_spans_fail(self) -> None:
        nonmatching_offset = next(
            offset
            for offset in range(len(self.source) - MATCH_LENGTH + 1)
            if b"\n" not in self.source[offset : offset + MATCH_LENGTH]
            and sha256(self.source[offset : offset + MATCH_LENGTH]) != MATCH_SHA256
        )
        wrong_span = copy.deepcopy(self.report)
        wrong_span["results"] = [
            self.finding_at(nonmatching_offset, nonmatching_offset + MATCH_LENGTH)
        ]
        self.assert_fail(self.run_filter(report=wrong_span), "INVALID_SOURCE_SPAN")

        newline = self.source.find(b"\n")
        self.assertGreater(newline, 0)
        cross_line = copy.deepcopy(self.report)
        cross_line["results"] = [self.finding_at(newline - 1, newline + 1)]
        self.assert_fail(self.run_filter(report=cross_line), "INVALID_SOURCE_SPAN")

    def test_other_rules_are_structurally_valid_before_unlisted_rejection(self) -> None:
        newline = self.source.find(b"\n")
        finding = self.finding_at(
            newline - 1,
            newline + 1,
            rule_id="example.rules.structurally-valid",
        )
        report = copy.deepcopy(self.report)
        report["results"] = [finding]
        self.assert_fail(self.run_filter(report=report), "UNLISTED_FINDING")

    def test_exception_pin_and_coordinate_controls_fail(self) -> None:
        cases: list[tuple[str, dict[str, Any]]] = []

        wrong_source_hash = copy.deepcopy(self.policy)
        wrong_source_hash["exceptions"][0]["source_sha256"] = "0" * 64
        cases.append(("whole source hash", wrong_source_hash))

        wrong_line_hash = copy.deepcopy(self.policy)
        wrong_line_hash["exceptions"][0]["source_line_sha256"] = "0" * 64
        cases.append(("source line hash", wrong_line_hash))

        for name, member in [
            ("exception line", "line"),
            ("exception column", "col"),
            ("exception offset", "offset"),
        ]:
            policy = copy.deepcopy(self.policy)
            policy["exceptions"][0]["start"][member] += 1
            cases.append((name, policy))

        wrong_rule = copy.deepcopy(self.policy)
        wrong_rule["exceptions"][0]["rule_id"] = "example.rules.other"
        cases.append(("rule", wrong_rule))

        wrong_path = copy.deepcopy(self.policy)
        wrong_path["exceptions"][0]["path"] = "tools/other-source.ts"
        cases.append(("path", wrong_path))

        wrong_count = copy.deepcopy(self.policy)
        wrong_count["exceptions"][0]["max_count"] = 2
        cases.append(("count", wrong_count))

        boolean_count = copy.deepcopy(self.policy)
        boolean_count["exceptions"][0]["max_count"] = True
        cases.append(("boolean count", boolean_count))

        for name, policy in cases:
            with self.subTest(name=name):
                self.assert_fail(self.run_filter(policy=policy))

        self.write_source(self.source + b"\n")
        self.assert_fail(self.run_filter(), "SOURCE_HASH_MISMATCH")

    def test_exception_schema_is_closed_and_duplicate_keys_fail(self) -> None:
        unknown_entry = copy.deepcopy(self.policy)
        unknown_entry["exceptions"][0]["display_text"] = "ignored elsewhere"
        self.assert_fail(self.run_filter(policy=unknown_entry), "INVALID_EXCEPTIONS")

        unknown_root = copy.deepcopy(self.policy)
        unknown_root["comment"] = "not in the schema"
        self.assert_fail(self.run_filter(policy=unknown_root), "INVALID_EXCEPTIONS")

        empty = copy.deepcopy(self.policy)
        empty["exceptions"] = []
        self.assert_fail(self.run_filter(policy=empty), "INVALID_EXCEPTIONS")

        duplicate_policy = (
            '{"schema":"semgrep-reviewed-exceptions-v1",'
            '"schema":"semgrep-reviewed-exceptions-v1","exceptions":[]}'
        )
        self.assert_fail(
            self.run_filter(raw_policy=duplicate_policy),
            "DUPLICATE_JSON_KEY",
        )

    def test_ambiguous_exception_entries_fail(self) -> None:
        policy = copy.deepcopy(self.policy)
        duplicate = copy.deepcopy(policy["exceptions"][0])
        duplicate["id"] = "mcp-ipv6-loopback-websocket-copy"
        policy["exceptions"].append(duplicate)
        self.assert_fail(self.run_filter(policy=policy), "AMBIGUOUS_EXCEPTION")

    def test_malformed_report_shapes_and_duplicate_keys_fail(self) -> None:
        cases = [
            ("top-level list", [], None),
            ("results object", {"results": {}, "errors": []}, None),
            ("errors object", {"results": [], "errors": {}}, None),
            ("result scalar", {"results": [1], "errors": []}, None),
            (
                "missing position",
                {
                    "results": [
                        {
                            "check_id": self.entry["rule_id"],
                            "path": MCP_PATH,
                            "end": self.entry["end"],
                        }
                    ],
                    "errors": [],
                },
                None,
            ),
            (
                "non-string rule",
                {
                    "results": [
                        {
                            **copy.deepcopy(self.finding),
                            "check_id": False,
                        }
                    ],
                    "errors": [],
                },
                None,
            ),
            ("malformed JSON", None, "{"),
            (
                "duplicate JSON key",
                None,
                '{"results":[],"results":[],"errors":[]}',
            ),
            (
                "non-finite JSON value",
                None,
                '{"results":[],"errors":[],"version":NaN}',
            ),
        ]
        for name, report, raw in cases:
            with self.subTest(name=name):
                if raw is None:
                    self.assert_fail(self.run_filter(report=report))
                else:
                    self.assert_fail(self.run_filter(raw_report=raw))

    def test_unsafe_missing_symlinked_and_invalid_sources_fail(self) -> None:
        for path in [
            "/tmp/absolute.ts",
            "../outside.ts",
            "tools/../outside.ts",
            "tools//source.ts",
            r"tools\source.ts",
            "tools:source.ts",
        ]:
            with self.subTest(path=path):
                report = copy.deepcopy(self.report)
                report["results"][0]["path"] = path
                self.assert_fail(self.run_filter(report=report), "UNSAFE_SOURCE_PATH")

        self.source_path.unlink()
        self.assert_fail(self.run_filter(), "MISSING_SOURCE")

        self.write_source()
        target = self.root / "target.ts"
        target.write_bytes(self.source)
        self.source_path.unlink()
        self.source_path.symlink_to(target)
        self.assert_fail(self.run_filter(), "UNSAFE_SOURCE")

        self.write_source(b"\xff")
        self.assert_fail(self.run_filter(), "INVALID_SOURCE_ENCODING")

        self.write_source()
        real_directory = self.root / "real-directory"
        real_directory.mkdir()
        (real_directory / "mcp.ts").write_bytes(self.source)
        linked_directory = self.root / "linked-directory"
        linked_directory.symlink_to(real_directory, target_is_directory=True)
        report = copy.deepcopy(self.report)
        report["results"][0]["path"] = "linked-directory/mcp.ts"
        self.assert_fail(self.run_filter(report=report), "UNSAFE_SOURCE")

    def test_lf_line_hash_excludes_only_the_delimiter(self) -> None:
        start = self.entry["start"]["offset"]
        line_end = self.source.find(b"\n", start)
        self.assertGreater(line_end, start)
        altered = self.source[:line_end] + b"\r" + self.source[line_end:]
        self.write_source(altered)

        policy = copy.deepcopy(self.policy)
        entry = policy["exceptions"][0]
        entry["source_sha256"] = sha256(altered)
        entry["source_line_sha256"] = sha256(line_bytes_at(altered, start))
        report = copy.deepcopy(self.report)
        report["results"] = [self.finding_from_entry(entry)]
        self.assert_pass(self.run_filter(report=report, policy=policy), 1, [entry["id"]])

    def test_utf8_offsets_use_byte_columns_and_reject_codepoint_columns(self) -> None:
        old_start = self.entry["start"]["offset"]
        old_end = self.entry["end"]["offset"]
        line_start = self.source.rfind(b"\n", 0, old_start) + 1
        marker = "\u03bb".encode("utf-8")
        altered = self.source[:line_start] + marker + self.source[line_start:]
        new_start = old_start + len(marker)
        new_end = old_end + len(marker)
        self.write_source(altered)

        policy = copy.deepcopy(self.policy)
        entry = policy["exceptions"][0]
        entry["source_sha256"] = sha256(altered)
        entry["start"] = position_at(altered, new_start)
        entry["end"] = position_at(altered, new_end)
        entry["source_line_sha256"] = sha256(line_bytes_at(altered, new_start))
        report = copy.deepcopy(self.report)
        report["results"] = [self.finding_from_entry(entry)]
        self.assert_pass(self.run_filter(report=report, policy=policy), 1, [entry["id"]])

        codepoint_column = copy.deepcopy(report)
        codepoint_column["results"][0]["start"]["col"] -= len(marker) - 1
        self.assert_fail(
            self.run_filter(report=codepoint_column, policy=policy),
            "INVALID_POSITION",
        )

        split_codepoint = copy.deepcopy(report)
        split_codepoint["results"][0]["start"] = {
            "line": entry["start"]["line"],
            "col": 2,
            "offset": line_start + 1,
        }
        self.assert_fail(
            self.run_filter(report=split_codepoint, policy=policy),
            "INVALID_POSITION",
        )


if __name__ == "__main__":
    unittest.main()
