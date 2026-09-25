#!/usr/bin/env python3
"""Private, standalone HTTPS authentication gateway; no backend lifecycle operations."""
from __future__ import annotations

import argparse
import contextlib
import fcntl
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import ssl
import stat
import subprocess
import sys
import time
import tempfile
import warnings

IMAGE = 'nginx@sha256:dc5069ad14f19660b141b21236140b91656bf89bbc3e2417c70ae650cd66104c'
NAME = 'rethink-management-gateway'
BACKEND = '127.0.0.1:44401'
LABEL = 'org.rethink.management-gateway'
EXTERNAL_PORT = 443  # Fixed production origin; only isolated tests patch this in memory.
# Internal policy constants; the CLI, environment and settings cannot override them.
LIMITS = {'peer_rate': 10, 'global_rate': 30, 'peer_burst': 60,
          'global_burst': 100, 'peer_connections': 32, 'global_connections': 128}
PRIVATE = tuple(ipaddress.ip_network(n) for n in ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'))


class GatewayError(Exception):
    """Safe error text, suitable for operator output."""


def run(argv, *, data=None):
    result = subprocess.run(argv, input=data, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, check=False)
    if result.returncode:
        raise GatewayError(f'{Path(argv[0]).name} operation failed; state retained')
    return result.stdout


def endpoint(value, *, test=False):
    if not isinstance(value, str) or not re.fullmatch(r'[0-9.]+:[0-9]{1,5}', value):
        raise GatewayError('Listener must be a literal RFC1918 IPv4 address and port')
    address, raw_port = value.split(':')
    try:
        ip = ipaddress.IPv4Address(address)
    except ValueError as exc:
        raise GatewayError('Invalid IPv4 address') from exc
    port = int(raw_port)
    if not 1024 <= port <= 65535 or str(port) != raw_port:
        raise GatewayError('Port must be canonical and between 1024 and 65535')
    if not (ip.is_loopback if test else any(ip in net for net in PRIVATE)):
        raise GatewayError('Listener is outside the permitted address range')
    return str(ip), port


def private_path(path, *, directory=False):
    st = path.lstat()
    expected = stat.S_ISDIR if directory else stat.S_ISREG
    if not expected(st.st_mode) or st.st_uid != os.getuid():
        raise GatewayError('State has an unsafe type or owner')
    if stat.S_IMODE(st.st_mode) != (0o700 if directory else 0o600):
        raise GatewayError('State must use directories 0700 and files 0600')
    if not directory and st.st_nlink != 1:
        raise GatewayError('Hard-linked state is forbidden')


def state_path(value):
    path = Path(os.path.abspath(value))
    if ',' in str(path) or any(ord(c) < 32 for c in str(path)):
        raise GatewayError('Unsafe state path')
    # Never resolve away symlinks. Ancestors must not allow another user to replace state.
    for parent in reversed(path.parents):
        st = parent.lstat()
        if not stat.S_ISDIR(st.st_mode):
            raise GatewayError('Symlink or non-directory state ancestor')
        if st.st_uid not in (0, os.getuid()):
            raise GatewayError('Unsafe state ancestor owner')
        if st.st_mode & 0o022 and not (st.st_uid == 0 and st.st_mode & stat.S_ISVTX):
            raise GatewayError('Writable state ancestor')
    return path


def write_new(path, content):
    data = content.encode() if isinstance(content, str) else content
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())


def replace_private(path, data):
    private_path(path)
    temporary = path.with_name('.new-' + secrets.token_hex(12))
    write_new(temporary, data)
    os.replace(temporary, path)


def password_hash(password):
    if shutil.which('htpasswd'):
        result = run(['htpasswd', '-niBC', '12', 'admin'], data=(password + '\n').encode()).decode()
        if not re.fullmatch(r'admin:\$2[aby]\$12\$[./A-Za-z0-9]{53}\n', result):
            raise GatewayError('Unexpected bcrypt output')
        return result
    with warnings.catch_warnings():
        warnings.filterwarnings('ignore', category=DeprecationWarning, message="'crypt' is deprecated.*")
        try:
            import crypt
        except ImportError as exc:
            raise GatewayError('Install supported htpasswd bcrypt tooling before initialization') from exc
    salt = '$6$rounds=200000$' + secrets.token_hex(8) + '$'
    result = crypt.crypt(password, salt)
    if not result or not result.startswith(salt) or len(result.removeprefix(salt)) != 86:
        raise GatewayError('SHA-512 crypt is unavailable')
    return 'admin:' + result + '\n'


def hostname(value):
    if not isinstance(value, str) or len(value) > 253 or not value.isascii():
        raise GatewayError('External hostname must be canonical lowercase ASCII DNS')
    labels = value.split('.')
    if (len(labels) < 2 or not re.search('[a-z]', labels[-1])
            or any(not re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', label)
                   for label in labels)):
        raise GatewayError('External hostname must have DNS labels only, without a port or path')
    return value


def config_text(bind, backend, external_hostname=None):
    address, port = bind.split(':')
    origin = f'https://{bind}'
    config = f'''pid /tmp/nginx.pid;
error_log /dev/stderr crit;
worker_processes 2;
events {{ worker_connections 1024; }}
http {{
    server_tokens off;
    log_format status_only '$status';
    access_log /dev/stdout status_only;
    client_body_temp_path /tmp/client;
    proxy_temp_path /tmp/proxy;
    fastcgi_temp_path /tmp/fastcgi;
    uwsgi_temp_path /tmp/uwsgi;
    scgi_temp_path /tmp/scgi;
    map $http_host $bad_host {{ default 1; "{bind}" 0; }}
    map $http_origin $bad_origin {{ default 1; "" 0; "{origin}" 0; }}
    map $http_origin $missing_origin {{ default 1; "{origin}" 0; }}
    map $http_sec_fetch_site $bad_site {{ default 1; "" 0; same-origin 0; none 0; }}
    map $request_method $unsafe {{ default 1; GET 0; HEAD 0; }}
    map "$unsafe:$missing_origin" $bad_method {{ default 0; "1:1" 1; }}
    map $http_upgrade $upgrade_present {{ default 1; "" 0; }}
    map "$upgrade_present:$missing_origin" $bad_upgrade {{ default 0; "1:1" 1; }}
    map "$uri:$http_sec_fetch_site" $bad_login {{
        default 0;
        ~*^/thinq_login/?:same-origin$ 0;
        ~*^/thinq_login(?::|/) 1;
    }}
    map $http_upgrade $connection_upgrade {{ default upgrade; "" close; }}
    limit_req_zone $binary_remote_addr zone=peer:1m rate={LIMITS['peer_rate']}r/s;
    limit_req_zone $server_name zone=global:1m rate={LIMITS['global_rate']}r/s;
    limit_conn_zone $binary_remote_addr zone=peer_conn:1m;
    limit_conn_zone $server_name zone=global_conn:1m;
    server {{
        listen {address}:{port} ssl;
        server_name {address};
        ssl_certificate /gateway/tls.crt;
        ssl_certificate_key /gateway/tls.key;
        ssl_protocols TLSv1.2 TLSv1.3;
        ssl_session_tickets off;
        ssl_session_cache off;
        client_header_timeout 10s;
        client_body_timeout 30s;
        send_timeout 30s;
        keepalive_timeout 30s;
        client_max_body_size 2m;
        if ($bad_host) {{ return 421; }}
        if ($bad_origin) {{ return 403; }}
        if ($bad_site) {{ return 403; }}
        if ($bad_method) {{ return 403; }}
        if ($bad_upgrade) {{ return 403; }}
        if ($bad_login) {{ return 403; }}
        auth_basic "Rethink management";
        auth_basic_user_file /gateway/auth;
        limit_req zone=peer burst={LIMITS['peer_burst']} nodelay;
        limit_req zone=global burst={LIMITS['global_burst']} nodelay;
        limit_req_status 429;
        limit_conn peer_conn {LIMITS['peer_connections']};
        limit_conn global_conn {LIMITS['global_connections']};
        limit_conn_status 429;
        add_header X-Content-Type-Options nosniff always;
        add_header Referrer-Policy same-origin always;
        add_header X-Frame-Options SAMEORIGIN always;
        location / {{
            proxy_pass http://{backend};
            proxy_http_version 1.1;
            proxy_set_header Host "{bind}";
            proxy_set_header Authorization "";
            proxy_set_header Proxy-Authorization "";
            proxy_set_header Forwarded "";
            proxy_set_header X-Forwarded-For $remote_addr;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-Host "{bind}";
            proxy_set_header X-Forwarded-Proto https;
            proxy_set_header X-Forwarded-Port "{port}";
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection $connection_upgrade;
            proxy_read_timeout 3600s;
            proxy_send_timeout 60s;
            proxy_buffering off;
            proxy_hide_header WWW-Authenticate;
        }}
    }}
}}
'''
    if external_hostname is None:
        return config
    name = hostname(external_hostname)
    authority = name if EXTERNAL_PORT == 443 else f'{name}:{EXTERNAL_PORT}'
    external_origin = 'https://' + authority
    authorities = [(bind, origin), (name, external_origin),
                   (f'{name}:{EXTERNAL_PORT}', external_origin)]
    # Regex map keys are case-sensitive; each authority accepts only its paired Origin.
    def exact(value):
        return '~^' + re.escape(value) + '$'
    policy = '    map $http_host $bad_host { default 1;\n'
    policy += ''.join(f'        {exact(host)} 0;\n' for host, _ in authorities) + '    }\n'
    policy += '    map "$http_host|$http_origin" $bad_origin { default 1;\n'
    for host, accepted_origin in authorities:
        policy += f'        {exact(host + "|")} 0;\n'
        policy += f'        {exact(host + "|" + accepted_origin)} 0;\n'
    policy += '    }\n    map "$http_host|$http_origin" $missing_origin { default 1;\n'
    policy += ''.join(f'        {exact(host + "|" + accepted_origin)} 0;\n'
                      for host, accepted_origin in authorities) + '    }\n'
    policy += f'    map $http_host $gateway_authority {{ default "{bind}";\n'
    policy += ''.join(f'        {exact(host)} "{authority}";\n'
                      for host, _ in authorities[1:]) + '    }\n'
    policy += f'    map $http_host $gateway_port {{ default {port};\n'
    policy += ''.join(f'        {exact(host)} {EXTERNAL_PORT};\n'
                      for host, _ in authorities[1:]) + '    }\n'
    original_policy = (f'    map $http_host $bad_host {{ default 1; "{bind}" 0; }}\n'
                       f'    map $http_origin $bad_origin {{ default 1; "" 0; "{origin}" 0; }}\n'
                       f'    map $http_origin $missing_origin {{ default 1; "{origin}" 0; }}\n')
    config = config.replace(original_policy, policy)
    for header in ('Host', 'X-Forwarded-Host'):
        config = config.replace(f'proxy_set_header {header} "{bind}";',
                                f'proxy_set_header {header} $gateway_authority;')
    return config.replace(f'proxy_set_header X-Forwarded-Port "{port}";',
                          'proxy_set_header X-Forwarded-Port $gateway_port;')

SESSION_BASE = 'node:24.18.1-alpine3.24@sha256:f70403e87646dc51b45295f4b8b70cdad0b63d2297c4c9899119b03f7af7a6b3'
SESSION_FILES = ('package.json', 'package-lock.json', 'Dockerfile', 'service.mjs',
                 'session-store.mjs', 'login.html', 'login.js', 'login.css', '.dockerignore')


def session_config(bind, backend, external_hostname=None):
    config = config_text(bind, backend, external_hostname)
    config = config.replace('        auth_basic "Rethink management";\n'
                            '        auth_basic_user_file /gateway/auth;\n', '')
    config = config.replace(f'proxy_pass http://{backend};',
                            'proxy_pass http://unix:/sockets/session.sock:;')
    verifier = '''    server {
        listen unix:/sockets/verifier.sock;
        server_name verifier;
        access_log off;
        location = /verify {
            auth_basic "Private verifier";
            auth_basic_user_file /gateway/auth;
            alias /gateway/verified;
        }
        location / { return 404; }
    }
'''
    return config[:-2] + verifier + '}\n'


def session_hosts(meta):
    hosts = {meta['bind']: 'https://' + meta['bind']}
    if meta.get('external_hostname'):
        name = meta['external_hostname']
        authority = name if EXTERNAL_PORT == 443 else f'{name}:{EXTERNAL_PORT}'
        hosts[name] = 'https://' + authority
        hosts[f'{name}:{EXTERNAL_PORT}'] = 'https://' + authority
    return {'hosts': hosts}


def session_source():
    root = Path(__file__).resolve().parent
    contents = {name: (root / 'session-proxy' / name).read_bytes() for name in SESSION_FILES}
    for name in ('ui.js', 'ui.css'):
        contents[name] = (root.parent / 'html' / name).read_bytes()
    digest = hashlib.sha256()
    for name, data in sorted(contents.items()):
        digest.update(f'{len(name)}:{name}:{len(data)}:'.encode())
        digest.update(data)
    return digest.hexdigest(), contents


class Gateway:
    def __init__(self, state):
        self.state = state_path(state)
        self.name = NAME
        self.backend = BACKEND
        self.test = False

    @contextlib.contextmanager
    def locked(self):
        private_path(self.state, directory=True)
        lock = self.state / 'lock'
        fd = os.open(lock, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            private_path(lock)
            fcntl.flock(fd, fcntl.LOCK_EX)
            yield
        finally:
            os.close(fd)

    def metadata(self):
        private_path(self.state, directory=True)
        for item in self.state.iterdir():
            private_path(item, directory=item.name in ('runtime', 'sockets'))
            if item.name == 'sockets':
                for sock in item.iterdir():
                    st = sock.lstat()
                    if sock.name not in ('session.sock', 'verifier.sock') or not stat.S_ISSOCK(st.st_mode) or st.st_uid != os.getuid():
                        raise GatewayError('Unsafe or unexpected session socket')
        runtime = self.state / 'runtime'
        private_path(runtime, directory=True)
        for item in runtime.iterdir():
            private_path(item)
        try:
            meta = json.loads((self.state / 'settings.json').read_text())
        except (ValueError, OSError) as exc:
            raise GatewayError('Missing or invalid private settings') from exc
        required = {'schema', 'bind', 'uid', 'gid'}
        if set(meta) - (required | {'external_hostname', 'sessions'}) or not required <= set(meta) or meta['schema'] != 1:
            raise GatewayError('Unsupported settings')
        if 'external_hostname' in meta:
            hostname(meta['external_hostname'])
        if 'sessions' in meta:
            self.validate_image_record(meta['sessions'])
        endpoint(meta['bind'], test=self.test)
        if meta['uid'] != os.getuid() or meta['gid'] != os.getgid() or os.getuid() == 0:
            raise GatewayError('Run gateway as its original non-root owner')
        return meta

    def initialize(self, bind, external_hostname=None):
        address, _ = endpoint(bind, test=self.test)
        if external_hostname is not None:
            hostname(external_hostname)
        if os.getuid() == 0:
            raise GatewayError('A non-root owner is required')
        self.state.mkdir(mode=0o700)  # Exclusive: incomplete or prior state is never overwritten.
        runtime = self.state / 'runtime'
        runtime.mkdir(mode=0o700)
        with self.locked():
            meta = {'schema': 1, 'bind': bind, 'uid': os.getuid(), 'gid': os.getgid()}
            if external_hostname is not None:
                meta['external_hostname'] = external_hostname
            write_new(self.state / 'settings.json', json.dumps(meta) + '\n')
            password = secrets.token_urlsafe(32)
            write_new(self.state / 'password.txt', password + '\n')
            write_new(runtime / 'auth', password_hash(password))
            ca_key = str(self.state / 'ca.key')
            ca_cert = str(self.state / 'ca.crt')
            run(['openssl', 'req', '-x509', '-newkey', 'rsa:3072', '-nodes', '-sha256',
                 '-days', '3650', '-subj', '/CN=Rethink Management Private CA',
                 '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0',
                 '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
                 '-keyout', ca_key, '-out', ca_cert])
            run(['openssl', 'req', '-new', '-newkey', 'rsa:3072', '-nodes', '-sha256',
                 '-subj', '/CN=Rethink Management', '-keyout', str(runtime / 'tls.key'),
                 '-out', str(self.state / 'leaf.csr')])
            san = f'IP:{address}' + (f',DNS:{external_hostname}' if external_hostname else '')
            write_new(self.state / 'leaf.ext', 'basicConstraints=critical,CA:FALSE\n'
                      'keyUsage=critical,digitalSignature,keyEncipherment\n'
                      'extendedKeyUsage=serverAuth\n' + f'subjectAltName={san}\n')
            run(['openssl', 'x509', '-req', '-in', str(self.state / 'leaf.csr'),
                 '-CA', ca_cert, '-CAkey', ca_key, '-set_serial', str(secrets.randbits(128) | 1),
                 '-days', '365', '-sha256', '-extfile', str(self.state / 'leaf.ext'),
                 '-out', str(runtime / 'tls.crt')])
            for path in (self.state / 'leaf.csr', self.state / 'leaf.ext'):
                path.unlink()
            write_new(runtime / 'nginx.conf', config_text(bind, self.backend, external_hostname))
            self.validate()

    def validate(self):
        meta = self.metadata()
        runtime = self.state / 'runtime'
        expected = {'nginx.conf', 'tls.key', 'tls.crt', 'auth'}
        if meta.get('sessions'):
            self.validate_image_record(meta['sessions'], current=True)
            expected.add('verified')
            if (runtime / 'verified').read_bytes() != b'verified\n':
                raise GatewayError('Changed verifier content')
            if json.loads((self.state / 'session.json').read_text()) != session_hosts(meta):
                raise GatewayError('Changed nonsecret session settings')
        if {p.name for p in runtime.iterdir()} != expected:
            raise GatewayError('Unexpected or missing runtime files')
        name = meta.get('external_hostname')
        if (runtime / 'nginx.conf').read_text() != (session_config if meta.get('sessions') else config_text)(meta['bind'], self.backend, name):
            raise GatewayError('Configuration differs from the fixed gateway policy')
        auth = (runtime / 'auth').read_text()
        if not re.fullmatch(r'admin:(?:\$2[aby]\$(?:12|13|14)\$[./A-Za-z0-9]{53}|'
                            r'\$6\$rounds=(?:[1-9][0-9]{5,6})\$[./A-Za-z0-9]{1,16}\$[./A-Za-z0-9]{86})\n', auth):
            raise GatewayError('Invalid or weak credential file')
        cert, key = str(runtime / 'tls.crt'), str(runtime / 'tls.key')
        run(['openssl', 'verify', '-CAfile', str(self.state / 'ca.crt'), '-purpose', 'sslserver',
             '-verify_ip', meta['bind'].split(':')[0], cert])
        if name:
            run(['openssl', 'verify', '-CAfile', str(self.state / 'ca.crt'), '-purpose', 'sslserver',
                 '-verify_hostname', name, cert])
        run(['openssl', 'x509', '-in', cert, '-noout', '-checkend', '86400'])
        san = run(['openssl', 'x509', '-in', cert, '-noout', '-ext', 'subjectAltName']).decode()
        expected_san = 'IP Address:' + meta['bind'].split(':')[0] + (f', DNS:{name}' if name else '')
        if [line.strip() for line in san.strip().splitlines()] != [
                'X509v3 Subject Alternative Name:', expected_san]:
            raise GatewayError('Certificate must contain only the exact configured SAN identities')
        pub_cert = run(['openssl', 'x509', '-in', cert, '-pubkey', '-noout'])
        pub_key = run(['openssl', 'pkey', '-in', key, '-pubout'])
        if pub_cert != pub_key:
            raise GatewayError('Certificate and key do not match')
        return meta

    def identity(self):
        return hashlib.sha256(f'{self.name}:{self.state}:{os.getuid()}'.encode()).hexdigest()

    def inspect(self):
        # List by exact name; absence differs from a daemon/permission error.
        ids = run(['docker', 'container', 'ls', '-aq', '--filter', f'name=^/{self.name}$']).decode().split()
        if not ids:
            return None
        if len(ids) != 1:
            raise GatewayError('Ambiguous gateway identity')
        obj = json.loads(run(['docker', 'inspect', ids[0]]))[0]
        config, host = obj['Config'], obj['HostConfig']
        mounts = obj['Mounts']
        sessions = self.metadata().get('sessions')
        expected_mounts = {(str(self.state / 'runtime'), '/gateway', False)}
        if sessions:
            expected_mounts.add((str(self.state / 'sockets'), '/sockets', True))
        expected_cmd = ['-c', '/gateway/nginx.conf', '-g', 'daemon off;']
        safe = (obj['Name'] == '/' + self.name and config['Image'] == IMAGE
                and config['User'] == f'{os.getuid()}:{os.getgid()}'
                and config.get('Labels', {}).get(LABEL) == self.identity()
                and config['Cmd'] == expected_cmd and config['Entrypoint'] == ['nginx']
                and host['NetworkMode'] == 'host' and host['ReadonlyRootfs']
                and host['CapDrop'] == ['ALL'] and not host.get('Privileged')
                and not host.get('CapAdd') and not host.get('Devices')
                and host.get('SecurityOpt') == ['no-new-privileges']
                and host.get('RestartPolicy', {}).get('Name') == 'no'
                and host.get('Tmpfs') == {'/tmp': 'rw,noexec,nosuid,size=32m,mode=1777'}
                and len(mounts) == len(expected_mounts)
                and all(m['Type'] == 'bind' for m in mounts)
                and {(m['Source'], m['Destination'], m['RW']) for m in mounts} == expected_mounts
                and not host.get('Sysctls'))
        if not safe:
            raise GatewayError('Gateway name conflicts with an unowned or changed container')
        return obj

    def docker_args(self, *, syntax=False):
        args = ['docker', 'run', '--rm'] if syntax else ['docker', 'run', '-d', '--name', self.name]
        if syntax:
            args += ['--sysctl', 'net.ipv4.ip_nonlocal_bind=1']
        args += ['--pull', 'never', '--network', 'none' if syntax else 'host',
                 '--user', f'{os.getuid()}:{os.getgid()}', '--read-only',
                 '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
                 '--tmpfs', '/tmp:rw,noexec,nosuid,size=32m,mode=1777',
                 '--mount', f'type=bind,src={self.state / "runtime"},dst=/gateway,readonly',
                 '--label', f'{LABEL}={self.identity()}', '--entrypoint', 'nginx', IMAGE,
                 '-c', '/gateway/nginx.conf']
        if self.metadata().get('sessions'):
            index = args.index('--label')
            args[index:index] = (['--tmpfs', f'/sockets:rw,noexec,nosuid,size=1m,mode=0700,uid={os.getuid()},gid={os.getgid()}'] if syntax else
                                 ['--mount', f'type=bind,src={self.state / "sockets"},dst=/sockets'])
        return args + (['-t'] if syntax else ['-g', 'daemon off;'])

    def check(self):
        self.validate()
        self.inspect()
        self.inspect_session()
        run(self.docker_args(syntax=True))

    def start(self):
        meta = self.validate()
        obj = self.inspect()
        sidecar = self.inspect_session()
        if obj and obj['State']['Running']:
            if meta.get('sessions') and not (sidecar and sidecar['State']['Running']):
                raise GatewayError('Owned session service is not running')
            return
        run(self.docker_args(syntax=True))
        address, port = endpoint(meta['bind'], test=self.test)
        with socket.socket() as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                sock.bind((address, port))
            except OSError as exc:
                raise GatewayError('Exact listener is unavailable') from exc
        if obj:
            run(['docker', 'rm', obj['Id']])
        try:
            if meta.get('sessions'):
                self.start_session()
            run(self.docker_args())
        except GatewayError:
            self.stop()
            raise
        context = ssl.create_default_context(cafile=str(self.state / 'ca.crt'))
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            obj = self.inspect()
            if not obj or not obj['State']['Running']:
                break
            try:
                with socket.create_connection((address, port), timeout=1) as raw:
                    with context.wrap_socket(raw, server_hostname=address):
                        return
            except (OSError, ssl.SSLError):
                time.sleep(0.1)
        self.stop()
        raise GatewayError('Gateway TLS readiness failed; owned gateway stopped')

    def stop(self):
        self.metadata()
        obj = self.inspect()
        sidecar = self.inspect_session()
        if obj:
            if obj['State']['Running']:
                run(['docker', 'stop', '--time', '5', obj['Id']])
            run(['docker', 'rm', obj['Id']])
        if sidecar:
            if sidecar['State']['Running']:
                run(['docker', 'stop', '--time', '5', sidecar['Id']])
            run(['docker', 'rm', sidecar['Id']])
        self.clean_sockets()

    def validate_image_record(self, record, *, current=False):
        if (not isinstance(record, dict) or set(record) != {'image', 'source'}
                or not re.fullmatch(r'sha256:[a-f0-9]{64}', record.get('image', ''))
                or not re.fullmatch(r'[a-f0-9]{64}', record.get('source', ''))):
            raise GatewayError('Invalid session image identity')
        if current and record['source'] != session_source()[0]:
            raise GatewayError('Session source changed; build the exact accepted image first')
        image = json.loads(run(['docker', 'image', 'inspect', record['image']]))[0]
        if (image['Id'] != record['image']
                or image['Config'].get('Labels', {}).get(LABEL + '.source') != record['source']
                or image['Config'].get('Entrypoint') != ['node']
                or image['Config'].get('Cmd') != ['service.mjs']):
            raise GatewayError('Changed session image')
        return record

    def build_session_image(self):
        self.validate()
        self.inspect()
        digest, contents = session_source()
        with tempfile.TemporaryDirectory(prefix='session-build-', dir=self.state) as directory:
            for name, data in contents.items():
                write_new(Path(directory) / name, data)
            tag = 'rethink-management-session:' + digest
            run(['docker', 'build', '--pull=false', '--label', LABEL + '.source=' + digest,
                 '--tag', tag, directory])
        image = json.loads(run(['docker', 'image', 'inspect', tag]))[0]['Id']
        record = self.validate_image_record({'image': image, 'source': digest}, current=True)
        destination = self.state / 'session-image.json'
        content = json.dumps(record) + '\n'
        if destination.exists():
            replace_private(destination, content)
        else:
            write_new(destination, content)

    def session_command(self):
        return ['service.mjs']

    def session_args(self):
        record = self.metadata()['sessions']
        return ['docker', 'run', '-d', '--name', self.name + '-session', '--pull', 'never',
                '--network', 'host', '--user', f'{os.getuid()}:{os.getgid()}', '--read-only',
                '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
                '--tmpfs', '/tmp:rw,noexec,nosuid,size=32m,mode=1777',
                '--mount', f'type=bind,src={self.state / "sockets"},dst=/sockets',
                '--mount', f'type=bind,src={self.state / "session.json"},dst=/settings/session.json,readonly',
                '--label', LABEL + '=' + self.identity(), '--entrypoint', 'node',
                record['image']] + self.session_command()

    def inspect_session(self):
        ids = run(['docker', 'container', 'ls', '-aq', '--filter',
                   f'name=^/{self.name}-session$']).decode().split()
        if not ids:
            return None
        record = self.metadata().get('sessions')
        if len(ids) != 1 or not record:
            raise GatewayError('Session name conflicts with an unowned container')
        obj = json.loads(run(['docker', 'inspect', ids[0]]))[0]
        config, host, mounts = obj['Config'], obj['HostConfig'], obj['Mounts']
        image_config = json.loads(run(['docker', 'image', 'inspect', record['image']]))[0]['Config']
        expected_mounts = {(str(self.state / 'sockets'), '/sockets', True),
                           (str(self.state / 'session.json'), '/settings/session.json', False)}
        if not (obj['Name'] == '/' + self.name + '-session' and config['Image'] == record['image']
                and obj['Image'] == record['image'] and config['User'] == f'{os.getuid()}:{os.getgid()}'
                and config.get('Labels', {}).get(LABEL) == self.identity()
                and config['Entrypoint'] == ['node'] and config['Cmd'] == self.session_command()
                and config.get('Env') == image_config.get('Env')
                and config.get('WorkingDir') == image_config.get('WorkingDir')
                and host['NetworkMode'] == 'host' and host['ReadonlyRootfs']
                and host['CapDrop'] == ['ALL'] and not host.get('Privileged')
                and not host.get('CapAdd') and not host.get('Devices') and not host.get('Sysctls')
                and host.get('SecurityOpt') == ['no-new-privileges']
                and host.get('RestartPolicy', {}).get('Name') == 'no'
                and host.get('Tmpfs') == {'/tmp': 'rw,noexec,nosuid,size=32m,mode=1777'}
                and len(mounts) == 2 and all(m['Type'] == 'bind' for m in mounts)
                and {(m['Source'], m['Destination'], m['RW']) for m in mounts} == expected_mounts):
            raise GatewayError('Session name conflicts with an unowned or changed container')
        return obj

    def clean_sockets(self):
        directory = self.state / 'sockets'
        if not directory.exists():
            return
        private_path(directory, directory=True)
        for path in directory.iterdir():
            st = path.lstat()
            if path.name not in ('session.sock', 'verifier.sock') or not stat.S_ISSOCK(st.st_mode) or st.st_uid != os.getuid():
                raise GatewayError('Refusing to remove an unknown socket')
            path.unlink()

    def start_session(self):
        obj = self.inspect_session()
        if obj and obj['State']['Running']:
            return
        if obj:
            run(['docker', 'rm', obj['Id']])
        self.clean_sockets()
        run(self.session_args())
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            obj = self.inspect_session()
            if not obj or not obj['State']['Running']:
                break
            try:
                with socket.socket(socket.AF_UNIX) as sock:
                    sock.settimeout(1)
                    sock.connect(str(self.state / 'sockets' / 'session.sock'))
                    return
            except OSError:
                time.sleep(0.1)
        raise GatewayError('Session service readiness failed')

    def enable_sessions(self):
        meta = self.validate()
        obj = self.inspect()
        self.inspect_session()  # Reject a colliding sidecar before any lifecycle mutation.
        if meta.get('sessions'):
            raise GatewayError('Sessions are already enabled')
        private_path(self.state / 'session-image.json')
        record = self.validate_image_record(json.loads((self.state / 'session-image.json').read_text()), current=True)
        if (self.state / 'sockets').exists() or (self.state / 'session.json').exists():
            raise GatewayError('Migration inputs already exist; review retained preimage')
        old_settings = (self.state / 'settings.json').read_bytes()
        old_config = (self.state / 'runtime' / 'nginx.conf').read_bytes()
        suffix = secrets.token_hex(12)
        write_new(self.state / ('previous-settings-' + suffix), old_settings)
        write_new(self.state / ('previous-nginx-' + suffix), old_config)
        self.stop()
        try:
            (self.state / 'sockets').mkdir(mode=0o700)
            write_new(self.state / 'session.json', json.dumps(session_hosts(meta)) + '\n')
            write_new(self.state / 'runtime' / 'verified', 'verified\n')
            meta['sessions'] = record
            replace_private(self.state / 'settings.json', json.dumps(meta) + '\n')
            replace_private(self.state / 'runtime' / 'nginx.conf',
                            session_config(meta['bind'], self.backend, meta.get('external_hostname')))
            self.start()
        except (GatewayError, OSError, ValueError):
            # Exact identities are still required during rollback; conflicts fail closed.
            self.stop()
            replace_private(self.state / 'settings.json', old_settings)
            replace_private(self.state / 'runtime' / 'nginx.conf', old_config)
            for path in (self.state / 'runtime' / 'verified', self.state / 'session.json'):
                if path.exists():
                    private_path(path)
                    path.unlink()
            directory = self.state / 'sockets'
            if directory.exists():
                private_path(directory, directory=True)
                directory.rmdir()
            if obj and obj['State']['Running']:
                self.start()
            raise GatewayError('Session migration failed; exact legacy preimage restored')

    def rotate(self):
        self.validate()
        obj = self.inspect()
        password = secrets.token_urlsafe(32)
        hashed = password_hash(password)
        suffix = secrets.token_hex(12)
        for path in (self.state / 'password.txt', self.state / 'runtime' / 'auth'):
            write_new(self.state / f'previous-{path.name}-{suffix}', path.read_bytes())
        self.stop()  # Close cached authenticated WebSockets before installing new credentials.
        replace_private(self.state / 'runtime' / 'auth', hashed)
        replace_private(self.state / 'password.txt', password + '\n')
        if obj and obj['State']['Running']:
            self.start()


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state', required=True, help='Private state directory; outside the checkout')
    sub = parser.add_subparsers(dest='command', required=True)
    initialize = sub.add_parser('init')
    initialize.add_argument('--listen', required=True)
    initialize.add_argument('--external-hostname', help='One canonical DNS name; public HTTPS port is 443')
    for command in ('check', 'start', 'stop', 'rotate-password', 'build-session-image', 'enable-sessions'):
        sub.add_parser(command)
    args = parser.parse_args()
    try:
        gateway = Gateway(args.state)
        if args.command == 'init':
            gateway.initialize(args.listen, args.external_hostname)
        else:
            with gateway.locked():
                getattr(gateway, {'rotate-password': 'rotate', 'build-session-image': 'build_session_image', 'enable-sessions': 'enable_sessions'}.get(args.command, args.command))()
        print(f'Gateway {args.command} completed. Private credentials: {gateway.state / "password.txt"}')
    except (GatewayError, OSError, ValueError, KeyError) as exc:
        message = str(exc) if isinstance(exc, GatewayError) else 'Invalid state or unavailable prerequisite'
        print('Gateway refused: ' + message, file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
