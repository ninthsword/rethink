#!/usr/bin/env python3
"""Exercise both production gateway compositions against a strict local backend."""
import base64
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import http.client
import importlib.util
import json
import os
from pathlib import Path
import shutil
import socket
import ssl
import subprocess
import tempfile
import threading
import time

os.umask(0o077)
ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('gateway', ROOT / 'management-gateway/gateway.py')
gateway = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gateway)
AUTH = 'Basic ' + base64.b64encode(b'admin:synthetic-password').decode()
EXTERNAL_HOST = 'fixture.test'
EXTERNAL_ORIGIN = 'https://fixture.test'
FORBIDDEN = ('origin', 'authorization', 'proxy-authorization', 'forwarded', 'x-real-ip',
             'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port')


class Backend(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *_):
        pass

    def do_GET(self):
        assert self.headers['Host'] == self.server.authority
        assert all(name not in self.headers for name in FORBIDDEN), dict(self.headers)
        self.server.seen.append(dict(self.headers))
        if self.headers.get('Upgrade', '').lower() == 'websocket':
            # RFC 6455 mandates SHA-1 for this public handshake checksum.
            accept = base64.b64encode(hashlib.sha1((self.headers['Sec-WebSocket-Key'] +
                '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode(), usedforsecurity=False).digest()).decode()
            self.send_response(101)
            self.send_header('Upgrade', 'websocket')
            self.send_header('Connection', 'Upgrade')
            self.send_header('Sec-WebSocket-Accept', accept)
            self.end_headers()
            head = self.rfile.read(2)
            if not head:
                return
            assert head == b'\x81\x82', head
            mask, payload = self.rfile.read(4), self.rfile.read(2)
            plain = bytes(value ^ mask[index % 4] for index, value in enumerate(payload))
            assert plain == b'ok'
            self.wfile.write(b'\x81\x02ok')
            self.wfile.flush()
            self.close_connection = True
        else:
            self.send_response(200)
            self.send_header('Content-Length', '2')
            self.end_headers()
            self.wfile.write(b'ok')


def free_port():
    with socket.socket() as stream:
        stream.bind(('127.0.0.1', 0))
        return stream.getsockname()[1]


def wait_ready(process, condition):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        assert process.poll() is None, f'fixture process exited {process.returncode}'
        if condition():
            return
        time.sleep(0.02)
    raise AssertionError('fixture startup timed out')


def listening(port):
    try:
        with socket.create_connection(('127.0.0.1', port), timeout=0.1):
            return True
    except OSError:
        return False


def terminate(process):
    if process is None:
        return
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


def exercise(sessions):
    nginx = os.environ.get('NGINX_EXECUTABLE')
    assert nginx and Path(nginx).is_file(), 'NGINX_EXECUTABLE must identify the prepared private binary'
    backend = ThreadingHTTPServer(('127.0.0.1', 0), Backend)
    backend.authority = f'127.0.0.1:{backend.server_port}'
    backend.seen = []
    thread = threading.Thread(target=backend.serve_forever, daemon=True)
    thread.start()
    nginx_process = session_process = None
    with tempfile.TemporaryDirectory(prefix='rethink-nginx-local-') as directory:
        root = Path(directory)
        (root / 'gateway').mkdir()
        (root / 'sockets').mkdir(mode=0o700)
        (root / 'tmp').mkdir()
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
                        '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1',
                        '-keyout', str(root / 'gateway/tls.key'), '-out', str(root / 'gateway/tls.crt')],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
        password_hash = subprocess.run(['openssl', 'passwd', '-6', '-stdin'], input='synthetic-password\n',
                                       text=True, capture_output=True, check=True).stdout.strip()
        (root / 'gateway/auth').write_text('admin:' + password_hash + '\n')
        (root / 'gateway/verified').write_text('ok')
        port = free_port()
        bind = f'127.0.0.1:{port}'
        generator = gateway.session_config if sessions else gateway.config_text
        config = generator(bind, backend.authority, EXTERNAL_HOST)
        # Substitute only private paths, the ephemeral listener/backend and test credentials.
        config = config.replace('/tmp/', str(root / 'tmp') + '/')
        config = config.replace('/gateway/', str(root / 'gateway') + '/')
        config = config.replace('/sockets/', str(root / 'sockets') + '/')
        config_file = root / 'nginx.conf'
        config_file.write_text(config)
        context = ssl.create_default_context(cafile=str(root / 'gateway/tls.crt'))
        log = (root / 'fixture.log').open('w+')
        try:
            subprocess.run([nginx, '-t', '-p', str(root), '-c', str(config_file)], stdout=log, stderr=log, check=True)
            nginx_process = subprocess.Popen([nginx, '-p', str(root), '-c', str(config_file), '-g', 'daemon off;'], stdout=log, stderr=log)
            wait_ready(nginx_process, lambda: listening(port))
            if sessions:
                settings = root / 'service.json'
                settings.write_text(json.dumps({'socketPath': str(root / 'sockets/session.sock'),
                    'verifierPath': str(root / 'sockets/verifier.sock'),
                    'hosts': gateway.session_hosts({'bind': bind, 'external_hostname': EXTERNAL_HOST})['hosts'],
                    'backend': 'http://' + backend.authority}))
                source = (ROOT / 'management-gateway/session-proxy/service.mjs').as_uri()
                program = ('import {readFileSync} from "node:fs"; '
                    f'import {{createService}} from {json.dumps(source)}; '
                    'const service=createService(JSON.parse(readFileSync(process.argv[1],"utf8"))); '
                    'await service.listen(); '
                    'process.on("SIGTERM",()=>service.close().then(()=>process.exit(0)));')
                node = shutil.which('node')
                assert node, 'prepared Node is required'
                session_process = subprocess.Popen([node, '--input-type=module', '-e', program, str(settings)], stdout=log, stderr=log)
                wait_ready(session_process, lambda: (root / 'sockets/session.sock').exists())

            def request(path='/private', origin=EXTERNAL_ORIGIN, host=EXTERNAL_HOST, auth=AUTH, cookie=None, body=None):
                headers = {'Host': host, 'Forwarded': 'for=forged', 'X-Forwarded-For': 'forged',
                           'X-Forwarded-Host': 'forged', 'X-Forwarded-Proto': 'http', 'Proxy-Authorization': 'forged'}
                if origin is not None:
                    headers['Origin'] = origin
                if auth:
                    headers['Authorization'] = auth
                if cookie:
                    headers['Cookie'] = cookie
                if body is not None:
                    body = json.dumps(body)
                    headers['Content-Type'] = 'application/json'
                connection = http.client.HTTPSConnection('127.0.0.1', port, context=context, timeout=5)
                try:
                    connection.request('POST' if body is not None else 'GET', path, body=body, headers=headers)
                    response = connection.getresponse()
                    return response.status, dict(response.getheaders()), response.read()
                finally:
                    connection.close()

            def websocket(cookie=None, origin=EXTERNAL_ORIGIN, auth=AUTH, expected=101):
                with context.wrap_socket(socket.create_connection(('127.0.0.1', port), timeout=5), server_hostname='127.0.0.1') as stream:
                    headers = ['GET /socket HTTP/1.1', 'Host: ' + EXTERNAL_HOST,
                        'Upgrade: websocket', 'Connection: Upgrade', 'Sec-WebSocket-Version: 13',
                        'Sec-WebSocket-Key: ' + base64.b64encode(b'synthetic-key-12').decode('ascii'), 'Origin: ' + origin,
                        'X-Forwarded-For: forged']
                    if auth:
                        headers.append('Authorization: ' + auth)
                    if cookie:
                        headers.append('Cookie: ' + cookie)
                    stream.sendall(('\r\n'.join(headers) + '\r\n\r\n').encode())
                    response = b''
                    while b'\r\n\r\n' not in response:
                        chunk = stream.recv(4096)
                        assert chunk
                        response += chunk
                    status = int(response.split(b' ')[1])
                    assert status == expected, response
                    if expected == 101:
                        mask = b'abcd'
                        stream.sendall(b'\x81\x82' + mask + bytes(value ^ mask[index] for index, value in enumerate(b'ok')))
                        result = b''
                        while len(result) < 4:
                            result += stream.recv(4 - len(result))
                        assert result == b'\x81\x02ok', result

            assert request(origin='https://foreign.invalid')[0] == 403
            assert request(host='foreign.invalid')[0] == 421
            assert request(auth=None)[0] == 401
            websocket(auth=None, expected=401)
            assert not backend.seen
            if sessions:
                assert request('/__management/login', body={'username': 'admin', 'password': 'wrong'})[0] == 401
                status, headers, _ = request('/__management/login', body={'username': 'admin', 'password': 'synthetic-password'})
                assert status == 200
                cookie = headers['Set-Cookie'].split(';')[0]
                assert request(cookie=cookie)[0] == 200
                websocket(cookie=cookie)
                before = len(backend.seen)
                assert request(cookie=cookie, origin='https://foreign.invalid')[0] == 403
                websocket(cookie=cookie, origin='https://foreign.invalid', expected=403)
            else:
                assert request(auth='Basic invalid')[0] == 401
                assert request()[0] == 200
                assert request(origin=None)[0] == 200
                websocket()
                before = len(backend.seen)
                websocket(origin='https://foreign.invalid', expected=403)
            assert len(backend.seen) == before
            print('PASS production ' + ('session_config -> real Unix session service' if sessions else 'config_text Basic') + ' -> strict backend HTTP + WebSocket')
        except BaseException:
            log.flush(); log.seek(0)
            print(log.read())
            raise
        finally:
            terminate(session_process)
            terminate(nginx_process)
            log.close()
            backend.shutdown(); backend.server_close(); thread.join()


if __name__ == '__main__':
    exercise(False)
    exercise(True)
