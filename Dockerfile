# Base images are pinned by digest (the tag is kept for readability); Dependabot updates both.
FROM node:26-alpine@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94 AS frontend
WORKDIR /frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

FROM ghcr.io/astral-sh/uv:0.13.6@sha256:af22a52f5eafef3d78e551599d405c02df61919d18028f0cea8eda93bc9986d0 AS uv

FROM python:3.15-slim@sha256:65a65fc7b30b06cb6df4930fd4650697cb23f4c2698ab81fc87e4b031bc36928 AS base
ENV TZ=Europe/Madrid \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_NO_CACHE=1 \
    UV_PYTHON_DOWNLOADS=never \
    PATH="/app/.venv/bin:$PATH"
# Tesseract reads the scanned pages and pictures of the shared documents for their search, with its
# English and Spanish models (about 100 MB).
RUN apt-get update \
    && apt-get install --yes --no-install-recommends tesseract-ocr tesseract-ocr-eng tesseract-ocr-spa \
    && rm -rf /var/lib/apt/lists/*
# The application runs from /app/.venv. The system pip is never used, and removing it also drops
# the outdated packages it vendors.
RUN python -m pip uninstall --yes --root-user-action=ignore pip \
    && groupadd --gid 1000 app && useradd --uid 1000 --gid app --create-home app
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN --mount=from=uv,source=/uv,target=/usr/local/bin/uv \
    uv sync --locked --no-dev --no-install-project
COPY README.md LICENSE ./
COPY src/ ./src/
# Building the project leaves build/ and an .egg-info in the source tree; the venv has the copy.
RUN --mount=from=uv,source=/uv,target=/usr/local/bin/uv \
    uv sync --locked --no-dev --no-editable \
    && rm -rf build src/*.egg-info
COPY alembic.ini seed.py docker-entrypoint.sh ./
COPY alembic/ ./alembic/
COPY --from=frontend /frontend/dist ./frontend/dist
RUN mkdir -p /app/data/uploads && chown -R app:app /app/data \
    && sed -i 's/\r$//' docker-entrypoint.sh && chmod +x docker-entrypoint.sh
ARG IMAGE_TAG=development
ARG BUILD_DATE=""
ENV IMAGE_TAG=$IMAGE_TAG BUILD_DATE=$BUILD_DATE
LABEL org.opencontainers.image.title="Juntia" \
      org.opencontainers.image.source="https://github.com/DrDonoso/juntia" \
      org.opencontainers.image.version="$IMAGE_TAG"
USER app
EXPOSE 7778
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:7778/health', timeout=4)"
ENTRYPOINT ["./docker-entrypoint.sh"]
