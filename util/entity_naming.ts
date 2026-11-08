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
 * `default_entity_id` is the discovery field that decides it instead. Its value is
 * `<platform>.<id>`, and the id here is built from the appliance's own name and rethink's
 * component key so it does not move when the display language changes and can be traced back
 * to the handler that publishes it.
 *
 * It applies only when Home Assistant creates the entity: a unique_id already in the registry
 * keeps the id it has, however often it is rediscovered, and only a deleted entity that comes
 * back takes this one. So it is published only once the appliance's registered name is known;
 * rethink never builds one from a model-default name, which is what produced _2 and _3 above.
 * An appliance first discovered without a registered name keeps Home Assistant's own fallback.
 *
 * The `rethink_` prefix is not decoration. The same appliances also exist under the
 * official lg_thinq integration and under ha-smartthinq-sensors, and a registry entry holds
 * its id even while its device is disabled — climate.geosileeokeon is taken by an appliance
 * that has published nothing for months. Without the prefix Home Assistant would resolve
 * the collision by appending _2 again.
 *
 * Korean goes in as Korean: Home Assistant slugifies the id the same way it already
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

/** The id after the dot of one component's default_entity_id, or undefined if it should be left alone. */
export function entityObjectId(deviceName: string, componentKey: string, platform: string) {
    if (!deviceName) return undefined
    return MAIN_ENTITY[componentKey] === platform
        ? `${NAME_PREFIX}_${deviceName}`
        : `${NAME_PREFIX}_${deviceName}_${componentKey}`
}

/**
 * Give every component in a discovery payload its default_entity_id. Call this only when
 * config.device.name is the appliance's registered name.
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
        if (typeof component.default_entity_id === 'string') continue

        const platform = String(component.platform)
        const objectId = entityObjectId(deviceName, key, platform)
        if (objectId) component.default_entity_id = `${platform}.${objectId}`
    }
}
