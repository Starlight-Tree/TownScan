# 契約の検査（pytest）を流すだけのイメージ。アプリのコード（api/）は入れない（契約は HTTP だけで叩く）。
# 検査のコード（contract/）はイメージに焼かず、実行時に読み取り専用でマウントする（scripts/test-contract.sh）。
# 固定版（pytest・PyJWT・cryptography・Pillow）。
FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /contract

# root 以外で実行する（uid はローダーのイメージと同じ）
RUN groupadd --system --gid 10001 app \
    && useradd --system --uid 10001 --gid app --no-create-home --shell /usr/sbin/nologin app

COPY requirements.txt /tmp/requirements.txt
RUN pip install -r /tmp/requirements.txt

USER app
CMD ["python", "-m", "pytest", "-q"]
