"""Exercise the deployed engines with synthetic documents, without app secrets.

Run inside the built image as its normal non-root user. Starts only local engines;
does not call the database, object storage or signature mirrors.
"""

import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import socket
import struct
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import zipfile

spec = importlib.util.spec_from_file_location("supervise", "/opt/rokela/supervise.py")
supervise = importlib.util.module_from_spec(spec)
spec.loader.exec_module(supervise)


def scan(data):
    with socket.create_connection(("127.0.0.1", 3310), timeout=30) as sock:
        sock.sendall(b"zINSTREAM\0" + struct.pack("!I", len(data)) + data + b"\0\0\0\0")
        answer = b""
        while b"\0" not in answer:
            part = sock.recv(4096)
            if not part:
                raise RuntimeError("scanner closed early")
            answer += part
        return answer.rstrip(b"\0")


def main():
    assert os.getuid() != 0, "test must use the production non-root user"
    common, converter, _app = supervise.service_environments({})
    # Exercise updater initialization without contacting an external mirror.
    # /run is mounted empty in CI, matching Cloudflare's ephemeral runtime.
    updater_config = Path(tempfile.mkdtemp(prefix="rokela-updater-")) / "freshclam.conf"
    updater_config.write_text(
        Path("/etc/clamav/freshclam.conf").read_text().replace(
            "DatabaseMirror database.clamav.net", "PrivateMirror http://127.0.0.1:9"
        )
    )
    commands = [
        (["freshclam", "--daemon", "--foreground=true", "--stdout",
          f"--config-file={updater_config}"], common, "/app"),
        (["clamd", "--foreground=true"], common, "/app"),
        (["/opt/converter/venv/bin/python", "-m", "rokela_convert.server"], converter, "/opt/converter"),
    ]
    children = []
    try:
        for command, env, cwd in commands:
            children.append(subprocess.Popen(command, env=env, cwd=cwd, start_new_session=True))
        deadline = time.monotonic() + 300
        while True:
            assert all(p.poll() is None for p in children), "engine exited during startup"
            try:
                if supervise.scanner_ready() and supervise.converter_ready():
                    break
            except (OSError, ValueError):
                pass
            assert time.monotonic() < deadline, "engines did not become ready"
            time.sleep(1)
        print("PASS: signature updater initialized with an empty /run", flush=True)
        assert scan(b"synthetic clean document") == b"stream: OK"
        # Standard harmless antivirus test string, never uploaded outside the container.
        eicar = b"X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"
        assert scan(eicar).endswith(b" FOUND"), "antivirus did not reject the test signature"
        print("PASS: clean scan and antivirus rejection", flush=True)
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

        def convert(data, target, source, token=converter["CONVERTER_TOKEN"]):
            request = urllib.request.Request(
                f"http://127.0.0.1:8080/v1/convert/{target}?from={source}",
                data=data,
                headers={"Authorization": f"Bearer {token}"},
            )
            with opener.open(request, timeout=150) as response:
                assert response.status == 200
                return response.read()

        rtf = b"{\\rtf1\\ansi Cloudflare converter smoke test.}"
        try:
            convert(rtf, "pdf", "rtf", token="incorrect-token")
            raise AssertionError("converter accepted an invalid token")
        except urllib.error.HTTPError as error:
            assert error.code == 401
        pdf = convert(rtf, "pdf", "rtf")
        assert pdf.startswith(b"%PDF-")
        docx = convert(pdf, "docx", "pdf")
        with zipfile.ZipFile(io.BytesIO(docx)) as document:
            assert b"Cloudflare converter smoke test" in document.read("word/document.xml")
        print("PASS: converter authorization, RTF to PDF, PDF to DOCX with preserved text", flush=True)
        for config in ("clamd.conf", "freshclam.conf"):
            assert Path(f"/etc/clamav/{config}").is_file()
        print(json.dumps({"ok": True, "uid": os.getuid()}), flush=True)
    finally:
        for child in children:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.wait()
        updater_config.unlink(missing_ok=True)
        updater_config.parent.rmdir()


if __name__ == "__main__":
    main()
