// Materialize APIs used by the classic management pages (loaded from their HTML).
export {}

declare global {
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
