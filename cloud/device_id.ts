const MAX_DEVICE_ID_LENGTH = 128

/** Accept the identifier characters used by installed LG devices in topic/path keys. */
export function isSafeDeviceId(value: unknown): value is string {
    return (
        typeof value === 'string' &&
        value.length > 0 &&
        value.length <= MAX_DEVICE_ID_LENGTH &&
        /^[A-Za-z0-9._:-]+$/.test(value)
    )
}
