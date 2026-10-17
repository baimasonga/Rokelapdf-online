# Rokela PDF converter

A small private service that does the Office conversions the browser cannot: PDF → Word, Excel and PowerPoint, and
Word, Excel and PowerPoint → PDF. The app (`src/lib/server/convert.ts`) is its only client.

```
POST /v1/convert/docx?from=pdf     PDF → Word (editable paragraphs, fonts, tables, pictures)
POST /v1/convert/xlsx?from=pdf     PDF → Excel (one sheet per page; tables as rows/columns)
POST /v1/convert/pptx?from=pdf     PDF → PowerPoint (one slide per page; text in the notes)
POST /v1/convert/pdf?from=<ext>    docx doc odt rtf · xlsx xls ods · pptx ppt odp → PDF (LibreOffice)
GET  /health
```

Every `POST` needs `Authorization: Bearer $CONVERTER_TOKEN` and a `Content-Length`; the body is the file.
Errors are JSON `{code, message}`: 401 token, 400 wrong type, 411/413 size, 422 the file cannot be converted (the
message is safe to show), 429 busy, 504 timeout, 500 anything else.

## How it stays safe

- Private: deploy with **no public domain**; the app calls it over Railway's private network with a shared token
  of at least 32 characters (compared in constant time).
- One process group per file, started fresh, with CPU, memory (`CONVERTER_MEMORY_MB`) and file-size limits and a
  hard timeout (`CONVERTER_TIMEOUT`); the whole group (LibreOffice included) is killed afterwards.
- A new private temporary directory per file, deleted when the request ends. Nothing is stored.
- At most `CONVERTER_CONCURRENCY` conversions at once; further requests wait up to 30 s, then get "busy".
- LibreOffice runs with a hardened profile: macros disabled, linked content never updated, untrusted remote links
  blocked. A test proves a document with a linked remote image does not make LibreOffice fetch it.
- Text from a PDF is never written to Excel as a formula (no formula injection).
- Logs hold only status, conversion, sizes and time — never file names or contents.
- Runs as a non-root user; the container works with a read-only root filesystem and all capabilities dropped.

All libraries are permissively licensed (pdfplumber/pdfminer.six MIT, pypdfium2/PDFium Apache-2.0/BSD,
python-docx/openpyxl/python-pptx MIT, Pillow HPND); LibreOffice (MPL-2.0) runs as a separate program. AGPL
libraries such as PyMuPDF/pdf2docx are deliberately not used.

## Run and test locally

```bash
docker build -t rokela-converter converter
docker run --rm -p 127.0.0.1:8090:8080 -e CONVERTER_TOKEN=$(openssl rand -base64 48) \
  --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges rokela-converter

# tests (needs LibreOffice and the requirements)
cd converter && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt && .venv/bin/python -m unittest -v
```

Point the app at it with `CONVERTER_URL=http://127.0.0.1:8090` and the same `CONVERTER_TOKEN`.

| Variable                | Default    | Meaning                            |
| ----------------------- | ---------- | ---------------------------------- |
| `CONVERTER_TOKEN`       | (required) | shared secret, ≥ 32 characters     |
| `PORT` / `HOST`         | 8080 / ::  | listen address (IPv4 fallback)     |
| `CONVERTER_CONCURRENCY` | 2          | conversions at the same time       |
| `CONVERTER_TIMEOUT`     | 120        | seconds per conversion             |
| `CONVERTER_MAX_BYTES`   | 52428800   | largest accepted file              |
| `CONVERTER_MAX_PAGES`   | 200        | largest PDF for PDF → Office       |
| `CONVERTER_MEMORY_MB`   | 3072       | address-space limit per conversion |
| `CONVERTER_QUEUE_WAIT`  | 30         | seconds to wait for a free slot    |
