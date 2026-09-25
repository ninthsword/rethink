const form = document.getElementById('login-form')
const password = document.getElementById('password')
const submit = document.getElementById('sign-in')
function sameOriginDestination(value) {
    if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//'))
        throw new Error('Unable to sign in.')
    const destination = new URL(value, location.origin)
    if (!['http:', 'https:'].includes(destination.protocol) || destination.origin !== location.origin)
        throw new Error('Unable to sign in.')
    return destination.pathname + destination.search + destination.hash
}
form.addEventListener('submit', async (event) => {
    event.preventDefault()
    if (submit.disabled || !form.reportValidity()) return
    submit.disabled = true
    try {
        const response = await fetch('/__management/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: document.getElementById('username').value,
                password: password.value,
                returnTo: new URLSearchParams(location.search).get('returnTo'),
            }),
        })
        password.value = ''
        if (!response.ok)
            throw new Error(response.status === 429 ? 'Login unavailable. Try again later.' : 'Unable to sign in.')
        const value = await response.json()
        location.replace(sameOriginDestination(value.returnTo))
    } catch (error) {
        UI.bind(document.getElementById('login-error'), () =>
            UI.t(error.message === 'Login unavailable. Try again later.' ? error.message : 'Unable to sign in.'),
        )
        password.focus()
    } finally {
        submit.disabled = false
    }
})
