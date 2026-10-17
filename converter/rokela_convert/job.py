"""Runs one conversion in its own process (started by server.py with resource limits and a timeout).

Usage: job.py <target> <source-ext> <input> <output>
Exit 0: done. Exit 2: a problem with the file; stdout holds a message that is safe to show. Exit 1: internal error.
"""

import json
import os
import resource
import sys

MB = 1024 * 1024


def _limit_self() -> None:
    """Lowers this process's own limits before any file is opened (inherited by LibreOffice; cannot be raised)."""
    timeout = int(float(os.environ.get("CONVERTER_TIMEOUT", "120")))
    memory = int(os.environ.get("CONVERTER_MEMORY", str(3072 * MB)))
    resource.setrlimit(resource.RLIMIT_CPU, (timeout + 5, timeout + 10))
    resource.setrlimit(resource.RLIMIT_AS, (memory, memory))
    resource.setrlimit(resource.RLIMIT_FSIZE, (512 * MB, 512 * MB))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))


_limit_self()

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from rokela_convert.engines import UserError, office_to_pdf, pdf_to_docx, pdf_to_pptx, pdf_to_xlsx  # noqa: E402


def main(argv: list[str]) -> int:
    target, ext, src, dst = argv
    timeout = float(os.environ.get("CONVERTER_TIMEOUT", "120"))
    try:
        if target == "docx":
            pdf_to_docx(src, dst)
        elif target == "xlsx":
            pdf_to_xlsx(src, dst)
        elif target == "pptx":
            pdf_to_pptx(src, dst)
        elif target == "pdf":
            office_to_pdf(src, dst, ext, timeout)
        else:
            raise UserError("Unknown conversion.")
    except UserError as e:
        print(json.dumps({"message": str(e)}))
        return 2
    except Exception as e:  # noqa: BLE001 — only the exception type is reported; content may hold document text
        print(json.dumps({"error": type(e).__name__}), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
