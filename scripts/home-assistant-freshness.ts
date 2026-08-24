/**
 * Publication-age evidence only applies to handlers that actively poll for a full state
 * refresh. Push-only protocols legitimately publish nothing while an appliance is idle;
 * their connection and retained availability are the evidence available to this check.
 */
export const POLLED_PROTOCOL_STALE_MINUTES = 45

export type PublicationEvidence = {
    periodicRefreshSeen: boolean
    quietForMinutes?: number
}

export function stalePublicationReason({ periodicRefreshSeen, quietForMinutes }: PublicationEvidence) {
    if (!periodicRefreshSeen || quietForMinutes === undefined) return undefined
    if (quietForMinutes < POLLED_PROTOCOL_STALE_MINUTES) return undefined
    return `nothing published for ${quietForMinutes} minutes despite periodic refresh queries`
}
