# TownScan の API（Go）のイメージ。標準ライブラリと pgx・jwt・x/image・x/text だけなので、静的にビルドして distroless に置く（DocuNavi の ops/sse-relay/Dockerfile と同じ作り）。
# ビルドの文脈は api/。compose.yaml の api が、このイメージ。
# 版は go.mod（go 1.26.10）に合わせる。モジュールの取得は、ビルドのときだけ（go.sum で検証される）。
FROM golang:1.26.10 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /api ./cmd/api \
 && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /history-cleanup ./cmd/history-cleanup

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /api /api
# 運用者の保守コマンド（保存期間を過ぎた会話の履歴を消す。既定は件数の表示だけ）: docker compose run --rm --entrypoint /history-cleanup api --older-than-days 7
COPY --from=build /history-cleanup /history-cleanup
EXPOSE 8000
# distroless には curl も Python も無い。バイナリが、自分の /api/health を叩く（200 でなければ unhealthy）
HEALTHCHECK --interval=10s --timeout=4s --start-period=15s --retries=6 \
    CMD ["/api", "-healthcheck"]
ENTRYPOINT ["/api"]
