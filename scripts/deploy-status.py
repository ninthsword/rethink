"""Validate a router status response without contacting a router or changing state."""
from __future__ import annotations

import ipaddress
import json
from pathlib import Path
import sys
from typing import Any

MAX_STATUS_BYTES = 1024 * 1024


def unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('Duplicate status field')
        result[key] = value
    return result


def invalid_constant(_value: str) -> None:
    raise ValueError('Nonfinite status value')


def ready(status: object) -> bool:
    """Require all desired DNAT entries on and unpaused; zero desired is a no-op."""
    if not isinstance(status, dict):
        raise ValueError('Status must be an object')
    if any(type(status.get(key)) is not bool for key in ('configured', 'connected')):
        raise ValueError('Missing or invalid router readiness flags')
    devices = status.get('devices')
    if not isinstance(devices, list):
        raise ValueError('Missing or invalid devices')
    desired = []
    for device in devices:
        if not isinstance(device, dict):
            raise ValueError('Invalid device')
        mode = device.get('mode', 'dnat')
        if mode not in ('dnat', 'local'):
            raise ValueError('Invalid device mode')
        dnat_desired = device.get('dnatDesired', False)
        if type(dnat_desired) is not bool or type(device.get('forwardingPaused')) is not bool:
            raise ValueError('Missing or invalid device readiness flags')
        if device.get('dnat') not in ('on', 'off', 'partial', 'unknown'):
            raise ValueError('Missing or invalid DNAT state')
        if mode == 'dnat' and dnat_desired:
            desired.append(device)
    return not desired or (
        status['configured'] and status['connected']
        and all(device['dnat'] == 'on' and not device['forwardingPaused'] for device in desired)
    )


REGISTRATION_FIELDS = ('entryId', 'ip', 'deviceId', 'autoLink', 'detectedName', 'customName',
                       'platform', 'mode', 'dnatDesired', 'bridgeSaved', 'bridgeArchived')


def registrations(status: object) -> dict[str, dict[str, Any]]:
    """Strict comparison contract; ready() retains its independent legacy input contract."""
    ready(status)
    assert isinstance(status, dict)
    result: dict[str, dict[str, Any]] = {}
    addresses: set[str] = set()
    linked: set[str] = set()
    for device in status['devices']:
        for name in ('entryId', 'ip'):
            if not isinstance(device.get(name), str) or not 0 < len(device[name]) <= 256:
                raise ValueError('Missing registration identity')
        if not isinstance(ipaddress.ip_address(device['ip']), ipaddress.IPv4Address):
            raise ValueError('Invalid registration address')
        if device['entryId'] in result or device['ip'] in addresses:
            raise ValueError('Duplicate registration identity')
        addresses.add(device['ip'])
        if device.get('mode') not in ('local', 'dnat'):
            raise ValueError('Missing registration mode')
        for name in ('bridgeSaved', 'bridgeArchived'):
            if type(device.get(name)) is not bool:
                raise ValueError('Missing saved registration flags')
        if 'autoLink' in device and type(device['autoLink']) is not bool:
            raise ValueError('Invalid registration flag')
        for name in ('deviceId', 'detectedName', 'customName'):
            if name in device and (not isinstance(device[name], str) or len(device[name]) > 1024):
                raise ValueError('Invalid registration field')
        if 'deviceId' in device:
            if not device['deviceId'] or device['deviceId'] in linked:
                raise ValueError('Duplicate linked registration')
            linked.add(device['deviceId'])
        if 'platform' in device and device['platform'] not in ('thinq1', 'thinq2'):
            raise ValueError('Invalid registration platform')
        result[device['entryId']] = {key: device[key] for key in REGISTRATION_FIELDS if key in device}
    return result


def has_desired(status: object) -> bool:
    registrations(status)
    assert isinstance(status, dict)
    return any(row['mode'] == 'dnat' and row.get('dnatDesired', False) for row in status['devices'])


def released(baseline: object, current: object) -> bool:
    if registrations(baseline) != registrations(current):
        raise ValueError('Registration changed during release')
    assert isinstance(current, dict)
    if not has_desired(baseline):
        return True
    return current['configured'] and current['connected'] and all(
        row['dnat'] == 'off' and row['forwardingPaused']
        for row in current['devices'] if row['mode'] == 'dnat' and row.get('dnatDesired', False))


def restored(baseline: object, current: object) -> bool:
    if registrations(baseline) != registrations(current):
        raise ValueError('Registration changed during replacement')
    return ready(current)


def parse(raw: bytes) -> object:
    if len(raw) > MAX_STATUS_BYTES:
        raise ValueError('Status response too large')
    return json.loads(raw, object_pairs_hook=unique_object, parse_constant=invalid_constant)


def main() -> int:
    try:
        status = parse(sys.stdin.buffer.read(MAX_STATUS_BYTES + 1))
        args = sys.argv[1:]
        if not args:
            result = ready(status)
        elif args == ['snapshot']:
            registrations(status)
            result = True
        elif args == ['has-desired']:
            result = has_desired(status)
        elif len(args) == 2 and args[0] in ('released', 'restored'):
            with Path(args[1]).open('rb') as stream:
                baseline = parse(stream.read(MAX_STATUS_BYTES + 1))
            result = released(baseline, status) if args[0] == 'released' else restored(baseline, status)
        else:
            raise ValueError('Invalid status command')
        if not result:
            return 1
    except (ValueError, TypeError, RecursionError, OSError):
        print('Invalid router status response', file=sys.stderr)
        return 2
    print('Router status satisfies the requested deployment phase.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
