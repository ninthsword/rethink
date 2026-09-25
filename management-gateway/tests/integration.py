#!/usr/bin/env python3
"""Self-contained unit/integration tests. Never connect to the production backend."""
from __future__ import annotations

import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
import contextlib
from datetime import datetime, timedelta, timezone
import errno
import hashlib
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
import os
from pathlib import Path
import secrets
import socket
import ssl
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('gateway', Path(__file__).parents[1] / 'gateway.py')
g = importlib.util.module_from_spec(spec)
spec.loader.exec_module(g)
os.umask(0o077)


class Backend(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *_):
        pass

    def respond(self, body, content_type='application/json', status=200):
        self.send_response(status)
        self.send_header('Content-Type', content_type + '; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        # Advertise the closure so an upstream keepalive agent cannot reuse this socket.
        if self.close_connection:
            self.send_header('Connection', 'close')
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)

    def do_GET(self):
        if getattr(self.server, 'session_ui', False):
            if self.path in ('/ui.js', '/ui.css'):
                source = Path(__file__).parents[2] / 'html' / self.path[1:]
                return self.respond(source.read_bytes(), 'text/javascript' if self.path.endswith('.js') else 'text/css')
            if self.path == '/':
                return self.respond(b'<!doctype html><html lang="en"><head><title>Fixture management</title><link rel="stylesheet" href="/ui.css"></head><body><header><h1>Fixture management</h1><select id="language" aria-label="Language"><option value="en">English</option><option value="ko">Korean</option></select></header><main><label for="unsaved">Synthetic input</label><input id="unsaved"><a id="login" href="/thinq_login" target="_blank">Login</a></main><dialog id="synthetic-dialog"><button type="button">Synthetic action</button></dialog><script src="/ui.js"></script></body></html>', 'text/html')
        if self.path == '/fixture-stats':
            with self.server.guard:
                body = json.dumps(self.server.seen).encode()
            return self.respond(body)
        with self.server.guard:
            self.server.seen.append({'path': self.path, 'method': self.command,
                                     'headers': dict(self.headers)})
        if self.headers.get('Upgrade', '').lower() == 'websocket':
            key = self.headers['Sec-WebSocket-Key']
            # RFC 6455 requires SHA-1 here for the public upgrade handshake, not password storage.
            accept = base64.b64encode(hashlib.sha1(
                (key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode()
            self.send_response(101)
            self.send_header('Upgrade', 'websocket')
            self.send_header('Connection', 'Upgrade')
            self.send_header('Sec-WebSocket-Accept', accept)
            self.end_headers()
            try:
                while True:
                    head = self.rfile.read(2)
                    if len(head) != 2 or head[0] & 15 == 8:
                        break
                    length = head[1] & 127
                    if length == 126:
                        length = struct.unpack('!H', self.rfile.read(2))[0]
                    if length > 4096:
                        break
                    mask = self.rfile.read(4) if head[1] & 128 else b''
                    payload = self.rfile.read(length)
                    if mask:
                        payload = bytes(c ^ mask[i % 4] for i, c in enumerate(payload))
                    self.wfile.write(bytes((0x81, len(payload))) + payload)
                    self.wfile.flush()
            except (OSError, ValueError):
                pass
            self.close_connection = True
            return
        if self.path == '/':
            return self.respond(b'<!doctype html><title>Fixture management</title>'
                                b'<a id="login" href="/thinq_login" target="_blank">Login</a>', 'text/html')
        return self.respond(json.dumps({'ok': True, 'headers': dict(self.headers)}).encode())

    do_HEAD = do_GET

    def do_POST(self):
        self.rfile.read(int(self.headers.get('Content-Length', 0)))
        self.do_GET()

    do_PUT = do_POST
    do_DELETE = do_POST
    do_OPTIONS = do_POST


class Foreign(Backend):
    def do_GET(self):
        self.respond(b'<!doctype html><title>Foreign fixture</title>', 'text/html')


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


class Fixture:
    """The sole test override: unique name, loopback listener and freshly owned backend."""
    def __init__(self, *, start=True, external_hostname=None):
        self.start = start
        self.external_hostname = external_hostname

    def __enter__(self):
        self.temp = tempfile.TemporaryDirectory(prefix='rethink-gateway-test-')
        self.backend = ThreadingHTTPServer(('127.0.0.1', 0), Backend)
        self.backend.daemon_threads = True
        self.backend.guard = threading.Lock()
        self.backend.seen = []
        self.foreign = ThreadingHTTPServer(('127.0.0.2', 0), Foreign)
        self.foreign.daemon_threads = True
        for server in (self.backend, self.foreign):
            threading.Thread(target=server.serve_forever, daemon=True).start()
        self.gateway = g.Gateway(Path(self.temp.name) / 'state')
        self.gateway.test = True
        self.gateway.name = 'rethink-gateway-test-' + secrets.token_hex(10)
        self.gateway.backend = f'127.0.0.1:{self.backend.server_port}'
        self.port = free_port()
        while self.port == getattr(self, 'public_port', None):
            self.port = free_port()
        self.origin = f'https://127.0.0.1:{self.port}'
        try:
            self.gateway.initialize(f'127.0.0.1:{self.port}', self.external_hostname)
            self.context = ssl.create_default_context(cafile=str(self.gateway.state / 'ca.crt'))
            if self.start:
                self.gateway.start()
        except BaseException:
            self.__exit__(None, None, None)
            raise
        return self

    @property
    def password(self):
        return (self.gateway.state / 'password.txt').read_text().strip()

    def auth(self, password=None):
        return 'Basic ' + base64.b64encode(('admin:' + (password or self.password)).encode()).decode()

    def request(self, path, *, auth=False, headers=None, method='GET', context=None,
                peer='127.0.0.1', target=None):
        supplied = dict(headers or {})
        if auth:
            supplied['Authorization'] = self.auth()
        host, port, trusted_context = target or ('127.0.0.1', self.port, self.context)
        connection = http.client.HTTPSConnection(host, port,
                                                 context=context or trusted_context, timeout=15,
                                                 source_address=(peer, 0))
        # Resolve only this synthetic client connection, preserving hostname verification/SNI.
        connection._create_connection = lambda address, timeout, source_address: socket.create_connection(
            ('127.0.0.1', port), timeout, source_address)
        try:
            connection.request(method, path, headers=supplied)
            response = connection.getresponse()
            return response.status, response.read()
        finally:
            connection.close()

    def count(self):
        with self.backend.guard:
            return len(self.backend.seen)

    def websocket(self, *, auth=True, origin=True, path='/ws', peer='127.0.0.1', spoof=None,
                  target=None, host_header=None):
        host, port, context = target or ('127.0.0.1', self.port, self.context)
        sock = context.wrap_socket(socket.create_connection(('127.0.0.1', port), timeout=10,
                                                                     source_address=(peer, 0)),
                                        server_hostname=host)
        headers = [f'GET {path} HTTP/1.1', f'Host: {host_header or f"{host}:{port}"}', 'Upgrade: websocket',
                   'Connection: Upgrade', 'Sec-WebSocket-Version: 13',
                   'Sec-WebSocket-Key: ' + base64.b64encode(secrets.token_bytes(16)).decode()]
        if spoof:
            headers.extend(['X-Forwarded-For: ' + spoof, 'Forwarded: for=' + spoof,
                            'X-Real-IP: ' + spoof])
        if auth:
            headers.append('Authorization: ' + self.auth())
        if origin:
            accepted_origin = origin if isinstance(origin, str) else (
                f'https://{host}:{port}' if target else self.origin)
            headers.append('Origin: ' + accepted_origin)
        sock.sendall(('\r\n'.join(headers) + '\r\n\r\n').encode())
        data = b''
        while b'\r\n\r\n' not in data:
            chunk = sock.recv(1)
            if not chunk:
                break
            data += chunk
        return sock, int(data.split(b' ')[1])

    def __exit__(self, *_):
        try:
            if hasattr(self, 'gateway') and (self.gateway.state / 'settings.json').exists():
                self.gateway.stop()
        finally:
            for server in (self.backend, self.foreign):
                server.shutdown()
                server.server_close()
            self.temp.cleanup()


def sign_certificate(directory, issuer_cert, issuer_key, subject_key, san, start, end, *, ca=False):
    """Sign actual fixture dates and identities with OpenSSL; never mock verification."""
    directory.mkdir(mode=0o700)
    (directory / 'newcerts').mkdir(mode=0o700)
    g.write_new(directory / 'index', '')
    g.write_new(directory / 'serial', '01\n')
    extensions = ('basicConstraints=critical,CA:TRUE,pathlen:0\n'
                  'keyUsage=critical,keyCertSign,cRLSign\n') if ca else (
                      'basicConstraints=critical,CA:FALSE\n'
                      'keyUsage=critical,digitalSignature,keyEncipherment\n'
                      'extendedKeyUsage=serverAuth\n' + f'subjectAltName={san}\n')
    config = (f'[ca]\ndefault_ca=fixture_ca\n[fixture_ca]\n'
              f'database={directory / "index"}\nserial={directory / "serial"}\n'
              f'new_certs_dir={directory / "newcerts"}\ncertificate={issuer_cert}\n'
              f'private_key={issuer_key}\ndefault_md=sha256\npolicy=fixture_policy\n'
              '[fixture_policy]\ncommonName=supplied\n[certificate]\n' + extensions)
    g.write_new(directory / 'ca.conf', config)
    csr, certificate = directory / 'subject.csr', directory / 'subject.crt'
    subject = 'Synthetic Intermediate' if ca else 'Synthetic Management'
    g.run(['openssl', 'req', '-new', '-key', str(subject_key), '-subj', '/CN=' + subject,
           '-out', str(csr)])
    g.run(['openssl', 'ca', '-batch', '-notext', '-config', str(directory / 'ca.conf'),
           '-extensions', 'certificate', '-startdate', start.strftime('%Y%m%d%H%M%SZ'),
           '-enddate', end.strftime('%Y%m%d%H%M%SZ'), '-in', str(csr), '-out', str(certificate)])
    return certificate


INGRESS_HOST = 'management.example.test'


class IngressFixture(Fixture):
    """Pinned nginx second hop, matching NPM's Host and inherited upstream TLS settings."""
    def __init__(self):
        super().__init__(external_hostname=INGRESS_HOST)
        self.proxy_id = None
        self.base_ready = False

    def __enter__(self):
        self.public_port = free_port()
        self.port_patch = patch.object(g, 'EXTERNAL_PORT', self.public_port)
        self.port_patch.start()
        try:
            super().__enter__()
            self.base_ready = True
            self.public_origin = f'https://{INGRESS_HOST}:{self.public_port}'
            frontend = g.Gateway(Path(self.temp.name) / 'frontend')
            frontend.test = True
            frontend.initialize(f'127.0.0.1:{self.public_port}', INGRESS_HOST)
            self.frontend_ca = frontend.state / 'ca.crt'
            self.proxy_context = ssl.create_default_context(cafile=str(self.frontend_ca))
            self.proxy_runtime = Path(self.temp.name) / 'proxy-runtime'
            self.proxy_runtime.mkdir(mode=0o700)
            for filename in ('tls.crt', 'tls.key'):
                g.write_new(self.proxy_runtime / filename, (frontend.state / 'runtime' / filename).read_bytes())
            self.start_proxy()
            return self
        except BaseException:
            if self.base_ready:
                self.__exit__(None, None, None)
            else:
                self.port_patch.stop()
            raise

    @property
    def proxy_target(self):
        return INGRESS_HOST, self.public_port, self.proxy_context

    def proxy_request(self, path, **kwargs):
        return self.request(path, target=self.proxy_target, **kwargs)

    def proxy_websocket(self, **kwargs):
        return self.websocket(target=self.proxy_target, **kwargs)

    def start_proxy(self, *, verify_name=INGRESS_HOST, trusted_ca=None):
        assert self.proxy_id is None
        ca = trusted_ca if trusted_ca is not None else (self.gateway.state / 'ca.crt').read_bytes()
        (self.proxy_runtime / 'upstream-ca.crt').write_bytes(ca)
        config = f'''pid /tmp/nginx.pid;
error_log /dev/stderr crit;
worker_processes 2;
events {{ worker_connections 1024; }}
http {{
    log_format status_only '$status';
    access_log /dev/stdout status_only;
    client_body_temp_path /tmp/client;
    proxy_temp_path /tmp/proxy;
    fastcgi_temp_path /tmp/fastcgi;
    uwsgi_temp_path /tmp/uwsgi;
    scgi_temp_path /tmp/scgi;
    map $http_upgrade $connection_upgrade {{ default upgrade; "" close; }}
    server {{
        listen 127.0.0.1:{self.public_port} ssl;
        server_name {INGRESS_HOST};
        ssl_certificate /proxy/tls.crt;
        ssl_certificate_key /proxy/tls.key;
        ssl_protocols TLSv1.2 TLSv1.3;
        proxy_ssl_verify on;
        proxy_ssl_trusted_certificate /proxy/upstream-ca.crt;
        proxy_ssl_verify_depth 2;
        proxy_ssl_server_name on;
        proxy_ssl_name {verify_name};
        location / {{
            proxy_bind 127.0.0.20;
            proxy_set_header Host $host;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection $connection_upgrade;
            proxy_http_version 1.1;
            proxy_read_timeout 3600s;
            proxy_buffering off;
            proxy_pass https://127.0.0.1:{self.port}$request_uri;
        }}
    }}
}}
'''
        (self.proxy_runtime / 'nginx.conf').write_text(config)
        name = 'rethink-ingress-test-' + secrets.token_hex(10)
        common = ['--pull', 'never', '--user', f'{os.getuid()}:{os.getgid()}', '--read-only',
                  '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
                  '--tmpfs', '/tmp:rw,noexec,nosuid,size=32m,mode=1777', '--mount',
                  f'type=bind,src={self.proxy_runtime},dst=/proxy,readonly',
                  '--label', f'org.rethink.synthetic-ingress={name}', '--entrypoint', 'nginx',
                  g.IMAGE, '-c', '/proxy/nginx.conf']
        g.run(['docker', 'run', '--rm', '--network', 'none'] + common + ['-t'])
        self.proxy_id = g.run(['docker', 'run', '-d', '--name', name, '--network', 'host'] +
                              common + ['-g', 'daemon off;']).decode().strip()
        deadline = time.monotonic() + 10
        while True:
            try:
                with socket.create_connection(('127.0.0.1', self.public_port), timeout=1) as raw:
                    with self.proxy_context.wrap_socket(raw, server_hostname=INGRESS_HOST):
                        return
            except OSError:
                if time.monotonic() > deadline:
                    raise RuntimeError('Synthetic ingress TLS readiness failed')
                time.sleep(0.1)

    def stop_proxy(self):
        if self.proxy_id:
            # The immutable ID came only from this fixture's successful docker run.
            g.run(['docker', 'stop', '--time', '2', self.proxy_id])
            g.run(['docker', 'rm', self.proxy_id])
            self.proxy_id = None

    def serve_certificate_for_negative_tls_test(self, certificate):
        # Only this synthetic peer bypasses startup validation to present broken TLS to nginx.
        assert self.gateway.test and self.gateway.name.startswith('rethink-gateway-test-')
        assert self.gateway.backend == f'127.0.0.1:{self.backend.server_port}'
        self.gateway.stop()
        (self.gateway.state / 'runtime/tls.crt').write_bytes(certificate)
        g.run(self.gateway.docker_args())
        deadline = time.monotonic() + 5
        while True:
            try:
                with socket.create_connection(('127.0.0.1', self.port), timeout=1):
                    return  # Readiness only; no TLS verification is bypassed by any client.
            except OSError:
                if time.monotonic() > deadline:
                    raise RuntimeError('Synthetic negative-TLS peer did not bind')
                time.sleep(0.1)

    def __exit__(self, *args):
        try:
            self.stop_proxy()
        finally:
            try:
                super().__exit__(*args)
            finally:
                self.port_patch.stop()


class Unit(unittest.TestCase):
    def test_external_hostname_is_one_canonical_dns_name(self):
        for value in (None, '', 'localhost', 'EXAMPLE.test', 'example.test.', '*.example.test',
                      'https://example.test', 'example.test:443', 'example.test/path',
                      '127.0.0.1', '999.1.2.3', '[::1]', 'a..test', '-a.test', 'a-.test',
                      'a_b.test', 'café.test', 'a.test\n', 'a' * 64 + '.test'):
            with self.subTest(value=value), self.assertRaises(g.GatewayError):
                g.hostname(value)
        self.assertEqual(g.hostname(INGRESS_HOST), INGRESS_HOST)
        self.assertEqual(g.EXTERNAL_PORT, 443)
        policy = g.config_text('10.0.0.1:8443', g.BACKEND, INGRESS_HOST)
        self.assertIn('https://management\\.example\\.test', policy)
        self.assertNotIn('https://management.example.test:443', policy)

    def test_production_limits_unchanged(self):
        self.assertEqual(g.LIMITS, {'peer_rate': 10, 'global_rate': 30, 'peer_burst': 60,
                                   'global_burst': 100, 'peer_connections': 32,
                                   'global_connections': 128})
        config = g.config_text('10.0.0.1:8443', g.BACKEND)
        # Golden digest of the frozen LAN-only predecessor, with synthetic inputs.
        self.assertEqual(hashlib.sha256(config.encode()).hexdigest(),
                         '1419719f96ea011a5438501d0385b0dceeb644145e70b75161e37aa617ddc343')
        for directive in ('zone=peer:1m rate=10r/s;', 'zone=global:1m rate=30r/s;',
                          'zone=peer burst=60 nodelay;', 'zone=global burst=100 nodelay;',
                          'limit_conn peer_conn 32;', 'limit_conn global_conn 128;'):
            self.assertIn(directive, config)

    def test_listener(self):
        for value in ('0.0.0.0:8443', '127.0.0.1:8443', '8.8.8.8:8443',
                      '169.254.1.1:8443', '[::1]:8443', 'localhost:8443',
                      '10.0.0.1:443', '10.0.0.1:08443', '10.0.0.1:65536', '10.0.0.1:8443\n'):
            with self.subTest(value=value), self.assertRaises(g.GatewayError):
                g.endpoint(value)
        self.assertEqual(g.endpoint('10.0.0.1:8443'), ('10.0.0.1', 8443))

    def test_private_files(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            path = root / 'data'
            g.write_new(path, 'private')
            g.private_path(path)
            with self.assertRaises(FileExistsError):
                g.write_new(path, 'overwrite')
            link = root / 'link'
            link.symlink_to(path)
            with self.assertRaises(g.GatewayError):
                g.private_path(link)
            with self.assertRaises(g.GatewayError):
                g.state_path(link / 'state')
            path.chmod(0o644)
            with self.assertRaises(g.GatewayError):
                g.private_path(path)
            path.chmod(0o600)
            os.link(path, root / 'hardlink')
            with self.assertRaises(g.GatewayError):
                g.private_path(path)

    def test_password(self):
        secret = secrets.token_urlsafe(32)
        hashed = g.password_hash(secret)
        self.assertTrue(hashed.startswith(('admin:$6$rounds=200000$', 'admin:$2')))
        self.assertNotIn(secret, hashed)


class Integration(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = Fixture().__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.fixture.__exit__(None, None, None)

    def test_01_auth_all_routes(self):
        f = self.fixture
        self.assertEqual(set(f.gateway.metadata()), {'schema', 'bind', 'uid', 'gid'})
        before = f.count()
        for path in ('/', '/index.html', '/api/status', '/missing', '/ws', '/device?id=synthetic', '/oauth/callback?code=fake'):
            for headers in ({}, {'Authorization': f.auth('wrong')}):
                self.assertEqual(f.request(path, headers=headers)[0], 401)
        self.assertEqual(f.request('/api/write', method='POST', headers={'Origin': f.origin})[0], 401)
        self.assertEqual(f.request('/', method='HEAD')[0], 401)
        sock, status = f.websocket(auth=False)
        sock.close()
        self.assertEqual(status, 401)
        self.assertEqual(f.count(), before)
        self.assertEqual(f.request('/', auth=True)[0], 200)
        self.assertEqual(f.request('/api/write', auth=True, method='POST', headers={'Origin': f.origin})[0], 200)

    def test_02_origin_and_aliases(self):
        f = self.fixture
        before = f.count()
        for headers in ({'Origin': 'null'}, {'Origin': 'https://foreign.invalid'},
                        {'Sec-Fetch-Site': 'cross-site'}, {'Sec-Fetch-Site': 'same-site'},
                        {'Host': 'foreign.invalid'}, {'Sec-Fetch-Site': 'invalid'}):
            self.assertIn(f.request('/', auth=True, headers=headers)[0], (403, 421))
        for method in ('POST', 'PUT', 'DELETE', 'OPTIONS'):
            self.assertEqual(f.request('/write', auth=True, method=method)[0], 403)
        for path in ('/thinq_login', '/THINQ_LOGIN', '/ThInQ_LoGiN/', '/%74hinq_login',
                     '/a/../thinq_login', '/thinq_login?x=1'):
            for method in ('GET', 'HEAD'):
                self.assertEqual(f.request(path, auth=True, method=method)[0], 403)
        self.assertEqual(f.request('/socket', auth=True, headers={
            'Upgrade': 'websocket, other', 'Connection': 'Upgrade'})[0], 403)
        sock, status = f.websocket(origin=False)
        sock.close()
        self.assertEqual(status, 403)
        self.assertEqual(f.count(), before)
        self.assertEqual(f.request('/thinq_login', auth=True,
                                 headers={'Sec-Fetch-Site': 'same-origin'})[0], 200)

    def test_03_tls_forwarding_ws(self):
        f = self.fixture
        with self.assertRaises(ssl.SSLCertVerificationError):
            f.request('/', context=ssl.create_default_context())
        with socket.create_connection(('127.0.0.1', f.port)) as raw:
            with self.assertRaises(ssl.SSLCertVerificationError):
                f.context.wrap_socket(raw, server_hostname='localhost')
        status, body = f.request('/headers', auth=True, headers={
            'Forwarded': 'for=forged', 'X-Forwarded-For': 'forged', 'X-Real-IP': 'forged',
            'X-Forwarded-Host': 'forged', 'X-Forwarded-Proto': 'http', 'Proxy-Authorization': 'fake'})
        self.assertEqual(status, 200)
        headers = json.loads(body)['headers']
        self.assertNotIn('Authorization', headers)
        self.assertNotIn('Proxy-Authorization', headers)
        self.assertNotIn('Forwarded', headers)
        self.assertEqual(headers['X-Forwarded-For'], '127.0.0.1')
        self.assertEqual(headers['X-Forwarded-Proto'], 'https')
        sock, status = f.websocket()
        try:
            self.assertEqual(status, 101)
            mask = b'abcd'
            payload = b'hello'
            sock.sendall(b'\x81\x85' + mask + bytes(c ^ mask[i % 4] for i, c in enumerate(payload)))
            received = b''
            while len(received) < 7:
                received += sock.recv(7 - len(received))
            self.assertEqual(received, b'\x81\x05hello')
        finally:
            sock.close()

    def test_04_limits(self):
        f = self.fixture
        before = f.count()
        with ThreadPoolExecutor(max_workers=24) as pool:
            codes = list(pool.map(lambda _: f.request('/limit')[0], range(140)))
        self.assertIn(429, codes)
        self.assertTrue(set(codes) <= {401, 429})
        self.assertEqual(f.count(), before)
        time.sleep(7)  # Refill the configured peer burst before lifecycle assertions.

    def test_05_rotation_and_preservation(self):
        f = self.fixture
        old_password = f.password
        backend_id = id(f.backend)
        sock, status = f.websocket()
        self.assertEqual(status, 101)
        f.gateway.rotate()
        try:
            self.assertEqual(sock.recv(1), b'')
        except (ConnectionResetError, ssl.SSLError):
            pass
        finally:
            sock.close()
        self.assertNotEqual(old_password, f.password)
        self.assertEqual(f.request('/', headers={'Authorization': f.auth(old_password)})[0], 401)
        self.assertEqual(f.request('/', auth=True)[0], 200)
        self.assertEqual(id(f.backend), backend_id)
        self.assertEqual(f.backend.server_port, int(f.gateway.backend.split(':')[1]))
        f.gateway.check()
        with self.assertRaises(FileExistsError):
            f.gateway.initialize(f'127.0.0.1:{f.port}')


def assert_echo(test, sock):
    payload, mask = b'alive', b'abcd'
    sock.sendall(b'\x81\x85' + mask + bytes(c ^ mask[i % 4] for i, c in enumerate(payload)))
    received = b''
    while len(received) < 7:
        chunk = sock.recv(7 - len(received))
        test.assertTrue(chunk, 'Held synthetic WebSocket closed unexpectedly')
        received += chunk
    test.assertEqual(received, b'\x81\x05alive')


class IsolatedLimits(unittest.TestCase):
    # Only this test process patches constants. Each scenario owns a fresh nginx zone.
    RELAXED = {'peer_rate': 1000, 'global_rate': 1000, 'peer_burst': 1000,
               'global_burst': 1000, 'peer_connections': 16, 'global_connections': 32}

    def test_per_peer_request_rate_and_forwarding_spoof(self):
        profile = self.RELAXED | {'peer_rate': 1, 'peer_burst': 1}
        with patch.dict(g.LIMITS, profile), Fixture() as f:
            before = f.count()
            codes = [f.request('/limit-peer', peer='127.0.0.11', headers={
                'X-Forwarded-For': f'127.0.0.{100 + i}',
                'Forwarded': f'for=127.0.0.{100 + i}'})[0] for i in range(3)]
            self.assertEqual(codes, [401, 401, 429])
            self.assertEqual(f.request('/limit-peer', peer='127.0.0.12')[0], 401)
            self.assertEqual(f.count(), before)

    def test_global_request_rate_across_real_peers(self):
        profile = self.RELAXED | {'global_rate': 1, 'global_burst': 1}
        with patch.dict(g.LIMITS, profile), Fixture() as f:
            before = f.count()
            codes = [f.request('/limit-global', peer=f'127.0.0.{11 + i}', headers={
                'X-Forwarded-For': f'127.0.0.{100 + i}',
                'Forwarded': f'for=127.0.0.{100 + i}'})[0] for i in range(3)]
            self.assertEqual(codes, [401, 401, 429])
            self.assertEqual(f.count(), before)

    def hold(self, stack, f, peer, spoof, expected):
        sock, status = f.websocket(peer=peer, spoof=spoof, path='/device?id=synthetic')
        stack.callback(sock.close)
        self.assertEqual(status, expected)
        return sock

    def test_per_peer_concurrent_websockets(self):
        profile = self.RELAXED | {'peer_connections': 2}
        with patch.dict(g.LIMITS, profile), Fixture() as f, contextlib.ExitStack() as stack:
            first = self.hold(stack, f, '127.0.0.11', '127.0.0.101', 101)
            second = self.hold(stack, f, '127.0.0.11', '127.0.0.102', 101)
            before = f.count()
            self.hold(stack, f, '127.0.0.11', '127.0.0.103', 429)
            self.assertEqual(f.count(), before)
            other = self.hold(stack, f, '127.0.0.12', '127.0.0.101', 101)
            for sock in (first, second, other):
                assert_echo(self, sock)
            seen = f.backend.seen
            self.assertEqual([r['headers']['X-Forwarded-For'] for r in seen],
                             ['127.0.0.11', '127.0.0.11', '127.0.0.12'])
            first.close()
            self.assert_slot_recovers(f, '127.0.0.11')

    def test_global_concurrent_websockets_across_real_peers(self):
        profile = self.RELAXED | {'peer_connections': 2, 'global_connections': 3}
        with patch.dict(g.LIMITS, profile), Fixture() as f, contextlib.ExitStack() as stack:
            held = [self.hold(stack, f, f'127.0.0.{11 + i}', f'127.0.0.{101 + i}', 101)
                    for i in range(3)]
            before = f.count()
            self.hold(stack, f, '127.0.0.14', '127.0.0.104', 429)
            self.assertEqual(f.count(), before)
            for sock in held:
                assert_echo(self, sock)
            self.assertEqual([r['headers']['X-Forwarded-For'] for r in f.backend.seen],
                             ['127.0.0.11', '127.0.0.12', '127.0.0.13'])
            held[0].close()
            self.assert_slot_recovers(f, '127.0.0.14')

    def assert_slot_recovers(self, f, peer):
        deadline = time.monotonic() + 3
        while True:
            sock, status = f.websocket(peer=peer)
            sock.close()
            if status == 101:
                return
            self.assertEqual(status, 429)
            self.assertLess(time.monotonic(), deadline, 'Closed WebSocket slot was not released')
            time.sleep(0.05)


class StartupFailures(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = Fixture(start=False).__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.fixture.__exit__(None, None, None)

    def assert_preserved(self, *, occupied=False):
        f = self.fixture
        self.assertIsNone(f.gateway.inspect(), 'Negative startup created a gateway container')
        self.assertEqual(f.count(), 0, 'Negative startup reached the synthetic backend')
        connection = http.client.HTTPConnection('127.0.0.1', f.backend.server_port, timeout=3)
        try:
            connection.request('GET', '/fixture-stats')
            response = connection.getresponse()
            self.assertEqual(response.status, 200)
            self.assertEqual(json.loads(response.read()), [])
        finally:
            connection.close()
        if not occupied:
            with socket.socket() as probe:
                probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                probe.bind(('127.0.0.1', f.port))
                probe.listen()  # A successful bind proves no gateway listener was left behind.

    @contextlib.contextmanager
    def altered_file(self, path, content):
        original = path.read_bytes()
        try:
            if content is None:
                path.unlink()
            else:
                path.write_bytes(content)
            yield
        finally:
            if path.exists():
                path.write_bytes(original)
            else:
                g.write_new(path, original)

    def assert_rejected(self):
        gateway = self.fixture.gateway
        with self.no_persistent_lifecycle():
            for operation in (gateway.validate, gateway.start):
                with self.assertRaises((g.GatewayError, OSError, ValueError)):
                    operation()
        self.assert_preserved()

    @contextlib.contextmanager
    def no_persistent_lifecycle(self):
        calls, real_run = [], g.run
        def recorded(argv, **kwargs):
            calls.append(argv)
            return real_run(argv, **kwargs)
        with patch.object(g, 'run', side_effect=recorded):
            yield
        # Network-isolated, --rm syntax checks may run; a persistent gateway may not.
        self.assertFalse([a for a in calls if a[:2] in (
            ['docker', 'stop'], ['docker', 'rm']) or a[:3] == ['docker', 'run', '-d']])

    def test_missing_empty_malformed_credentials_and_tls(self):
        state = self.fixture.gateway.state
        for relative in ('runtime/auth', 'runtime/tls.crt', 'runtime/tls.key', 'ca.crt'):
            for label, content in (('missing', None), ('empty', b''), ('malformed', b'invalid\n')):
                with self.subTest(file=relative, condition=label):
                    with self.altered_file(state / relative, content):
                        self.assert_rejected()

    def signed_leaf(self, label, start, end, *, san='127.0.0.1'):
        f = self.fixture
        certificate = sign_certificate(Path(f.temp.name) / label, f.gateway.state / 'ca.crt',
                                       f.gateway.state / 'ca.key', f.gateway.state / 'runtime/tls.key',
                                       'IP:' + san, start, end)
        dates = g.run(['openssl', 'x509', '-in', str(certificate), '-noout', '-startdate', '-enddate'])
        self.assertIn(b'notBefore=', dates)
        self.assertIn(b'notAfter=', dates)
        return certificate.read_bytes()

    def test_real_expired_near_expiry_and_wrong_san_certificates(self):
        now = datetime.now(timezone.utc)
        cases = [('expired', now - timedelta(days=2), now - timedelta(days=1), '127.0.0.1'),
                 ('near-expiry', now - timedelta(hours=1), now + timedelta(hours=1), '127.0.0.1'),
                 ('wrong-san', now - timedelta(hours=1), now + timedelta(days=7), '127.0.0.2')]
        for label, start, end, san in cases:
            with self.subTest(condition=label):
                content = self.signed_leaf(label, start, end, san=san)
                with self.altered_file(self.fixture.gateway.state / 'runtime/tls.crt', content):
                    self.assert_rejected()

    def test_valid_mismatched_key_and_wrong_ca(self):
        f = self.fixture
        directory = Path(f.temp.name) / 'other-ca'
        directory.mkdir(mode=0o700)
        key, ca = directory / 'key.pem', directory / 'ca.crt'
        g.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256',
               '-days', '7', '-subj', '/CN=Unrelated Synthetic CA',
               '-addext', 'basicConstraints=critical,CA:TRUE', '-keyout', str(key), '-out', str(ca)])
        g.run(['openssl', 'pkey', '-in', str(key), '-check', '-noout'])
        g.run(['openssl', 'verify', '-CAfile', str(ca), str(ca)])
        for relative, content in (('runtime/tls.key', key.read_bytes()), ('ca.crt', ca.read_bytes())):
            with self.subTest(file=relative), self.altered_file(f.gateway.state / relative, content):
                self.assert_rejected()

    def test_invalid_or_changed_listener_settings(self):
        path = self.fixture.gateway.state / 'settings.json'
        original = json.loads(path.read_text())
        for bind in ('', '0.0.0.0:8443', '8.8.8.8:8443', 'localhost:8443',
                     '127.0.0.1:65536', '127.0.0.2:8443'):
            with self.subTest(bind=bind):
                changed = json.dumps(original | {'bind': bind}).encode()
                with self.altered_file(path, changed):
                    self.assert_rejected()

    def test_real_occupied_listener(self):
        f = self.fixture
        with socket.socket() as listener:
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            listener.bind(('127.0.0.1', f.port))
            listener.listen()
            identity = listener.fileno()
            with self.no_persistent_lifecycle():
                with self.assertRaisesRegex(g.GatewayError, 'Exact listener is unavailable'):
                    f.gateway.start()
            self.assertEqual(listener.fileno(), identity)
            self.assertEqual(listener.getsockname(), ('127.0.0.1', f.port))
            self.assert_preserved(occupied=True)
        self.assert_preserved()

    def test_unavailable_bind_deterministic_injection(self):
        # Linux can bind any 127/8 address. Inject only EADDRNOTAVAIL in the real probe;
        # claiming a physically unassigned LAN interface would cross the fixture boundary.
        f, real_socket = self.fixture, socket.socket
        attempts = []
        class UnavailableSocket(real_socket):
            def bind(self, address):
                if address == ('127.0.0.1', f.port):
                    attempts.append(address)
                    raise OSError(errno.EADDRNOTAVAIL, 'Synthetic unavailable bind')
                return super().bind(address)
        with self.no_persistent_lifecycle(), patch.object(g.socket, 'socket', UnavailableSocket):
            with self.assertRaisesRegex(g.GatewayError, 'Exact listener is unavailable'):
                f.gateway.start()
        self.assertEqual(attempts, [('127.0.0.1', f.port)])
        self.assert_preserved()


class IdentityRefusal(unittest.TestCase):
    def test_changed_container_identity_never_stops_or_removes(self):
        mutations = [
            (('Config', 'Labels', g.LABEL), 'wrong-owner'),
            (('Config', 'Image'), 'unrelated:latest'),
            (('Config', 'User'), '0:0'),
            (('Config', 'Cmd'), ['-v']),
            (('Config', 'Entrypoint'), ['/bin/sh']),
            (('HostConfig', 'NetworkMode'), 'bridge'),
            (('HostConfig', 'ReadonlyRootfs'), False),
            (('HostConfig', 'CapDrop'), []),
            (('HostConfig', 'Privileged'), True),
            (('HostConfig', 'CapAdd'), ['NET_ADMIN']),
            (('HostConfig', 'Devices'), [{'PathOnHost': '/dev/synthetic'}]),
            (('HostConfig', 'SecurityOpt'), []),
            (('HostConfig', 'RestartPolicy', 'Name'), 'always'),
            (('HostConfig', 'Tmpfs'), {}),
            (('Mounts', 0, 'Type'), 'volume'),
            (('Mounts', 0, 'Source'), '/synthetic-unowned-state'),
            (('Mounts', 0, 'Destination'), '/unrelated'),
            (('Mounts', 0, 'RW'), True),
        ]
        with Fixture() as f:
            original = f.gateway.inspect()
            password = (f.gateway.state / 'password.txt').read_bytes()
            auth = (f.gateway.state / 'runtime/auth').read_bytes()
            for key_path, value in mutations:
                changed = json.loads(json.dumps(original))
                target = changed
                for key in key_path[:-1]:
                    target = target[key]
                target[key_path[-1]] = value
                for command in ('check', 'start', 'stop', 'rotate'):
                    calls, real_run = [], g.run
                    def altered(argv, **kwargs):
                        calls.append(argv)
                        if argv[:2] == ['docker', 'inspect']:
                            return json.dumps([changed]).encode()
                        return real_run(argv, **kwargs)
                    with self.subTest(field=key_path, command=command):
                        with patch.object(g, 'run', side_effect=altered):
                            with self.assertRaisesRegex(g.GatewayError, 'conflicts'):
                                getattr(f.gateway, command)()
                        self.assertFalse([a for a in calls if a[:2] in (
                            ['docker', 'stop'], ['docker', 'rm'], ['docker', 'run'])])
            self.assertEqual((f.gateway.state / 'password.txt').read_bytes(), password)
            self.assertEqual((f.gateway.state / 'runtime/auth').read_bytes(), auth)
            self.assertEqual(f.gateway.inspect()['Id'], original['Id'])
            self.assertEqual(f.count(), 0)
            self.assertEqual(f.request('/', auth=True)[0], 200)


class IngressPolicy(unittest.TestCase):
    def test_production_443_pairs_and_private_metadata(self):
        with Fixture(external_hostname=INGRESS_HOST) as f:
            self.assertEqual(g.EXTERNAL_PORT, 443)
            self.assertEqual(f.gateway.metadata()['external_hostname'], INGRESS_HOST)
            f.gateway.check()
            external = 'https://' + INGRESS_HOST
            lan_host = f'127.0.0.1:{f.port}'
            for host, origin in ((lan_host, f.origin), (INGRESS_HOST, external),
                                 (INGRESS_HOST + ':443', external)):
                with self.subTest(host=host):
                    self.assertEqual(f.request('/api/write', method='POST', auth=True,
                                               headers={'Host': host, 'Origin': origin})[0], 200)
                    self.assertEqual(f.request('/', auth=True, headers={'Host': host})[0], 200)
                    sock, status = f.websocket(host_header=host, origin=origin)
                    sock.close()
                    self.assertEqual(status, 101)
            before = f.count()
            for host, origin in ((lan_host, external), (INGRESS_HOST, f.origin),
                                 (INGRESS_HOST + ':443', f.origin),
                                 (INGRESS_HOST, external + ':443'),
                                 (INGRESS_HOST, 'http://' + INGRESS_HOST),
                                 (INGRESS_HOST, 'null'), (INGRESS_HOST, 'https://foreign.example.test'),
                                 (INGRESS_HOST.upper(), external),
                                 (INGRESS_HOST + ':8443', external), ('foreign.example.test', external)):
                with self.subTest(host=host, origin=origin):
                    self.assertIn(f.request('/api/write', method='POST', auth=True,
                                            headers={'Host': host, 'Origin': origin})[0], (403, 421))
                    sock, status = f.websocket(host_header=host, origin=origin)
                    sock.close()
                    self.assertIn(status, (403, 421))
            self.assertEqual(f.request('/api/write', auth=True, method='POST',
                                       headers={'Host': INGRESS_HOST})[0], 403)
            self.assertEqual(f.count(), before)
            headers = {'Host': INGRESS_HOST, 'Origin': external, 'Sec-Fetch-Site': 'same-origin'}
            self.assertEqual(f.request('/thinq_login', auth=True, headers=headers)[0], 200)

    def test_exact_ip_and_dns_san_set_and_no_port_metadata_override(self):
        with Fixture(start=False, external_hostname=INGRESS_HOST) as f:
            state = f.gateway.state
            original = (state / 'runtime/tls.crt').read_bytes()
            now = datetime.now(timezone.utc)
            for index, san in enumerate(('IP:127.0.0.1', 'IP:127.0.0.1,DNS:wrong.example.test',
                                         f'IP:127.0.0.1,DNS:{INGRESS_HOST},DNS:extra.example.test',
                                         f'IP:127.0.0.2,DNS:{INGRESS_HOST}')):
                with self.subTest(san=san):
                    certificate = sign_certificate(Path(f.temp.name) / f'san-{index}', state / 'ca.crt',
                                                   state / 'ca.key', state / 'runtime/tls.key', san,
                                                   now - timedelta(hours=1), now + timedelta(days=7))
                    (state / 'runtime/tls.crt').write_bytes(certificate.read_bytes())
                    try:
                        with self.assertRaises(g.GatewayError):
                            f.gateway.start()
                        self.assertIsNone(f.gateway.inspect())
                        self.assertEqual(f.count(), 0)
                    finally:
                        (state / 'runtime/tls.crt').write_bytes(original)
            settings = state / 'settings.json'
            original_settings = settings.read_bytes()
            settings.write_text(json.dumps(json.loads(original_settings) | {'external_port': 8443}))
            try:
                with self.assertRaises(g.GatewayError):
                    f.gateway.start()
            finally:
                settings.write_bytes(original_settings)
            f.gateway.validate()


class IngressChain(unittest.TestCase):
    def test_auth_header_preservation_websockets_and_rotation_through_verified_proxy(self):
        with IngressFixture() as f:
            before = f.count()
            for route in ('/', '/api/read', '/ws', '/device?id=synthetic', '/unknown'):
                self.assertEqual(f.proxy_request(route)[0], 401)
                self.assertEqual(f.proxy_request(route, headers={'Authorization': f.auth('wrong')})[0], 401)
            for route in ('/ws', '/device?id=synthetic'):
                sock, status = f.proxy_websocket(path=route, auth=False)
                sock.close()
                self.assertEqual(status, 401)
            self.assertEqual(f.count(), before)
            status, body = f.proxy_request('/headers', auth=True, headers={
                'Origin': f.public_origin, 'Forwarded': 'for=forged', 'X-Forwarded-For': 'forged'})
            self.assertEqual(status, 200)
            headers = json.loads(body)['headers']
            self.assertEqual(headers['Host'], f'{INGRESS_HOST}:{f.public_port}')
            self.assertEqual(headers['Origin'], f.public_origin)
            self.assertEqual(headers['X-Forwarded-For'], '127.0.0.20')
            self.assertNotIn('Authorization', headers)
            self.assertNotIn('Forwarded', headers)
            with contextlib.ExitStack() as stack:
                for route in ('/ws', '/device?id=synthetic'):
                    sock, status = f.proxy_websocket(path=route)
                    stack.callback(sock.close)
                    self.assertEqual(status, 101)
                    assert_echo(self, sock)
                old_password, proxy_id = f.password, f.proxy_id
                f.gateway.rotate()
                self.assertEqual(sock.recv(1), b'')
                self.assertEqual(f.proxy_id, proxy_id)
                self.assertEqual(f.proxy_request('/', headers={'Authorization': f.auth(old_password)})[0], 401)
                self.assertEqual(f.proxy_request('/', auth=True)[0], 200)

    def test_upstream_ca_name_expiry_and_missing_intermediate_fail_closed(self):
        with IngressFixture() as f:
            def denied():
                before = f.count()
                self.assertEqual(f.proxy_request('/tls-negative', auth=True)[0], 502)
                self.assertEqual(f.count(), before)

            for options in ({'verify_name': 'wrong.example.test'},
                            {'trusted_ca': f.frontend_ca.read_bytes()}):
                with self.subTest(failure=next(iter(options))):
                    f.stop_proxy()
                    f.start_proxy(**options)
                    denied()
            f.stop_proxy()
            f.start_proxy()
            state, now = f.gateway.state, datetime.now(timezone.utc)
            original = (state / 'runtime/tls.crt').read_bytes()
            san = f'IP:127.0.0.1,DNS:{INGRESS_HOST}'
            expired = sign_certificate(Path(f.temp.name) / 'expired-upstream', state / 'ca.crt',
                                       state / 'ca.key', state / 'runtime/tls.key', san,
                                       now - timedelta(days=2), now - timedelta(days=1))
            try:
                f.serve_certificate_for_negative_tls_test(expired.read_bytes())
                with self.assertRaises(g.GatewayError):
                    f.gateway.validate()
                denied()

                chain = Path(f.temp.name) / 'chain'
                chain.mkdir(mode=0o700)
                root_key, root_cert = chain / 'root.key', chain / 'root.crt'
                g.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256',
                       '-days', '30', '-subj', '/CN=Synthetic Chain Root',
                       '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:1',
                       '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
                       '-keyout', str(root_key), '-out', str(root_cert)])
                intermediate_key = chain / 'intermediate.key'
                g.run(['openssl', 'genpkey', '-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:2048',
                       '-out', str(intermediate_key)])
                intermediate = sign_certificate(chain / 'intermediate', root_cert, root_key,
                                                intermediate_key, '', now - timedelta(hours=1),
                                                now + timedelta(days=7), ca=True)
                leaf = sign_certificate(chain / 'leaf', intermediate, intermediate_key,
                                        state / 'runtime/tls.key', san, now - timedelta(hours=1),
                                        now + timedelta(days=3))
                f.stop_proxy()
                f.start_proxy(trusted_ca=root_cert.read_bytes())
                f.serve_certificate_for_negative_tls_test(leaf.read_bytes())
                denied()
                # Same trust anchor/name/key succeeds once the missing issuer is presented.
                f.serve_certificate_for_negative_tls_test(leaf.read_bytes() + intermediate.read_bytes())
                self.assertEqual(f.proxy_request('/complete-chain', auth=True)[0], 200)
            finally:
                f.gateway.stop()
                (state / 'runtime/tls.crt').write_bytes(original)
                f.gateway.start()
                f.stop_proxy()
                f.start_proxy()
            self.assertEqual(f.proxy_request('/restored', auth=True)[0], 200)


class IngressSharedLimits(unittest.TestCase):
    def test_distinct_ingress_clients_share_proxy_request_bucket(self):
        profile = IsolatedLimits.RELAXED | {'peer_rate': 1, 'peer_burst': 1}
        with patch.dict(g.LIMITS, profile), IngressFixture() as f:
            codes = [f.proxy_request('/shared-peer', peer=f'127.0.0.{31 + i}',
                                     headers={'X-Forwarded-For': f'127.0.0.{101 + i}'})[0]
                     for i in range(3)]
            self.assertEqual(codes, [401, 401, 429])
            self.assertEqual(f.request('/separate-lan-peer', peer='127.0.0.12')[0], 401)
            self.assertEqual(f.count(), 0)

    def test_distinct_ingress_clients_share_proxy_websocket_bucket(self):
        profile = IsolatedLimits.RELAXED | {'peer_connections': 2}
        with patch.dict(g.LIMITS, profile), IngressFixture() as f, contextlib.ExitStack() as stack:
            held = []
            for i, expected in enumerate((101, 101, 429)):
                sock, status = f.proxy_websocket(peer=f'127.0.0.{31 + i}', spoof=f'127.0.0.{101 + i}')
                stack.callback(sock.close)
                self.assertEqual(status, expected)
                if status == 101:
                    held.append(sock)
            self.assertEqual(f.count(), 2)
            self.assertEqual([r['headers']['X-Forwarded-For'] for r in f.backend.seen],
                             ['127.0.0.20', '127.0.0.20'])
            for sock in held:
                assert_echo(self, sock)
            direct, status = f.websocket(peer='127.0.0.12')
            stack.callback(direct.close)
            self.assertEqual(status, 101)


class SyntaxNamespace(unittest.TestCase):
    def test_production_rfc1918_check_uses_only_namespaced_nonlocal_bind(self):
        source_before = source_inventory()
        with tempfile.TemporaryDirectory(prefix='rethink-syntax-test-') as temporary:
            gateway = g.Gateway(Path(temporary) / 'state')
            gateway.name = 'rethink-syntax-test-' + secrets.token_hex(10)
            self.assertFalse(gateway.test)
            # A synthetic address is used only inside network-none; never call start here.
            bind = '10.254.253.252:18443'
            gateway.initialize(bind, INGRESS_HOST)
            before = {str(p.relative_to(gateway.state)): (p.stat().st_mode, hashlib.sha256(p.read_bytes()).hexdigest())
                      for p in gateway.state.rglob('*') if p.is_file()}
            expected_production = [
                'docker', 'run', '-d', '--name', gateway.name,
                '--pull', 'never', '--network', 'host',
                '--user', f'{os.getuid()}:{os.getgid()}', '--read-only',
                '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
                '--tmpfs', '/tmp:rw,noexec,nosuid,size=32m,mode=1777',
                '--mount', f'type=bind,src={gateway.state / "runtime"},dst=/gateway,readonly',
                '--label', f'{g.LABEL}={gateway.identity()}', '--entrypoint', 'nginx', g.IMAGE,
                '-c', '/gateway/nginx.conf', '-g', 'daemon off;']
            self.assertEqual(gateway.docker_args(), expected_production)
            self.assertNotIn('--sysctl', gateway.docker_args())
            syntax = gateway.docker_args(syntax=True)
            expected_syntax = (['docker', 'run', '--rm', '--sysctl', 'net.ipv4.ip_nonlocal_bind=1'] +
                               expected_production[5:-2] + ['-t'])
            expected_syntax[expected_syntax.index('--network') + 1] = 'none'
            self.assertEqual(syntax, expected_syntax)
            negative = syntax.copy()
            negative[negative.index('--sysctl') + 1] = 'net.ipv4.ip_nonlocal_bind=0'
            result = subprocess.run(negative, capture_output=True, check=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(b'syntax is ok', result.stderr)
            self.assertIn(f'bind() to {bind}'.encode(), result.stderr)
            self.assertIn(f'failed ({errno.EADDRNOTAVAIL}:'.encode(), result.stderr)
            print('Expected negative control: nonlocal_bind=0 rejects the isolated RFC1918 bind', flush=True)

            calls, real_run = [], g.run
            def recorded(argv, **kwargs):
                calls.append(argv)
                return real_run(argv, **kwargs)
            with patch.object(g, 'run', side_effect=recorded):
                gateway.check()  # Actual production-mode validation/check, with the unique fixture name.
            self.assertEqual([argv for argv in calls if argv[:2] == ['docker', 'run']], [syntax])
            self.assertFalse([argv for argv in calls if argv[:2] in (
                ['docker', 'stop'], ['docker', 'rm'])])
            self.assertEqual(gateway.docker_args(), expected_production)
            after = {str(p.relative_to(gateway.state)): (p.stat().st_mode, hashlib.sha256(p.read_bytes()).hexdigest())
                     for p in gateway.state.rglob('*') if p.is_file()}
            self.assertEqual(after, before, 'Syntax checking changed private fixture state')
            self.assertEqual(g.run(['docker', 'container', 'ls', '-aq', '--filter',
                                   f'label={g.LABEL}={gateway.identity()}']).strip(), b'')
            self.assertIsNone(gateway.inspect())
            print('Positive control: nonlocal_bind=1 passes without a production container', flush=True)
        self.assertFalse(Path(temporary).exists())
        self.assertEqual(source_inventory(), source_before)


def source_inventory():
    root = Path(__file__).resolve().parents[2]
    inventory = {}
    for path in sorted(root.rglob('*')):
        if any(part in ('node_modules', 'dist') for part in path.relative_to(root).parts):
            continue
        if path.is_symlink():
            inventory[str(path.relative_to(root))] = ('symlink', os.readlink(path))
        elif path.is_file():
            inventory[str(path.relative_to(root))] = (
                path.stat().st_mode, hashlib.sha256(path.read_bytes()).hexdigest())
    return inventory


def verify_session_lifecycle(f):
    """Actual isolated partial-start rollback, then exact inspected-identity refusal."""
    old = {name: (f.gateway.state / name).read_bytes() for name in
           ('settings.json', 'runtime/nginx.conf', 'password.txt', 'ca.crt', 'ca.key',
            'runtime/tls.crt', 'runtime/tls.key', 'runtime/auth')}
    original_start = f.gateway.start_session
    def partial_start():
        original_start()
        raise g.GatewayError('Injected failure after the synthetic sidecar starts')
    with patch.object(f.gateway, 'start_session', side_effect=partial_start):
        try:
            f.gateway.enable_sessions()
        except g.GatewayError as error:
            assert 'preimage restored' in str(error)
        else:
            raise AssertionError('Injected partial start did not fail')
    assert all((f.gateway.state / name).read_bytes() == value for name, value in old.items())
    assert f.gateway.inspect()['State']['Running']
    assert f.gateway.inspect_session() is None
    assert f.request('/api/read', auth=True)[0] == 200
    f.gateway.enable_sessions()
    verifier = f.gateway.state / 'sockets' / 'verifier.sock'
    inode = verifier.stat().st_ino
    f.gateway.check()
    assert verifier.stat().st_ino == inode, 'Syntax check changed the running verifier socket'
    obj = f.gateway.inspect_session()
    mutations = (
        lambda o: o['Config'].__setitem__('Image', 'wrong-image'),
        lambda o: o['Config'].__setitem__('User', '0:0'),
        lambda o: o['Config'].__setitem__('Cmd', ['wrong-command']),
        lambda o: o['Config'].__setitem__('Env', ['NODE_OPTIONS=--inspect=0.0.0.0:9229']),
        lambda o: o['Config'].__setitem__('WorkingDir', '/tmp'),
        lambda o: o['Config']['Labels'].__setitem__(g.LABEL, 'wrong-owner'),
        lambda o: o['HostConfig'].__setitem__('NetworkMode', 'bridge'),
        lambda o: o['HostConfig'].__setitem__('ReadonlyRootfs', False),
        lambda o: o['HostConfig'].__setitem__('CapDrop', []),
        lambda o: o['HostConfig'].__setitem__('SecurityOpt', []),
        lambda o: o['Mounts'][0].__setitem__('Source', '/tmp/unowned-synthetic'),
        lambda o: next(m for m in o['Mounts'] if m['Destination'] == '/settings/session.json').__setitem__('RW', True),
    )
    real_run = g.run
    for mutate in mutations:
        changed = json.loads(json.dumps(obj))
        mutate(changed)
        assert changed != obj, 'Identity test mutation must actually change its field'
        effects = []
        def inspect_changed(argv, **kwargs):
            if argv[:2] in (['docker', 'stop'], ['docker', 'rm']):
                effects.append(argv)
                raise AssertionError('Lifecycle mutation after identity mismatch')
            if argv[:2] == ['docker', 'inspect'] and obj['Id'].startswith(argv[2]):
                return json.dumps([changed]).encode()
            return real_run(argv, **kwargs)
        with patch.object(g, 'run', side_effect=inspect_changed):
            try:
                f.gateway.stop()
            except g.GatewayError:
                pass
            else:
                raise AssertionError('Changed sidecar identity was accepted')
        assert not effects
    assert f.gateway.inspect_session()['State']['Running']
    with patch.object(g, 'session_source', return_value=('0' * 64, {})):
        try:
            f.gateway.start()
        except g.GatewayError:
            pass
        else:
            raise AssertionError('Start accepted mismatched source')
        f.gateway.stop()  # Retained immutable identities remain stoppable after a source update.
    assert f.gateway.inspect_session() is None
    f.gateway.start()
    assert f.backend._BaseServer__is_shut_down.is_set() is False


def main():
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--unit', action='store_true')
    mode.add_argument('--integration', action='store_true')
    mode.add_argument('--fixture', action='store_true')
    mode.add_argument('--fixture-ingress', action='store_true')
    mode.add_argument('--fixture-session', action='store_true')
    mode.add_argument('--fixture-session-ingress', action='store_true')
    mode.add_argument('--fixture-session-short', action='store_true')
    mode.add_argument('--acceptance', action='store_true')
    args = parser.parse_args()
    if args.acceptance:
        before = source_inventory()
        try:
            for phase in ('--unit', '--integration'):
                print('Acceptance phase: ' + phase, flush=True)
                result = subprocess.run([sys.executable, '-B', str(Path(__file__).resolve()), phase],
                                        check=False)
                if result.returncode:
                    return result.returncode if result.returncode > 0 else 1
            print('Acceptance phase: trusted Chromium browser', flush=True)
            result = subprocess.run(['node', str(Path(__file__).with_name('browser.mjs').resolve())],
                                    check=False)
            if result.returncode:
                return result.returncode if result.returncode > 0 else 1
        finally:
            if source_inventory() != before:
                raise RuntimeError('Acceptance modified the source inventory')
        print('PASS: combined AUTH ORIGIN TLS LIMITS LIFECYCLE PRESERVE SOURCE coverage; '
              'independent acceptance remains separate', flush=True)
        return 0
    session_mode = args.fixture_session or args.fixture_session_ingress or args.fixture_session_short
    ingress_mode = args.fixture_ingress or args.fixture_session_ingress
    if args.fixture or ingress_mode or session_mode:
        with (IngressFixture() if ingress_mode else Fixture()) as f:
            preserved = None
            if session_mode:
                f.backend.session_ui = True
                preserved = {name: (f.gateway.state / name).read_bytes() for name in ('password.txt', 'ca.crt', 'ca.key', 'runtime/tls.crt', 'runtime/tls.key', 'runtime/auth')}
                duration = 12000 if args.fixture_session_short or args.fixture_session_ingress else 600000
                script = ('import {createService} from "./service.mjs"; import {createAuthority} from "./session-store.mjs"; import fs from "node:fs"; '
                          + 'const s=createService({socketPath:"/sockets/session.sock",verifierPath:"/sockets/verifier.sock",hosts:JSON.parse(fs.readFileSync("/settings/session.json")).hosts,backend:'
                          + json.dumps('http://' + f.gateway.backend) + ',authority:createAuthority({duration:' + str(duration) + '})});await s.listen();process.on("SIGTERM",()=>s.close().then(()=>process.exit(0)));')
                f.gateway.session_command = lambda: ['--input-type=module', '-e', script]
                f.gateway.build_session_image()
                verify_session_lifecycle(f)
                assert all((f.gateway.state / name).read_bytes() == value for name, value in preserved.items())
            print(json.dumps({'origin': f.public_origin if ingress_mode else f.origin,
                              'hostname': INGRESS_HOST if ingress_mode else None,
                              'password': f.password, 'basic': f.auth(), 'duration': duration if session_mode else None,
                              'ca': str(f.frontend_ca if ingress_mode else f.gateway.state / 'ca.crt'),
                              'backend': 'http://' + f.gateway.backend,
                              'foreign': f'http://127.0.0.2:{f.foreign.server_port}'}), flush=True)
            for command in sys.stdin:  # Parent owns this pipe; EOF cleans up as well.
                if session_mode and command.strip() == 'summary':
                    sidecar = f.gateway.inspect_session()
                    mounts = {m['Destination'] for m in sidecar['Mounts']}
                    print(json.dumps({'accountPreservedUntilRotation': preserved is not None,
                                      'mountBoundary': mounts == {'/sockets', '/settings/session.json'},
                                      'backendAlive': f.backend._BaseServer__is_shut_down.is_set() is False}), flush=True)
                elif (ingress_mode or session_mode) and command.strip() == 'rotate':
                    f.gateway.rotate()
                    print(json.dumps({'password': f.password}), flush=True)
                else:
                    break
        return 0
    classes = (Unit,) if args.unit else (Integration, IsolatedLimits, StartupFailures, IdentityRefusal,
                                       IngressPolicy, IngressChain, IngressSharedLimits, SyntaxNamespace)
    suite = unittest.TestSuite(unittest.defaultTestLoader.loadTestsFromTestCase(cls) for cls in classes)
    return 0 if unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful() else 1


if __name__ == '__main__':
    sys.exit(main())
