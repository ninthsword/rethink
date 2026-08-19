import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { delocalizeValue, localizeValue } from '@/util/ha_locale'

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

    test('keeps the air purifier sleep timer distinct from the washer dry level', () => {
        // Both would render as "30분" if the dry level were not disambiguated, which
        // would make the reverse map send a dry-level token to the sleep timer select.
        assert.equal(localizeValue('30_minutes', 'korean'), '30분')
        assert.equal(delocalizeValue('30분', 'korean'), '30_minutes')
        assert.equal(delocalizeValue('30분 건조', 'korean'), '30_MIN')
    })
})
