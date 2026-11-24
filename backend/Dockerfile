# TownScan の API。python:3.13-slim・非 root・uvicorn。
#   runtime（既定）: 本番相当のイメージ。compose の api がこれ。
#   test          : pytest を入れ、tests を載せたイメージ。scripts/test-backend.sh が使う。
FROM python:3.13-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /code

# root 以外で実行する
RUN groupadd --system --gid 10001 app \
    && useradd --system --uid 10001 --gid app --no-create-home --shell /usr/sbin/nologin app

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY --chown=app:app app ./app
COPY --chown=app:app db ./db

FROM base AS test
COPY requirements-dev.txt .
RUN pip install -r requirements-dev.txt
COPY pytest.ini .
COPY --chown=app:app tests ./tests
USER app
CMD ["python", "-m", "pytest", "-q"]

FROM base AS runtime
USER app
EXPOSE 8000
# /api/health は DB に届かないと 503 を返す（urlopen が例外になり、unhealthy になる）
HEALTHCHECK --interval=10s --timeout=4s --start-period=15s --retries=6 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=3)"]
CMD ["uvicorn", "--factory", "app.main:create_app", "--host", "0.0.0.0", "--port", "8000"]
