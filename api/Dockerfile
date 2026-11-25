# TownScan の API（Go）のイメージ。標準ライブラリと pgx・jwt・x/image・x/text だけなので、静的にビルドして distroless に置く（DocuNavi の ops/sse-relay/Dockerfile と同じ作り）。
# ビルドの文脈は api/。compose.yaml の api は、いまは Python の API（backend/）を指している。Go に替えるのは、plan.md の PG 段の 6（切り替え）。
# 版は go.mod（go 1.26.10）に合わせる。モジュールの取得は、ビルドのときだけ（go.sum で検証される）。
FROM golang:1.26.10 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /api ./cmd/api

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /api /api
EXPOSE 8000
# distroless には curl も Python も無い。バイナリが、自分の /api/health を叩く（200 でなければ unhealthy）
HEALTHCHECK --interval=10s --timeout=4s --start-period=15s --retries=6 \
    CMD ["/api", "-healthcheck"]
ENTRYPOINT ["/api"]
