let filter = (_: string) => true

export default function log(topic: string, ...args: unknown[]) {
    if (filter(topic)) console.log(new Date(), topic, ...args)
}

export function setFilter(newFilter: (_: string) => boolean) {
    filter = newFilter
}
