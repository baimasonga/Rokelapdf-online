# Rokela PDF converter: LibreOffice (headless, no GUI packages) + the Python conversion service.
# Deploy as its own Railway service with no public domain; the app reaches it over the private network.
ARG BASE_IMAGE=python:3.13-slim
FROM ${BASE_IMAGE} AS runtime-base

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1

# Office suite without the desktop UI, and metric-compatible fonts so documents keep their layout
# (Carlito = Calibri, Caladea = Cambria, Liberation = Arial/Times/Courier).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libreoffice-writer-nogui libreoffice-calc-nogui libreoffice-impress-nogui \
      fonts-liberation2 fonts-crosextra-carlito fonts-crosextra-caladea fonts-dejavu-core fonts-noto-core \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY rokela_convert ./rokela_convert

# Never run as root. Work files live in a private temp directory per job and are deleted afterwards.
RUN useradd --system --uid 10001 --home-dir /nonexistent --shell /usr/sbin/nologin converter \
 && chmod -R a+rX /app/rokela_convert
USER converter
ENV HOST=:: PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD python -c "import urllib.request,os;urllib.request.urlopen(f'http://127.0.0.1:{os.environ[\"PORT\"]}/health',timeout=3)"
CMD ["python", "-m", "rokela_convert.server"]

# Tests use the production user, dependencies and resource-limited worker.
FROM runtime-base AS test
COPY --chmod=755 tests ./tests
CMD ["python", "-m", "unittest", "-v"]

# Keep tests out of the image deployed by Railway's default build target.
FROM runtime-base AS runtime
