# TownScan のローダー（pipeline の出力 → DB）。python:3.13-slim・非 root。ビルドの文脈は pipeline/。
#   runtime（既定）: compose の loader。python -m pipeline.load
#   test          : pytest と Pillow を入れたイメージ。コードとテストは入れず、scripts/test-loader.sh がリポジトリを読み取り専用で重ねる。
FROM python:3.13-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /code

# root 以外で実行する
RUN groupadd --system --gid 10001 app \
    && useradd --system --uid 10001 --gid app --no-create-home --shell /usr/sbin/nologin app

FROM base AS test
COPY requirements-loader-test.txt requirements-loader.txt ./
RUN pip install -r requirements-loader-test.txt
USER app
CMD ["python", "-m", "pytest", "-q"]

FROM base AS runtime
COPY requirements-loader.txt .
RUN pip install -r requirements-loader.txt
COPY --chown=app:app __init__.py load.py db.py ./pipeline/
COPY --chown=app:app sql ./pipeline/sql
USER app
CMD ["python", "-m", "pipeline.load", "--help"]
