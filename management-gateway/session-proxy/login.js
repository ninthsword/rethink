const form = document.getElementById('login-form')
const password = document.getElementById('password')
const submit = document.getElementById('sign-in')
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
        location.replace(value.returnTo)
    } catch (error) {
        UI.bind(document.getElementById('login-error'), () =>
            UI.t(error.message === 'Login unavailable. Try again later.' ? error.message : 'Unable to sign in.'),
        )
        password.focus()
    } finally {
        submit.disabled = false
    }
})
