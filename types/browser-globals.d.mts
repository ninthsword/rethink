// Materialize APIs used by the classic management pages (loaded from their HTML).
export {}

declare global {
    const UI: {
        t(key: string, parameters?: unknown[]): string
        diagnostic(value: unknown, context?: string): string
        bind(element: Node, read: () => string, attribute?: string): Node
        textNode(read: () => string): Node
        readonly locale: string
        date(value: string | number): string
        time(value: string | number): string
        onChange(listener: () => void): void
        allowed(): boolean
    }

    const M: {
        Tooltip: { init(elements: Element | NodeListOf<Element>): unknown }
        Modal: {
            init(elements: NodeListOf<Element>): unknown
            getInstance(element: Element): { open(): void; close(): void }
        }
        FormSelect: { init(elements: HTMLSelectElement | NodeListOf<HTMLSelectElement>): unknown }
        Autocomplete: {
            init(elements: NodeListOf<Element>, options: { data: Record<string, string | null> }): unknown
        }
        updateTextFields(): void
        toast(options: { html: string }): unknown
    }
}
