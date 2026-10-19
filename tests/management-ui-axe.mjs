import { AxeBuilder } from '@axe-core/playwright'

export async function scanPage(page) {
    return new AxeBuilder({ page }).analyze()
}
