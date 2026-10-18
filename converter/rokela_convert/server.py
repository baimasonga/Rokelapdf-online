"""Rokela PDF converter: a small private HTTP service that turns PDFs into Word/Excel/PowerPoint files and Office
documents into PDFs.

It is reachable only from the app (Railway private network) and every request must carry the shared
CONVERTER_TOKEN. Each conversion runs in its own process group with CPU, memory and file-size limits and a hard
timeout, inside a fresh temporary directory that is deleted afterwards. Nothing is stored and document contents
and file names are never logged.

  POST /v1/convert/<docx|xlsx|pptx|pdf>?from=<ext>   body: the file (Content-Length required)
  GET  /health
"""

from __future__ import annotations

import hmac
import importlib.util
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

from rokela_convert.engines import OFFICE_EXTS

MB = 1024 * 1024


def _int(name: str, default: int, lo: int, hi: int) -> int:
    raw = os.environ.get(name)
    if raw is None:
        return default
    n = int(raw)
    if not lo <= n <= hi:
        raise SystemExit(f"invalid {name}")
    return n


class Settings:
    def __init__(self, env=os.environ) -> None:
        token = env.get("CONVERTER_TOKEN", "")
        if len(token) < 32:
            raise SystemExit("CONVERTER_TOKEN must be set (>= 32 characters)")
        self.token = token.encode()
        self.max_bytes = _int("CONVERTER_MAX_BYTES", 50 * MB, 1, 500 * MB)
        self.concurrency = _int("CONVERTER_CONCURRENCY", 2, 1, 32)
        self.timeout = _int("CONVERTER_TIMEOUT", 120, 5, 900)
        self.memory = _int("CONVERTER_MEMORY_MB", 3072, 256, 65536) * MB
        self.queue_wait = _int("CONVERTER_QUEUE_WAIT", 30, 0, 600)


# What each conversion accepts, and how the first bytes of each source type must look.
SOURCES = {"docx": {"pdf"}, "xlsx": {"pdf"}, "pptx": {"pdf"}, "pdf": OFFICE_EXTS}
OUTPUT_TYPES = {
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "pdf": "application/pdf",
}
ZIP = b"PK\x03\x04"
OLE = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"


def looks_like(ext: str, head: bytes) -> bool:
    if ext == "pdf":
        return b"%PDF-" in head[:1024]
    if ext in ("docx", "xlsx", "pptx", "odt", "ods", "odp"):
        return head.startswith(ZIP)
    if ext in ("doc", "xls", "ppt"):
        return head.startswith(OLE)
    if ext == "rtf":
        return head.startswith(b"{\\rtf")
    return False


def run_job(settings: Settings, target: str, ext: str, data: bytes, request_id: str = "") -> tuple[int, bytes | str]:
    """Returns (0, output bytes), (2, user message), (1, '') on internal error, or (3, '') on timeout."""
    work = tempfile.mkdtemp(prefix="job-")
    try:
        os.chmod(work, 0o700)
        src = os.path.join(work, f"input.{ext}")
        dst = os.path.join(work, f"output.{target}")
        with open(src, "wb") as f:
            f.write(data)

        env = {
            "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
            "HOME": work,
            "TMPDIR": work,
            "LANG": "C.UTF-8",
            "CONVERTER_TIMEOUT": str(settings.timeout),
            "CONVERTER_MAX_PAGES": os.environ.get("CONVERTER_MAX_PAGES", "200"),
            "CONVERTER_MEMORY": str(settings.memory),
        }
        job = os.path.join(os.path.dirname(os.path.abspath(__file__)), "job.py")
        proc = subprocess.Popen(
            [sys.executable, "-E", "-s", job, target, ext, src, dst],
            cwd=work,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,  # its own process group, so a timeout kills LibreOffice too
        )
        try:
            out, _err = proc.communicate(timeout=settings.timeout + 15)
        except subprocess.TimeoutExpired:
            _kill(proc)
            print(json.dumps({"msg": "conversion job failed", "request_id": request_id, "reason": "timeout"}), flush=True)
            return 3, ""
        finally:
            _kill(proc)  # LibreOffice may leave helpers behind in the group
        if proc.returncode == 0 and os.path.exists(dst):
            with open(dst, "rb") as f:
                return 0, f.read()
        if proc.returncode == 2:
            try:
                return 2, str(json.loads(out.decode().strip().splitlines()[-1])["message"])[:300]
            except (ValueError, KeyError, IndexError):
                pass
        # job.py emits only an exception class as JSON. Never log raw stderr/stdout,
        # which LibreOffice or a document parser could populate with file contents.
        error = "unknown"
        for line in _err.decode(errors="replace").splitlines():
            try:
                value = json.loads(line)
                name = value.get("error") if isinstance(value, dict) else None
                if isinstance(name, str) and re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,79}", name):
                    error = name
            except ValueError:
                pass
        print(json.dumps({"msg": "conversion job failed", "request_id": request_id, "returncode": proc.returncode, "error": error}), flush=True)
        return 1, ""
    finally:
        shutil.rmtree(work, ignore_errors=True)


def _kill(proc: subprocess.Popen) -> None:
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        pass


def make_handler(settings: Settings, slots: threading.BoundedSemaphore):
    class Handler(BaseHTTPRequestHandler):
        server_version = "rokela-converter"
        sys_version = ""
        protocol_version = "HTTP/1.1"

        def log_message(self, *_args) -> None:  # request lines can carry query strings; we log our own line
            pass

        def _send(self, status: int, body: bytes, ctype: str = "application/json") -> None:
            self.send_response(status)
            self.send_header("content-type", ctype)
            self.send_header("content-length", str(len(body)))
            self.send_header("cache-control", "no-store")
            self.send_header("x-rokela-service", "converter")
            self.send_header("connection", "close")
            self.end_headers()
            self.wfile.write(body)
            self.close_connection = True

        def _error(self, status: int, code: str, message: str) -> None:
            self._send(status, json.dumps({"code": code, "message": message}).encode())

        def do_GET(self) -> None:
            if urlsplit(self.path).path == "/health":
                modules = ("docx", "openpyxl", "pptx", "pdfplumber", "pypdfium2", "PIL")
                ready = shutil.which("soffice") is not None and all(importlib.util.find_spec(m) is not None for m in modules)
                return self._send(200 if ready else 503, json.dumps({"ok": ready, "service": "rokela-converter"}).encode())
            self._error(404, "not_found", "not found")

        def do_POST(self) -> None:
            started = time.monotonic()
            status, target, ext, size_in, size_out = 500, "", "", 0, 0
            raw_id = self.headers.get("x-request-id", "")
            request_id = raw_id if re.fullmatch(r"[A-Za-z0-9-]{1,64}", raw_id) else ""
            try:
                url = urlsplit(self.path)
                parts = url.path.strip("/").split("/")
                auth = self.headers.get("authorization", "")
                if not hmac.compare_digest(auth.encode(), b"Bearer " + settings.token):
                    status = 401
                    return self._error(401, "unauthorized", "unauthorized")
                if len(parts) != 3 or parts[:2] != ["v1", "convert"] or parts[2] not in SOURCES:
                    status = 404
                    return self._error(404, "not_found", "not found")
                target = parts[2]
                ext = (parse_qs(url.query).get("from") or [""])[0].lower()
                if ext not in SOURCES[target]:
                    status = 400
                    return self._error(400, "unsupported", "This file type cannot be converted this way.")
                if self.headers.get("transfer-encoding"):
                    status = 411
                    return self._error(411, "length_required", "Content-Length is required.")
                try:
                    size_in = int(self.headers.get("content-length", ""))
                except ValueError:
                    status = 411
                    return self._error(411, "length_required", "Content-Length is required.")
                if size_in <= 0 or size_in > settings.max_bytes:
                    status = 413
                    return self._error(413, "too_large", f"Files up to {settings.max_bytes // MB} MB can be converted.")
                data = self.rfile.read(size_in)
                if len(data) != size_in:
                    status = 400
                    return self._error(400, "invalid_request", "The upload was incomplete.")
                if not looks_like(ext, data[:1024]):
                    status = 400
                    return self._error(400, "unsupported", "The file does not match its type.")
                if not slots.acquire(timeout=settings.queue_wait):
                    status = 429
                    return self._error(429, "busy", "The converter is busy. Try again in a minute.")
                try:
                    code, result = run_job(settings, target, ext, data, request_id)
                finally:
                    slots.release()
                del data
                if code == 0:
                    status, size_out = 200, len(result)
                    return self._send(200, result, OUTPUT_TYPES[target])  # type: ignore[arg-type]
                if code == 2:
                    status = 422
                    return self._error(422, "unconvertible", str(result))
                if code == 3:
                    status = 504
                    return self._error(504, "timeout", "This file took too long to convert.")
                status = 500
                return self._error(500, "internal", "The file could not be converted.")
            except (BrokenPipeError, ConnectionResetError):
                status = 499
            except Exception as e:
                status = 500
                print(json.dumps({"msg": "conversion request failed", "request_id": request_id, "error": type(e).__name__}), flush=True)
                return self._error(500, "internal", "The file could not be converted.")
            finally:
                line = {"msg": "convert", "request_id": request_id, "status": status, "target": target, "from": ext, "bytes_in": size_in, "bytes_out": size_out}
                line["ms"] = int((time.monotonic() - started) * 1000)
                print(json.dumps(line), flush=True)

    return Handler


class Server(ThreadingHTTPServer):
    daemon_threads = True


class Server6(Server):
    address_family = socket.AF_INET6

    def server_bind(self) -> None:
        # Listen on IPv6 and IPv4 (Railway's private network is IPv6).
        self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        super().server_bind()


def make_server(host: str, port: int, handler) -> Server:
    if ":" not in host:
        return Server((host, port), handler)
    try:
        return Server6((host, port), handler)
    except OSError:
        if host != "::":
            raise
        # No IPv6 on this host (some local Docker setups): listen on IPv4 only.
        return Server(("0.0.0.0", port), handler)


def main() -> None:
    settings = Settings()
    port = _int("PORT", 8080, 1, 65535)
    slots = threading.BoundedSemaphore(settings.concurrency)
    srv = make_server(os.environ.get("HOST", "::"), port, make_handler(settings, slots))
    print(json.dumps({"msg": "listening", "port": port, "concurrency": settings.concurrency}), flush=True)
    signal.signal(signal.SIGTERM, lambda *_: threading.Thread(target=srv.shutdown).start())
    srv.serve_forever()


if __name__ == "__main__":
    main()
