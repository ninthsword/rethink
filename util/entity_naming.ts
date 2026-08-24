import type { DeviceDiscovery } from '@/cloud/homeassistant'

/**
 * What an appliance's entities are called in Home Assistant.
 *
 * Home Assistant builds an entity_id once, when it first sees the entity, from the device
 * name and the entity name — and never rebuilds it. That is how this install ended up with
 * 127 entity ids derived from the English model name and 41 from the Korean appliance name,
 * depending only on which side of the switch to Korean discovery each one was created on.
 * Worse, all three air conditioners derived theirs from the same model default, so they
 * became lg_air_conditioner, _2 and _3 with nothing to say which room is which.
 *
 * `object_id` is the discovery field that is meant to decide it instead, and the name here is
 * built from the appliance's own name and rethink's component key so it does not move when the
 * display language changes and can be traced back to the handler that publishes it.
 *
 * It does not currently work. Every entity Home Assistant created after this began publishing
 * — seven of them, across four appliances and three separate deploys — still took the
 * `<area>_<device>_<entity name>` fallback, and every id that does follow the rule predates it
 * and got there through a registry rename. Device-based discovery evidently ignores the field
 * in the Home Assistant this install runs. Publishing it costs nothing and would start working
 * if that changes, but a newly added component still needs its id renamed in the registry.
 *
 * The `rethink_` prefix is not decoration. The same appliances also exist under the
 * official lg_thinq integration and under ha-smartthinq-sensors, and a registry entry holds
 * its id even while its device is disabled — climate.geosileeokeon is taken by an appliance
 * that has published nothing for months. Without the prefix Home Assistant would resolve
 * the collision by appending _2 again.
 *
 * Korean goes in as Korean: Home Assistant slugifies object_id the same way it already
 * slugifies the device name, so 거실에어컨 becomes geosileeokeon here exactly as it does
 * everywhere else in this install. There is no transliteration table to keep in step.
 */
const NAME_PREFIX = 'rethink'

/**
 * Component keys that name the appliance itself rather than one of its readings. Repeating
 * them would give climate.rethink_anbangeeokeon_climate, which says nothing twice.
 */
const MAIN_ENTITY: Record<string, string> = {
    climate: 'climate',
    dehumidifier: 'humidifier',
}

/** The object_id for one component, or undefined if it should be left alone. */
export function entityObjectId(deviceName: string, componentKey: string, platform: string) {
    if (!deviceName) return undefined
    return MAIN_ENTITY[componentKey] === platform
        ? `${NAME_PREFIX}_${deviceName}`
        : `${NAME_PREFIX}_${deviceName}_${componentKey}`
}

/**
 * Give every component in a discovery payload its object_id.
 *
 * A component carrying nothing but `platform` is a retirement notice — the way a device
 * tells Home Assistant that a component is gone. Adding a second key to one would stop it
 * being recognised as a removal, so those are left exactly as they are.
 */
export function nameEntities(config: DeviceDiscovery) {
    const deviceName = config.device?.name
    if (!deviceName) return

    for (const [key, component] of Object.entries(config.components ?? {}) as Array<
        [string, Record<string, unknown>]
    >) {
        if (!component || typeof component !== 'object') continue
        if (Object.keys(component).length === 1 && 'platform' in component) continue
        if (typeof component.object_id === 'string') continue

        const objectId = entityObjectId(deviceName, key, String(component.platform))
        if (objectId) component.object_id = objectId
    }
}
