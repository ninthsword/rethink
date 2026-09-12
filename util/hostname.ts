/** A bounded ASCII DNS name, safe as one OpenSSL subject common name. */
export function isDNSHostname(value: unknown): value is string {
    return (
        typeof value === 'string' &&
        value.length >= 1 &&
        value.length <= 253 &&
        !/[^a-z0-9.-]/i.test(value) &&
        value.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))
    )
}
