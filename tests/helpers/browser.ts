import { readFileSync } from 'node:fs'
import vm from 'node:vm'

/** Minimal DOM host for executing the shipped classic scripts, not a browser renderer. */
export class Element {
    children: Element[] = []
    parent?: Element
    dataset: Record<string, string> = {}
    style: Record<string, string> = {}
    attributes: Record<string, string> = {}
    className = ''
    id = ''
    text = ''
    value = ''
    type = ''
    href = ''
    title = ''
    placeholder = ''
    disabled = false
    checked = false
    hidden = false
    open = false
    validity = { valid: true }
    onclick?: (event?: unknown) => unknown
    onchange?: () => unknown
    oncancel?: (event: { preventDefault(): void }) => unknown
    constructor(
        readonly tagName: string,
        readonly document: Document,
    ) {}
    get textContent(): string {
        return this.text + this.children.map((child) => child.textContent).join('')
    }
    set textContent(value: string) {
        this.text = String(value)
        this.children = []
    }
    get innerText() {
        return this.textContent
    }
    set innerText(value: string) {
        this.textContent = value
    }
    get innerHTML() {
        return this.textContent.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    }
    set innerHTML(value: string) {
        throw new Error(`Unexpected HTML sink: ${value.slice(0, 30)}`)
    }
    classList = {
        add: (...names: string[]) => {
            this.className = [...new Set([...this.className.split(' '), ...names])].join(' ')
        },
        remove: (...names: string[]) => {
            this.className = this.className
                .split(' ')
                .filter((name) => !names.includes(name))
                .join(' ')
        },
        toggle: (name: string, force?: boolean) => {
            const add = force ?? !this.className.split(' ').includes(name)
            if (add) this.classList.add(name)
            else this.classList.remove(name)
            return add
        },
    }
    append(...elements: Element[]) {
        for (const element of elements) {
            element.parent = this
            this.children.push(element)
        }
    }
    appendChild(element: Element) {
        this.append(element)
        return element
    }
    replaceChildren(...elements: Element[]) {
        this.children = []
        this.text = ''
        this.append(...elements)
    }
    remove() {
        if (this.parent) this.parent.children = this.parent.children.filter((element) => element !== this)
    }
    setAttribute(name: string, value: string) {
        this.attributes[name] = value
    }
    getAttribute(name: string) {
        return this.attributes[name]
    }
    focus() {
        if (!this.disabled) this.document.activeElement = this
    }
    showModal() {
        this.open = true
    }
    close() {
        this.open = false
    }
    async click() {
        if (!this.disabled) {
            this.focus()
            await this.onclick?.()
        }
    }
    async change(value?: string | boolean) {
        if (this.disabled) return
        this.focus()
        if (typeof value === 'boolean') this.checked = value
        if (typeof value === 'string') this.value = value
        await this.onchange?.()
    }
    querySelectorAll(selector: string): Element[] {
        const matches = (element: Element) =>
            selector.split(',').some((part) => {
                const target = part.trim()
                if (target.startsWith('.')) return element.className.split(' ').includes(target.slice(1))
                if (target === '[data-focus]') return !!element.dataset.focus
                if (target.startsWith('#')) return element.id === target.slice(1)
                return element.tagName.toLowerCase() === target
            })
        return this.children.flatMap((child) => [
            ...(matches(child) ? [child] : []),
            ...child.querySelectorAll(selector),
        ])
    }
    querySelector(selector: string) {
        const element = this.querySelectorAll(selector)[0]
        if (!element) throw new Error(`Missing DOM element: ${selector}`)
        return element
    }
}
class Document {
    body = new Element('BODY', this)
    activeElement: Element = this.body
    ready?: () => unknown
    constructor(html: string) {
        for (const match of html.matchAll(/<([a-z]+)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
            const element = this.createElement(match[1])
            element.id = match[2]
            if (element.id === 'toggle_router_password') element.append(this.createElement('i'))
            this.body.append(element)
        }
    }
    createElement(tag: string) {
        return new Element(tag.toUpperCase(), this)
    }
    createTextNode(text: string) {
        const element = this.createElement('#text')
        element.textContent = text
        return element
    }
    getElementById(id: string) {
        return this.body.querySelector(`#${id}`)
    }
    querySelectorAll(selector: string) {
        return this.body.querySelectorAll(selector)
    }
    addEventListener(event: string, action: () => unknown) {
        if (event === 'DOMContentLoaded') this.ready = action
    }
}
export class Socket {
    static all: Socket[] = []
    onmessage?: (event: { data: string }) => void
    onclose?: () => void
    constructor(readonly url: string) {
        Socket.all.push(this)
    }
    close() {
        this.onclose?.()
    }
    sendStatus(status: object) {
        this.onmessage?.({ data: JSON.stringify(status) })
    }
}
export function response(body: unknown = {}, status = 200) {
    return {
        ok: status < 300,
        status,
        json: async () => body,
        text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    }
}
export async function browser(
    page: 'panel' | 'router',
    fetcher: (path: string, options: Record<string, unknown>) => Promise<ReturnType<typeof response>> = async () =>
        response(),
) {
    Socket.all = []
    const document = new Document(readFileSync(`html/${page === 'panel' ? 'index' : 'router'}.html`, 'utf8'))
    const timers: Array<() => unknown> = []
    const modals: string[] = []
    const context = vm.createContext({
        document,
        HTMLElement: Element,
        HTMLInputElement: Element,
        URL,
        console,
        window: { location: { href: `http://management.example/${page === 'panel' ? '' : 'router.html'}` }, open() {} },
        WebSocket: Socket,
        fetch: (url: URL, options: Record<string, unknown> = {}) => fetcher(new URL(String(url)).pathname, options),
        setTimeout: (action: () => unknown) => {
            timers.push(action)
            return timers.length
        },
        setInterval: (action: () => unknown) => {
            timers.push(action)
            return timers.length
        },
        clearTimeout() {},
        confirm: () => true,
        prompt: () => null,
        M: {
            Modal: {
                init() {},
                getInstance: (element: Element) => ({ open() {}, close: () => modals.push(element.id) }),
            },
            updateTextFields() {},
        },
    })
    vm.runInContext(readFileSync(`html/${page}.js`, 'utf8'), context)
    await document.ready?.()
    return {
        document,
        timers,
        modals,
        evaluate: (source: string) => vm.runInContext(source, context),
        sockets: Socket.all,
    }
}
export async function settle() {
    for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve))
}
