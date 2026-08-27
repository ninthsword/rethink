import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { DeviceDiscovery } from '@/cloud/homeassistant'
import { delocalizeValue, localizeDiscovery, localizeValue } from '@/util/ha_locale'

describe('korean appliance value localization', () => {
    test('translates the washer course, water temperature and dry level tokens', () => {
        // These are the values F21VDT_AKOR publishes on course/downloaded_course/
        // operation_course, water_temp and dry_level. They previously reached Home
        // Assistant untranslated because the table had no entry for them.
        const expected: Record<string, string> = {
            NONE: '없음',
            SMALL_LOAD: '소량 세탁',
            SPEEDWASH: '스피드 워시',
            SOAKING: '불림',
            NO_ERROR: '오류 없음',
            WIND: '바람 건조',
            TURBO: '터보',
            '30_C': '30°C',
            '95_C': '95°C',
            '30_MIN': '30분 건조',
            '150_MIN': '150분 건조',
        }

        for (const [value, korean] of Object.entries(expected))
            assert.equal(localizeValue(value, 'korean'), korean, value)
    })

    test('leaves the same values untouched in english', () => {
        assert.equal(localizeValue('SMALL_LOAD', 'english'), 'SMALL_LOAD')
        assert.equal(localizeValue('30_MIN', undefined), '30_MIN')
    })

    test('translates confirmed dishwasher labels and course values', () => {
        const expected: Record<string, string> = {
            SOAK: '불림',
            NORMAL: '표준',
            STEAM_TUB_CLEAN: '스팀통살균',
            STEAM_REFRESH: '스팀리프레시',
            disabled: '꺼짐',
            UPPER: '위',
            LOWER: '아래',
        }
        for (const [value, korean] of Object.entries(expected))
            assert.equal(localizeValue(value, 'korean'), korean, value)

        const config = {
            device: { name: 'LG Dishwasher' },
            components: {
                stored: { platform: 'sensor', name: 'Stored download course' },
                chime: { platform: 'binary_sensor', name: 'Product chime' },
                reminder: { platform: 'binary_sensor', name: 'Tub sterilization reminder' },
                display: { platform: 'binary_sensor', name: 'Front time display' },
                rinse: { platform: 'sensor', name: 'Rinse aid level' },
                hardness: { platform: 'sensor', name: 'Water hardness level' },
                dual: { platform: 'binary_sensor', name: 'Dual zone' },
                half: { platform: 'sensor', name: 'Half load zone' },
                extra: { platform: 'binary_sensor', name: 'Safe rinse' },
                washer_extra: { platform: 'binary_sensor', name: 'Extra rinse' },
                steam: { platform: 'binary_sensor', name: 'Steam' },
                sanitize: { platform: 'binary_sensor', name: 'High temperature sanitize' },
                dry: { platform: 'binary_sensor', name: 'High temperature dry' },
                lock: { platform: 'binary_sensor', name: 'Control lock' },
                delay: { platform: 'binary_sensor', name: 'Delay active' },
            },
        } as unknown as DeviceDiscovery
        const localized = localizeDiscovery(config, 'korean').components as Record<string, Record<string, unknown>>
        assert.deepEqual(
            Object.values(localized).map((component) => component.name),
            [
                '저장된 다운로드 코스',
                '제품 알림음',
                '통살균 알림등',
                '전면 시간 표시',
                '린스 투입량',
                '물 경도 레벨',
                '듀얼존',
                '부분세척',
                '안심헹굼',
                '추가 헹굼',
                '스팀',
                '고온살균',
                '고온건조',
                '버튼잠금',
                '예약 활성',
            ],
        )
    })

    test('translates confirmed dryer panel labels and tub sterilization', () => {
        const expected: Record<string, string> = {
            SELFCLEANING: '통살균',
            DAMP: '섬세',
            LESS: '약',
            IRON: '표준',
            CUPBOARD: '표준+',
            VERY_DRY: '강력',
            ENERGY: '에너지',
            SPEED: '스피드',
            TIMEDRY: '시간건조',
            CONDENSERCARE: '콘덴서 케어',
            COOLAIR: '송풍',
            WARMAIR: '온풍',
            TURBO: '터보',
        }
        for (const [value, korean] of Object.entries(expected))
            assert.equal(localizeValue(value, 'korean'), korean, value)

        const config = {
            device: { name: 'LG Dryer' },
            components: {
                eco_hybrid: { platform: 'sensor', name: 'eco_hybrid' },
                other_model_eco_hybrid: { platform: 'sensor', name: 'EcoHybrid' },
                anti_crease: { platform: 'binary_sensor', name: 'Anti crease' },
                smart_care: { platform: 'binary_sensor', name: 'Smart Care' },
                reservation: { platform: 'binary_sensor', name: 'Reservation active' },
            },
        } as unknown as DeviceDiscovery
        const localized = localizeDiscovery(config, 'korean').components as Record<string, Record<string, unknown>>
        assert.deepEqual(
            Object.values(localized).map((component) => component.name),
            ['절약건조', '에코 하이브리드', '구김 방지', '스마트케어', '예약 활성'],
        )
    })

    test('leaves a climate entity its Home Assistant HVAC modes', () => {
        // Home Assistant accepts only its own HVAC modes here and drops the rest, so a
        // translated "off" left the air conditioners with no way to be turned off.
        const config = {
            device: { name: 'x' },
            components: {
                climate: {
                    platform: 'climate',
                    modes: ['off', 'cool', 'dry', 'fan_only', 'heat', 'auto'],
                    swing_modes: ['off', 'swing', 'position_1'],
                    fan_modes: ['level_1', 'natural'],
                },
            },
        } as unknown as DeviceDiscovery
        const localized = localizeDiscovery(config, 'korean').components.climate as Record<string, unknown>

        assert.deepEqual(localized.modes, ['off', 'cool', 'dry', 'fan_only', 'heat', 'auto'])
        // The other lists are free text the appliance and Rethink agree on, so they do
        // get translated — including the same "off" token.
        assert.deepEqual(localized.swing_modes, ['꺼짐', '회전', '위치1'])
        assert.deepEqual(localized.fan_modes, ['1단', '자연풍'])
    })

    test('still translates the modes of entities that name their own', () => {
        // A humidifier's modes are names we chose, not a Home Assistant enumeration.
        const config = {
            device: { name: 'x' },
            components: {
                dehumidifier: { platform: 'humidifier', modes: ['smart', 'fast', 'silent'] },
            },
        } as unknown as DeviceDiscovery
        const localized = localizeDiscovery(config, 'korean').components.dehumidifier as Record<string, unknown>
        assert.deepEqual(localized.modes, ['스마트', '쾌속', '저소음'])
    })

    test('translates the WINF AI dry entity and its options', () => {
        const config = {
            device: { name: 'LG Air Conditioner' },
            components: {
                ai_dry_strength: {
                    platform: 'select',
                    name: 'AI dry strength',
                    options: ['weak_wind', 'medium_wind', 'strong_wind'],
                },
            },
        } as unknown as DeviceDiscovery

        const localized = localizeDiscovery(config, 'korean').components.ai_dry_strength as Record<string, unknown>
        assert.equal(localized.name, 'AI건조 바람 세기')
        assert.deepEqual(localized.options, ['약풍', '중풍', '강풍'])
    })

    test('keeps the air purifier sleep timer distinct from the washer dry level', () => {
        // Both would render as "30분" if the dry level were not disambiguated, which
        // would make the reverse map send a dry-level token to the sleep timer select.
        assert.equal(localizeValue('30_minutes', 'korean'), '30분')
        assert.equal(delocalizeValue('30분', 'korean'), '30_minutes')
        assert.equal(delocalizeValue('30분 건조', 'korean'), '30_MIN')
    })
})
