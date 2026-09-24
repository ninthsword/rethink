# Standalone management gateway

This gateway adds HTTPS and one HTTP Basic account (`admin`) to the existing loopback Rethink service. It runs a separate, pinned nginx container named `rethink-management-gateway`; the production upstream is fixed at `127.0.0.1:44401`. It does not initialize, modify, or restart the backend.

The container uses the current non-root UID/GID, host networking, an exact RFC1918 IPv4 listener, a read-only root filesystem and state mount, a bounded temporary filesystem, no added capabilities, and no-new-privileges. The image is pinned to `nginx@sha256:dc5069ad14f19660b141b21236140b91656bf89bbc3e2417c70ae650cd66104c`; commands use `--pull never`. Install that exact image beforehand. Docker access, Python 3, and OpenSSL are required. Password provisioning uses `htpasswd` bcrypt cost 12 when available; otherwise Python 3.12's platform `crypt` supports SHA-512 crypt with 200,000 rounds. Python versions without `crypt` require supported `htpasswd` tooling. No plaintext password is passed in command arguments or printed.

## Provision and operate

Choose a private state directory outside the source checkout, under an existing trusted parent. Supply the actual management IP and a port from 1024 through 65535 locally. The listener accepts no hostname, wildcard, public address, loopback production listener, IPv6, privileged port, or HTTP fallback. An optional separate external DNS identity is described below.

```sh
python3 -B management-gateway/gateway.py --state "$GATEWAY_STATE" init --listen "$GATEWAY_LISTEN"
python3 -B management-gateway/gateway.py --state "$GATEWAY_STATE" check
python3 -B management-gateway/gateway.py --state "$GATEWAY_STATE" start
```

`init` exclusively creates new state. Existing or incomplete state is never overwritten. State directories must be owner-only mode 0700 and every file mode 0600, owned by the invoking user; symlinks, hard links, unsafe ancestors and unexpected runtime files are refused. Operations on an existing state directory are serialized with an advisory lock. Initialization failure retains incomplete state for operator inspection.

Initialization creates a dedicated 10-year management CA, a 365-day server certificate with the chosen IP SAN, a server key, and a random 256-bit password. The password is delivered only through the private `password.txt` file. Keep the state directory and backups private and outside Git. Only the runtime subdirectory containing the server certificate/key, password hash and nginx configuration is mounted into nginx; the CA signing key and plaintext delivery file are not mounted.

Transfer **only `ca.crt`** through a trusted channel and install it in the intended client's trusted certificate authorities using that client's certificate manager. Verify the CA fingerprint locally before trusting it:

```sh
openssl x509 -in "$GATEWAY_STATE/ca.crt" -noout -fingerprint -sha256
```

Open `https://<configured-ip>:<configured-port>/` and use the browser's Basic authentication dialog with `admin` and the privately delivered password. Certificate warnings are a setup failure; do not bypass certificate verification. Do not import `ca.key`, `tls.key`, or the password file. CA trust is a client-side operation and is never installed by this helper. In LAN-only mode the certificate identifies only the IP; optional DNS identity is described below.

```sh
python3 -B management-gateway/gateway.py --state "$GATEWAY_STATE" rotate-password
python3 -B management-gateway/gateway.py --state "$GATEWAY_STATE" stop
```

Rotation retains owner-only copies of the previous password and hash, stops/removes only the identified gateway, atomically installs new credential files, and starts it again only if previously running. Stopping closes existing authenticated WebSockets. A failed rotation/start leaves private state available for recovery; there is no automatic rollback to weaker or old credentials. Browsers may cache Basic credentials and have no application logout button; after rotation, close/reopen the management browser context and provide the new password.

`check` validates private state, generated policy, credential format, certificate trust/IP/expiry and matching key, container identity if present, and nginx syntax in a temporary network-isolated container. `start` additionally checks the exact bind and verifies TLS readiness without sending a backend HTTP request. Expiry within 24 hours blocks startup. To renew certificates, stop the old gateway, provision a new private state directory, install its new dedicated CA on clients, and start that new gateway. Preserve old state until the new setup is verified. No automatic certificate renewal or client trust modification is included.

Because `nginx -t` attempts to bind the configured address, the temporary `--rm --network none` syntax container alone receives `--sysctl net.ipv4.ip_nonlocal_bind=1` in its isolated network namespace. Its hardening and generated configuration remain unchanged. No host sysctl or production-container setting is changed; unsupported Docker/kernel behavior fails closed. Syntax success does not establish host address availability: the normal production bind probe and TLS readiness check still do that work. The regression uses production validation with a synthetic RFC1918 address, verifies explicit `nonlocal_bind=0` failure and `=1` success, and asserts unchanged state/source, unchanged production arguments and container cleanup without starting a production gateway.

Lifecycle commands refuse a same-name container unless its ownership label, image reference, user, entrypoint/command, network, security settings, mount and temporary filesystem match this helper. A conflict requires operator investigation; the helper never adopts or replaces an unrelated container. Only the exact inspected gateway container ID is stopped/removed. The helper does not change firewall/router rules, publish a public port, or control appliances.

## Optional existing Nginx Proxy Manager ingress

An existing NPM HTTPS route can forward to the gateway while preserving the LAN listener. Provision exactly one external identity privately at initialization:

```sh
python3 -B management-gateway/gateway.py --state "$GATEWAY_STATE" init --listen "$GATEWAY_LISTEN" --external-hostname "$GATEWAY_EXTERNAL_HOSTNAME"
```

The hostname must be a canonical lowercase ASCII DNS name, without a scheme, port, path, wildcard, IP address or trailing dot. Production external HTTPS always uses port 443; there is no public-port setting or environment override. The optional `external_hostname` exists only in private settings. Omitting it preserves the original four-key metadata and byte-identical LAN nginx policy. Existing state is not overwritten: to add the DNS identity, stop the owned gateway and provision a new private state directory, then update the intended clients' and selected NPM route's CA trust.

The management leaf contains exactly the listener IP SAN and, when configured, that single DNS SAN. It remains separate from NPM's existing public certificate. Keep the same public certificate and WebSocket support on the selected NPM route; set its upstream scheme to HTTPS and forward to the configured gateway IP/port. Enable Force SSL on that route. Copy only the public management `ca.crt` into the intended persistent NPM CA path; never copy the CA key, server key or credentials. Configure these per-host advanced directives, replacing the synthetic hostname with the private configured identity:

```nginx
proxy_ssl_verify on;
proxy_ssl_trusted_certificate /config/nginx/custom/rethink-management-ca.crt;
proxy_ssl_verify_depth 2;
proxy_ssl_server_name on;
proxy_ssl_name management.example.test;
```

These server-level settings must inherit into the upstream location without overrides. The supported NPM proxy contract preserves public `Host` using `$host`, original Origin/Fetch/Authorization headers, WebSocket upgrade headers and the upstream Basic challenge; its upstream request URI remains unchanged. Do not rewrite Origin to the LAN URL, install a blanket TLS bypass, or trust forwarded headers as client identity. Verify the actual selected route after activation; the synthetic tests do not prove a live NPM configuration is installed.

Each accepted Host has its own Origin: the literal LAN IP:port accepts only its LAN HTTPS Origin, while the configured hostname or hostname:443 accepts only canonical `https://hostname`. Cross-pairs are rejected, as are unexpected authorities and ports. Ordinary read-only navigation may omit Origin; writes, WebSockets, login metadata and cross-site protections remain unchanged. Validated canonical authority and HTTPS forwarding headers reach the backend; Basic credentials are stripped there.

NPM is the gateway's actual socket peer. All external clients behind it share one per-peer request/connection bucket; spoofed forwarding headers cannot create additional buckets. NPM's existing public-facing policies remain separate. Stopping or rotating the gateway closes authenticated WebSockets through both routes and does not restart NPM or the backend. This helper does not configure NPM, replace its public certificate, or change HA.

## Browser policy and operational limits

Authentication covers every proxied route, including unknown paths, API endpoints and WebSocket upgrades. The backend never receives Basic or Proxy-Authorization credentials. Standard client forwarding headers are removed or replaced from the actual socket peer and configured authority. nginx logs contain status codes only; backend logging remains the backend's responsibility.

In LAN-only mode, Host must exactly match the configured IP and port. Foreign or `null` Origin and cross-site/same-site fetch metadata are rejected, including when the browser has cached credentials. Writes and WebSocket upgrades require the exact HTTPS Origin. Initial ordinary read-only navigation may omit Origin. The state-changing `/thinq_login` route, including case, trailing-slash, percent-normalized and HEAD variants, requires same-origin fetch metadata; open the login popup from the management page. Direct bookmarks to that login route and cross-site navigation are intentionally rejected. The upstream OAuth provider's external login process is outside synthetic coverage and must be assessed separately before relying on it.

Per-peer request limits allow 10 requests/second with a burst of 60; the gateway-wide limit is 30/second with a burst of 100. Concurrent processed connections are limited to 32 per peer and 128 globally. Excess requests return 429. Keys use the actual remote peer, unaffected by forwarded headers. These limits bound sustained guessing and allow page-load bursts; they are not account lockout. Header timeout is 10 seconds, body limit 2 MiB, and established WebSocket read timeout one hour. Multiple clients behind one translated address share its limits.

## Isolated tests

All tests create only a synthetic loopback HTTP/WebSocket backend and a uniquely named test gateway. Production listener/backend overrides are unavailable in the CLI. The Python test fixture explicitly overrides them in memory, owns its temporary state and containers, and cleans them up. Unit tests need no Docker. Integration tests require the exact preinstalled image and Docker access; missing prerequisites fail rather than silently skip.

The acceptance command runs unit checks, expanded integration scenarios, and trusted Chromium sequentially. A failed phase stops the sequence with a nonzero exit; source file contents and modes must remain identical across the run. It requires all integration and browser prerequisites below.

```sh
python3 -B management-gateway/tests/integration.py --acceptance
```

Individual commands remain available for diagnosis; their exit status alone does not establish combined coverage:

```sh
python3 -B management-gateway/tests/integration.py --unit
python3 -B management-gateway/tests/integration.py --integration
node management-gateway/tests/browser.mjs
```

The browser command independently starts/stops its Python fixture. Supply `PLAYWRIGHT_MODULE` (package directory or module file), `CHROMIUM_EXECUTABLE`, and `CERTUTIL_BIN` when they are not available through normal package/browser/PATH lookup. `PYTHON_BIN` optionally selects the Python executable. The browser fixture creates a temporary HOME and NSS database, trusts only its generated test CA there, and removes them afterward. It never changes the owner's trust store and does not use `ignoreHTTPSErrors`, certificate-error flags, or disabled TLS verification.

Integration coverage includes all-route denial with unchanged backend counters, wrong credentials, origin/Host/metadata/login aliases, trusted and untrusted TLS, header sanitization, WebSocket echo, the production-profile request flood, rotation closing existing sockets, credential invalidation, and immutable initialization.

Four fresh-fixture tests isolate per-peer request rate, global request rate, per-peer concurrent WebSockets, and global concurrent WebSockets. They bind real distinct loopback source addresses and spoof forwarding headers, hold authenticated WebSockets open, verify rejected requests do not reach the backend, and verify held sockets remain usable and released slots recover. Only internal constants in the test process are patched to reduced thresholds; CLI, environment and settings provide no limiter override. A unit assertion checks all six production defaults and generated directives. These tests establish the limiter mechanisms at reduced thresholds; they do not claim that 32/128 simultaneous production-profile connections were exercised. Normal Chromium workload and the production-profile request flood retain the production defaults.

Startup cases call actual validation and startup with missing, empty and malformed auth, leaf certificate, leaf key and CA files; real signed expired and less-than-24-hours-valid leaf certificates; a valid mismatched key; wrong SAN and wrong CA; and invalid or inconsistent listener settings. OpenSSL signs explicit certificate dates without changing the clock or mocking TLS validation. A real occupied socket must remain untouched. Unavailable-interface handling uses a clearly labelled, deterministic `EADDRNOTAVAIL` injection solely at the bind probe, because Linux treats the entire loopback range as bindable and probing other interfaces would exceed fixture scope. Negative cases assert no gateway container/listener remains and the synthetic backend remains alive with zero proxied requests. The inspected-container mutation table covers image, user, command/entrypoint, network, mounts and hardening; `check`, `start`, `stop` and rotation must reject every mutation without any Docker run/stop/remove call or credential change.

Browser coverage exercises actual Chromium Basic challenges, CA-verified HTTPS, same-origin fetch, both `/ws` and `/device?id=synthetic` WebSockets, the login popup, and cross-site requests using a context with cached credentials. Tests do not use the existing Rethink backend or exercise devices, external providers, or real runtime activation. The combined source inventory establishes that the test run did not change checkout files; comparison with the independently frozen source remains the chief/tester's responsibility. Independent acceptance remains a separate gate.

The combined command also runs the same Chromium sequence through a second, pinned nginx HTTPS proxy with an independently trusted frontend CA, verified management upstream CA/name, and NPM-style inherited TLS settings. DNS mapping is confined to synthetic client connections and Chromium resolver arguments; no host resolver or trust-store files are changed. A test-only in-memory public-port constant permits unprivileged fixture sockets. Tests cover production 443 Host/Origin pairs, exact DNS/IP SAN sets, unexpected metadata fields, both WebSocket paths, authentication, forwarding-header stripping, rotation, and multiple real clients sharing the proxy peer's reduced limiter thresholds.

Upstream trust tests require 502 with unchanged backend counters for wrong CA, wrong name, an actually expired leaf and a missing intermediate; supplying the same missing intermediate completes the chain and succeeds. Only an explicitly guarded synthetic TLS peer serves the deliberately invalid certificates to exercise the proxy verifier; normal gateway startup still rejects them. Browser rotation checks the existing WebSocket closes and the new password reconnects. The complete original LAN acceptance remains in the combined command. External-provider login and actual NPM activation remain outside synthetic coverage.

## Optional browser sessions

Legacy Basic authentication remains the default for `init`. Cookie sessions require an explicit, separately approved migration of the owned gateway. Existing admin credentials, password delivery file, private CA and leaf certificate are retained. No application backend lifecycle operation is added.

Prepare the exact accepted source image, then migrate only after runtime approval:

```sh
python3 -B management-gateway/gateway.py --state /path/to/private-state build-session-image
python3 -B management-gateway/gateway.py --state /path/to/private-state enable-sessions
```

The build uses the digest-pinned Node base in `session-proxy/Dockerfile` and the exact gateway-only npm lockfile. The helper records the immutable image ID and a digest of all shipped session and shared UI files. New starts and migration reject source/image disagreement. Stop validates the retained runtime identity, so an owned old service can still be stopped after a source update. Both container identities, commands, mounts and hardening must match before either container is stopped. A partial migration retains a private preimage and restores the exact legacy configuration; it never changes the backend. Review retained state if a conflicting container prevents safe rollback.

Nginx continues to enforce HTTPS, matched Host/Origin, Fetch Metadata, request and connection limits. Its public proxy routes to an owner-only Unix socket. A separate private Unix listener verifies the existing admin hash by serving a fixed file **after** Basic authentication succeeds. Syntax checks use an isolated temporary socket directory and cannot replace a running verifier socket. Only nginx receives the hash and leaf TLS material. The Node service receives the socket directory and nonsecret host settings; it has no password, hash, certificate or CA-key mount. No new TCP listener is created. Existing verified NPM-to-gateway HTTPS configuration and exact public hostname contract remain required.

The localized login page accepts the existing `admin` account. It uses the standard signed `express-session` cookie: `__Host-rethink-session`, Secure, HttpOnly, SameSite Strict, host-only, Path `/`. The SID regenerates on successful login. The service stores at most 64 sessions in process memory; restart, rotation, logout, expiry and capacity eviction invalidate sessions and close pending and established WebSockets in both directions. Credentials and management cookies are stripped before the fixed application backend.

A session lasts 600 seconds according to the server's monotonic clock. Activity, polling, reload and ordinary store touch do not renew it. At 60 seconds remaining, the UI offers **Extend session**, **Log out**, or dismissal. Only an explicit, unexpired request carrying the current generation renews the deadline. Another tab's renewal closes an obsolete prompt. Background/resumed tabs revalidate before enabling controls; broadcasts only trigger a server check. A suspended browser cannot display a warning until it resumes. Already accepted backend operations cannot be undone by logout.

LAN and external hosts have separate host-only browser cookies. The login page carries no backend data. Unauthenticated document navigation redirects to login; API and WebSocket requests receive 401 without a Basic challenge. Unknown authentication routes return 404. Failed logins are generic and bounded; authentication bodies are limited to 4 KiB. There is no Basic fallback in session mode.

## Session verification

The complete source-only acceptance entrypoint is documented in the repository README. Individual diagnostics remain available:

```sh
node --test management-gateway/tests/session-integration.mjs
node management-gateway/tests/session-browser.mjs
python3 -B management-gateway/tests/integration.py --acceptance
```

All test servers, listener ports, temporary credentials and Docker names are synthetic and independently cleaned up. Production timing constants are tested with an injected monotonic clock at 540/600 seconds; the browser ingress fixture additionally uses the same code with a clearly labeled 12-second real-clock duration. Neither is an observation of a physical Safari device or an actual ten-minute wait. Chromium imports only the fixture CA into a temporary NSS home; HTTPS verification is never disabled.
