# Base images are pinned by digest (the tag is kept for readability); Dependabot updates both.
FROM node:26-alpine@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94 AS frontend
WORKDIR /frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

FROM ghcr.io/astral-sh/uv:0.12.19@sha256:04d046b13e60d6bcec73cbc5e1cad25d680dea90c8573340950a0ac2d1aef424 AS uv

FROM python:3.14-slim@sha256:cd89c30eda26ee911a4611b18680086e0ea42e6f5f8cbe653d07fa7958c9cec8 AS base
ENV TZ=Europe/Madrid \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_NO_CACHE=1 \
    UV_PYTHON_DOWNLOADS=never \
    PATH="/app/.venv/bin:$PATH"
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
