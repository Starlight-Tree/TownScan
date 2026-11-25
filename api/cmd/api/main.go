// TownScan の API（Go）。設定 → DB の接続とスキーマの適用 → 待ち受け → 停止の合図（SIGINT・SIGTERM）で、処理中の応答を終えてから止まる。
//
// 決定: docs/decisions/0005-api-in-go.md（API は Go、解析は Python）。振る舞いの正本は backend/app/ と docs/spec-prototype.md §4.4。
// いまあるのは読み取りのエンドポイント（/api/health・/api/areas・/api/candidates・/api/candidates.geojson・/api/candidates/{id}・/api/metrics）と、
// 検出画像（/api/candidates/{id}/image。internal/imaging）、認証（/api/me。internal/auth）、チャット（POST /api/chat。模擬モデルと、
// LLM_PROVIDER=gemini のときの実 LLM。internal/chat）。
//
// 使い方:
//
//	api [-listen :8000]      サーバーを起動する（環境変数は internal/config）
//	api -healthcheck         自分の /api/health を 1 回叩く（200 なら終了コード 0）。distroless のイメージには curl も Python も無いので、HEALTHCHECK はこれを使う
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"townscan/api/internal/auth"
	"townscan/api/internal/chat"
	"townscan/api/internal/config"
	"townscan/api/internal/handlers"
	"townscan/api/internal/httpx"
	"townscan/api/internal/store"
)

const (
	defaultListen = ":8000"
	// リクエスト本文の上限（4 MiB = 4,194,304 バイト）。いまの読み取りの API は本文を読まない。本文を読むのはチャットだけで、
	// いちばん大きい正しい本文は、500 件 × 2000 文字 × 3 バイト（日本語は UTF-8 で 1 文字 3 バイト）= 3,000,000 バイトに、JSON の枠（1 件 約 40 バイト）を足した約 3.02 MB。
	// これが収まる最小の 2 の冪が 4 MiB（本文はそのまま UTF-8 で送る前提。frontend の JSON.stringify がそう。\uXXXX に逃がして送る客は、1 文字 6 バイトで収まらないことがある）。
	// 上限を大きくしないのは、JSON を復号するとメモリーが本文の約 50 倍になるため（[{},{},…] のような本文は、要素 1 つ 3 バイトで map 1 つ・約 150 バイトになる）。
	// 8 MiB だと 1 本の要求で約 400 MB、4 MiB なら約 200 MB。それでも要求を重ねられれば足りなくなるので、コンテナのメモリー上限は 1 GiB 以上にする（README の「チャット」）。
	maxBodyBytes = 4 << 20
	// 1 回の要求の全体の期限と、DB の statement_timeout。どちらも、チャットの Gemini の期限（chat.RequestDeadline = 27 秒）に合わせる。
	// frontend の Next.js が /api/* を転送するときの待ちの既定は 30 秒なので、それより前に、API が（502・503 などで）応答できる。
	// 要求の期限は、DB の問い合わせと Gemini への通信を、期限で打ち切る。DB の文は、期限を超えて走り続けない
	requestDeadline = chat.RequestDeadline
	// 停止の合図から、処理中の応答を待つ時間
	shutdownGrace = 10 * time.Second
	// スキーマの適用のやり直し（backend/app/db.py の wait_and_apply_schema と同じ）
	schemaAttempts = 20
	schemaDelay    = 1500 * time.Millisecond
	healthTimeout  = 3 * time.Second
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	os.Exit(run(ctx, os.Args[1:], os.Getenv, os.Stderr, nil))
}

// run は main の本体。終了コードを返す（0 = 正常に停止、1 = 起動・実行の失敗、2 = 設定・引数の誤り）。
// onListen は、待ち受けを始めた直後に呼ぶ（テストが、実際のポートを知るため。nil でよい）。
func run(ctx context.Context, args []string, getenv func(string) string, stderr io.Writer, onListen func(net.Addr)) int {
	logger := log.New(stderr, "api: ", log.LstdFlags)

	fs := flag.NewFlagSet("api", flag.ContinueOnError)
	fs.SetOutput(stderr)
	listen := fs.String("listen", defaultListen, "待ち受けるアドレス")
	healthcheck := fs.Bool("healthcheck", false, "自分の /api/health を叩いて、200 なら終了コード 0 で終わる")
	if err := fs.Parse(args); err != nil {
		return 2
	}

	if *healthcheck {
		if err := checkHealth(ctx, *listen); err != nil {
			logger.Printf("ヘルスチェックに失敗: %v", err)
			return 1
		}
		return 0
	}

	cfg, err := config.Load(getenv, logger.Printf)
	if err == nil {
		err = cfg.Validate()
	}
	if err != nil {
		var ce *config.Error
		if errors.As(err, &ce) {
			logger.Printf("設定の誤り: %v", ce)
			return 2
		}
		logger.Printf("設定を読めません: %v", err)
		return 2
	}

	st, err := store.Open(ctx, cfg.DatabaseURL.Reveal(), store.WithStatementTimeout(requestDeadline))
	if err != nil {
		logger.Printf("起動できません: %v", err)
		return 2
	}
	defer st.Close()
	// チャット。LLM_PROVIDER=gemini のときだけ、Gemini のキー・モデルを渡す。キーが無ければ、黙って模擬に落とさず、DB を待つ前に止まる
	chatCfg := chat.Config{Provider: cfg.LLMProvider}
	if cfg.LLMProvider == "gemini" {
		chatCfg.Gemini = chat.GeminiConfig{APIKey: cfg.GeminiAPIKey, Model: cfg.GeminiModel, Deadline: requestDeadline}
	}
	chatSvc, err := chat.New(st, chatCfg, logger.Printf)
	if err != nil {
		logger.Printf("設定の誤り: %v", err)
		return 2
	}
	// DB がまだ起きていなくても、数回やり直す。適用が済むまでは待ち受けない（compose の healthcheck が healthy にしない）
	if err := st.WaitAndApplySchema(ctx, schemaAttempts, schemaDelay, logger.Printf); err != nil {
		if ctx.Err() == nil { // 停止の合図で中断したときは、失敗ではない
			logger.Printf("起動できません: %v", err)
			return 1
		}
		return 0
	}

	srv := newServer(*listen, buildHandler(cfg, st, chatSvc, logger.Printf), logger)
	ln, err := net.Listen("tcp", *listen)
	if err != nil {
		logger.Printf("待ち受けられません: %v", err)
		return 1
	}
	logger.Printf("待ち受けを始めました: %s（LLM=%s）", ln.Addr(), cfg.LLMProvider)
	if onListen != nil {
		onListen(ln.Addr())
	}
	if err := serve(ctx, srv, ln, shutdownGrace); err != nil {
		logger.Printf("停止に失敗: %v", err)
		return 1
	}
	logger.Printf("停止しました")
	return 0
}

// buildHandler は、ルーターをミドルウェアで包む。外側から: アクセスログ → panic の回復 → セキュリティヘッダー → 本文の上限 → 要求全体の期限 → ルーター。
// アクセスログが外側なのは、panic を 500 にしたあとの状態を記録するため。
func buildHandler(cfg config.Config, st handlers.Reader, chatSvc handlers.Chatter, logf func(string, ...any)) http.Handler {
	router := handlers.New(handlers.Deps{
		Store:       st,
		Auth:        newAuthenticator(cfg, logf),
		LLMProvider: cfg.LLMProvider,
		GeminiModel: cfg.GeminiModel,
		TilesDir:    cfg.TilesDir,
		Chat:        chatSvc,
		Logf:        logf,
	})
	return httpx.Chain(router,
		httpx.AccessLog(logf),
		httpx.Recover(logf),
		httpx.SecurityHeaders(),
		httpx.LimitBody(maxBodyBytes),
		httpx.Timeout(requestDeadline),
	)
}

// newAuthenticator は、/api/me のログインの確認。ログインが未設定（cfg.Auth が nil）なら nil で、/api/me が 503 になるだけ（ほかの入口は影響を受けない）。
// JWKS は、ここでは取りに行かない（最初の /api/me の要求まで取らない。web が先に起きていなくても、api は起動できる）。
func newAuthenticator(cfg config.Config, logf func(string, ...any)) handlers.Authenticator {
	if cfg.Auth == nil {
		return nil
	}
	v, err := auth.NewVerifier(*cfg.Auth, logf)
	if err != nil { // config が空にしないので、起きない。起きても、起動は止めない（ログインは任意の機能）
		logf("ログインの検証を無効にしました: %v", err)
		return nil
	}
	return v
}

// newServer は、タイムアウトを付けた http.Server。WriteTimeout は付けない（あとの段のチャット・ストリーミングを、途中で切らないため。
// 書き込みの期限は、その段で、応答ごとに付ける）。
func newServer(addr string, h http.Handler, logger *log.Logger) *http.Server {
	return &http.Server{
		Addr:              addr,
		Handler:           h,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		IdleTimeout:       60 * time.Second,
		ErrorLog:          logger,
	}
}

// serve は、ln で待ち受け、ctx が取り消されたら、処理中の応答を grace の間だけ待って止まる。
func serve(ctx context.Context, srv *http.Server, ln net.Listener, grace time.Duration) error {
	errc := make(chan error, 1)
	go func() { errc <- srv.Serve(ln) }()
	select {
	case err := <-errc:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
	}
	sctx, cancel := context.WithTimeout(context.Background(), grace)
	defer cancel()
	if err := srv.Shutdown(sctx); err != nil {
		_ = srv.Close()
		return fmt.Errorf("処理中の応答を待ちきれませんでした: %w", err)
	}
	return nil
}

// checkHealth は、listen のアドレスの /api/health を叩く（ホストが空・0.0.0.0 なら 127.0.0.1）。200 以外はエラー。
func checkHealth(ctx context.Context, listen string) error {
	host, port, err := net.SplitHostPort(listen)
	if err != nil {
		return fmt.Errorf("-listen を読めません: %w", err)
	}
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "127.0.0.1"
	}
	ctx, cancel := context.WithTimeout(ctx, healthTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+net.JoinHostPort(host, port)+"/api/health", nil)
	if err != nil {
		return err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16))
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("状態 %d", resp.StatusCode)
	}
	return nil
}
