"""Run local dependencies before exposing Next; stop the container if a child dies.

No document contents or environment values are logged. Converter subprocesses
receive only their own settings, never database, storage, or email credentials.
"""

import json
import os
import secrets
import signal
import socket
import subprocess
import time
import urllib.request


def service_environments(source):
    common = {"PATH": "/opt/converter/venv/bin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8", "HOME": "/tmp"}
    converter = {
        **common,
        "PYTHONUNBUFFERED": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
        "HOST": "127.0.0.1",
        "PORT": "8080",
        "CONVERTER_TOKEN": secrets.token_urlsafe(48),
        "CONVERTER_CONCURRENCY": "1",
        "CONVERTER_MEMORY_MB": "3072",
    }
    app = {
        **source,
        "CLAMD_HOST": "127.0.0.1",
        "CLAMD_PORT": "3310",
        "CONVERTER_URL": "http://127.0.0.1:8080",
        "CONVERTER_TOKEN": converter["CONVERTER_TOKEN"],
    }
    return common, converter, app


def scanner_ready():
    with socket.create_connection(("127.0.0.1", 3310), timeout=2) as sock:
        sock.sendall(b"zPING\0")
        return sock.recv(32) == b"PONG\0"


def converter_ready():
    # Loopback must never go through an inherited outbound proxy.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open("http://127.0.0.1:8080/health", timeout=2) as response:
        return response.status == 200 and json.load(response).get("ok") is True


def main():
    children = []
    stopping = False
    phase = "bootstrap"

    def stop(*_args):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    def start(name, command, env, cwd="/app"):
        nonlocal phase
        phase = f"starting {name}"
        print(json.dumps({"msg": "container startup", "phase": phase}), flush=True)
        child = subprocess.Popen(command, env=env, cwd=cwd, start_new_session=True)
        children.append((name, child))

    def check_children():
        for name, child in children:
            if child.poll() is not None:
                raise RuntimeError(f"{name} exited with code {child.returncode}")

    try:
        common, converter, app = service_environments(os.environ)
        # Refresh before clamd starts so an older image can recover. If the mirror
        # is unavailable, clamd may use its bundled definitions only if still fresh.
        try:
            phase = "refreshing signatures"
            print(json.dumps({"msg": "container startup", "phase": phase}), flush=True)
            result = subprocess.run(["freshclam", "--stdout"], env=common, timeout=90, check=False)
            print(json.dumps({"msg": "signature refresh finished", "exit_code": result.returncode}), flush=True)
        except subprocess.TimeoutExpired:
            print('{"msg":"signature refresh timed out; checking bundled definitions"}', flush=True)
        start("signature updater", ["freshclam", "--daemon", "--foreground=true"], common)
        start("scanner", ["clamd", "--foreground=true"], common)
        start("converter", ["/opt/converter/venv/bin/python", "-m", "rokela_convert.server"], converter, "/opt/converter")
        phase = "waiting for scanner and converter"
        print(json.dumps({"msg": "container startup", "phase": phase}), flush=True)
        deadline = time.monotonic() + 300
        while not stopping:
            check_children()
            try:
                if scanner_ready() and converter_ready():
                    break
            except (OSError, ValueError):
                pass
            if time.monotonic() >= deadline:
                raise RuntimeError("local services did not become ready")
            time.sleep(1)
        if not stopping:
            start("app", ["node", "server.js"], app)
            phase = "running"
        while not stopping:
            check_children()
            time.sleep(1)
        return 0
    except Exception as error:
        # Only supervisor-generated messages are exposed; never log env/child output.
        print(json.dumps({"msg": "container stopping", "phase": phase, "reason": str(error) if isinstance(error, RuntimeError) else type(error).__name__}), flush=True)
        return 1
    finally:
        for _name, child in reversed(children):
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline and any(child.poll() is None for _, child in children):
            time.sleep(0.1)
        for _name, child in children:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.wait()


if __name__ == "__main__":
    raise SystemExit(main())
