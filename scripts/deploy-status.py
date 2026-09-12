"""Validate a router status response without contacting a router or changing state."""
from __future__ import annotations

import json
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


def main() -> int:
    try:
        raw = sys.stdin.buffer.read(MAX_STATUS_BYTES + 1)
        if len(raw) > MAX_STATUS_BYTES:
            raise ValueError('Status response too large')
        status = json.loads(raw, object_pairs_hook=unique_object, parse_constant=invalid_constant)
        if not ready(status):
            return 1
    except (ValueError, TypeError, RecursionError):
        # Status documents may contain private router/device details; never echo them.
        print('Invalid router status response', file=sys.stderr)
        return 2
    print('Desired DNAT forwarding is ready (or no DNAT entries are desired).')
    return 0


if __name__ == '__main__':
    sys.exit(main())
