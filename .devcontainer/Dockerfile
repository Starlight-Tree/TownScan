# 開発コンテナのイメージ。Python と Node は devcontainer.json の features が入れる。git・sudo は、ベースのイメージにある。
# ログイン情報はイメージに含めない（Claude Code は専用の名前付きボリューム townscan-claude-config）。
# GPU・torch はここに入れない（Mac の Docker では GPU が使えない。画像認識の学習は Kaggle / Colab、推論は P5 で決める）。
# 地理・画像の依存（GDAL・rasterio など）は、使うと決めた段（docs/plan.md の P1 の結果）で足す。
FROM mcr.microsoft.com/devcontainers/base:trixie

RUN export DEBIAN_FRONTEND=noninteractive \
    && apt-get update -y \
    && apt-get install -y --no-install-recommends curl ca-certificates postgresql-client \
    && rm -rf /var/lib/apt/lists/* \
    && psql --version
