"""Synthetic status documents: no network, Docker, or appliance access."""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import unittest

SCRIPT = Path(__file__).resolve().parents[2] / 'scripts' / 'deploy-status.py'
SPEC = importlib.util.spec_from_file_location('deploy_status', SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def device(**changes):
    return dict(mode='dnat', dnatDesired=True, forwardingPaused=False, dnat='on') | changes


def status(devices=None, **changes):
    return dict(configured=True, connected=True, devices=[device()] if devices is None else devices) | changes


class ReadinessTests(unittest.TestCase):
    def test_desired_and_mode_fallback(self):
        self.assertTrue(MODULE.ready(status()))
        legacy = device()
        del legacy['mode']
        self.assertTrue(MODULE.ready(status([legacy])))
        self.assertFalse(MODULE.ready(status([legacy, device(dnat='partial')])))

    def test_desired_entries_require_forwarding_and_router(self):
        for state in ('off', 'partial', 'unknown'):
            with self.subTest(state=state):
                self.assertFalse(MODULE.ready(status([device(dnat=state)])))
        self.assertFalse(MODULE.ready(status([device(forwardingPaused=True)])))
        self.assertFalse(MODULE.ready(status(configured=False)))
        self.assertFalse(MODULE.ready(status(connected=False)))

    def test_local_disabled_and_empty_are_noops(self):
        for devices in ([], [device(mode='local', dnat='unknown')], [device(dnatDesired=False, dnat='off', forwardingPaused=True)]):
            self.assertTrue(MODULE.ready(status(devices, configured=False, connected=False)))
        self.assertTrue(MODULE.ready(status([device(), device(mode='local', dnat='unknown'), device(dnatDesired=False, dnat='off')])))
        self.assertTrue(MODULE.ready(status(unrelated={'value': 1})))

    def test_absent_desired_is_not_intent_for_local_or_legacy_entries(self):
        omitted = dict(forwardingPaused=False, dnat='unknown')
        for entry in (omitted, omitted | {'mode': 'local'}, omitted | {'mode': 'dnat'}):
            with self.subTest(entry=entry):
                self.assertTrue(MODULE.ready(status([entry], configured=False, connected=False)))
                self.assertTrue(MODULE.ready(status([entry, device()])))
                self.assertFalse(MODULE.ready(status([entry, device(dnat='off')])))
                self.assertFalse(MODULE.ready(status([entry, device()], connected=False)))
                self.assertFalse(MODULE.ready(status([entry, device()], configured=False)))
        legacy_desired = device()
        del legacy_desired['mode']
        self.assertFalse(MODULE.ready(status([omitted, legacy_desired], connected=False)))

    def test_present_nonboolean_desired_is_always_invalid(self):
        for mode in ('dnat', 'local'):
            for value in (None, 0, 1, 'true', 'false', [], {}):
                with self.subTest(mode=mode, value=value), self.assertRaises(ValueError):
                    MODULE.ready(status([device(mode=mode, dnatDesired=value)]))

    def test_partial_shapes_and_wrong_types_fail(self):
        invalid = [None, [], {}, {'devices': []}, status(devices={}), status(configured=1), status(connected='true')]
        for key in ('configured', 'connected', 'devices'):
            value = status()
            del value[key]
            invalid.append(value)
        for key in ('forwardingPaused', 'dnat'):
            entry = device()
            del entry[key]
            invalid.append(status([entry]))
        for entry in (None, [], device(mode=None), device(mode='bridge'), device(dnat='unexpected'), device(dnatDesired=1), device(forwardingPaused='false')):
            invalid.append(status([entry]))
        for value in invalid:
            with self.subTest(value=value), self.assertRaises(ValueError):
                MODULE.ready(value)

    def test_cli_fails_closed_without_echoing_document(self):
        cases = [(json.dumps(status()), 0), (json.dumps(status(connected=False)), 1), ('', 2),
                 ('{"configured":true', 2), ('{"configured":true,"configured":false}', 2),
                 ('{"extra":NaN}', 2), ('[' * 2000, 2), ('x' * (MODULE.MAX_STATUS_BYTES + 1), 2)]
        for raw, expected in cases:
            result = subprocess.run([sys.executable, '-B', str(SCRIPT)], input=raw, text=True, capture_output=True, check=False)
            self.assertEqual(result.returncode, expected)
            self.assertNotIn('configured', result.stderr)


def registered(**changes):
    return device(entryId='entry-1', ip='192.0.2.1', deviceId='device-1', platform='thinq2',
                  autoLink=True, bridgeSaved=True, bridgeArchived=False, **changes)


class ReleaseComparisonTests(unittest.TestCase):
    def test_release_requires_off_paused_and_preserved_registration(self):
        before = status([registered()])
        for state in ('on', 'partial', 'unknown'):
            self.assertFalse(MODULE.released(before, status([registered(dnat=state, forwardingPaused=True)])))
        self.assertFalse(MODULE.released(before, status([registered(dnat='off')])))
        after = status([registered(dnat='off', forwardingPaused=True)])
        self.assertTrue(MODULE.released(before, after))
        self.assertFalse(MODULE.released(before, after | {'connected': False}))
        self.assertTrue(MODULE.restored(before, before))
        self.assertFalse(MODULE.restored(before, after))

    def test_complete_identity_intent_and_saved_flags_cannot_drift(self):
        before = status([registered()])
        for key, value in [('entryId', 'other'), ('ip', '192.0.2.2'), ('deviceId', 'other'),
                           ('mode', 'local'), ('dnatDesired', False), ('bridgeSaved', False),
                           ('bridgeArchived', True), ('autoLink', False), ('platform', 'thinq1')]:
            after = status([registered(dnat='off', forwardingPaused=True) | {key: value}])
            with self.subTest(key=key), self.assertRaises(ValueError):
                MODULE.released(before, after)
            with self.assertRaises(ValueError):
                MODULE.restored(before, after)
        for key in ('entryId', 'ip', 'mode', 'bridgeSaved', 'bridgeArchived', 'dnatDesired'):
            row = registered()
            del row[key]
            with self.subTest(missing=key), self.assertRaises(ValueError):
                MODULE.released(before, status([row]))
        for rows in ([], [registered(), registered()], [registered(), registered() | {'entryId': 'two'}]):
            with self.assertRaises(ValueError):
                MODULE.released(before, status(rows))

    def test_local_zero_desired_and_omitted_intent_noop_preserve_shapes(self):
        for rows in ([], [registered(mode='local')], [registered(dnatDesired=False)]):
            before = status(rows, configured=False, connected=False)
            self.assertFalse(MODULE.has_desired(before))
            self.assertTrue(MODULE.released(before, before))
            self.assertTrue(MODULE.restored(before, before))
        row = registered()
        del row['dnatDesired']
        before = status([row], configured=False, connected=False)
        self.assertTrue(MODULE.released(before, before))
        with self.assertRaises(ValueError):
            MODULE.released(before, status([row | {'dnatDesired': False}]))

    def test_strict_comparison_rejects_incomplete_legacy_rows_without_changing_ready(self):
        self.assertTrue(MODULE.ready(status()))
        with self.assertRaises(ValueError):
            MODULE.registrations(status())
        for key, value in [('ip', 'invalid'), ('bridgeSaved', 1), ('deviceId', None), ('autoLink', 0)]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                MODULE.registrations(status([registered() | {key: value}]))

    def test_every_desired_row_and_local_mode_are_preserved(self):
        first = registered()
        second = registered() | {'entryId': 'entry-2', 'ip': '192.0.2.2', 'deviceId': 'device-2'}
        local = registered(mode='local') | {'entryId': 'entry-3', 'ip': '192.0.2.3', 'deviceId': 'device-3'}
        before = status([first, second, local])
        stopped_first = first | {'dnat': 'off', 'forwardingPaused': True}
        stopped_second = second | {'dnat': 'off', 'forwardingPaused': True}
        self.assertFalse(MODULE.released(before, status([stopped_first, second, local])))
        self.assertTrue(MODULE.released(before, status([stopped_second, local, stopped_first])))
        self.assertTrue(MODULE.restored(before, status([local, first, second])))


if __name__ == '__main__':
    unittest.main()
