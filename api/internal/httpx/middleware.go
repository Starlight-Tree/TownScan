package httpx

import (
	"fmt"
	"net/http"
	"runtime"
	"runtime/debug"
	"time"

	"townscan/api/internal/apierr"
)

// Middleware は、ハンドラーを包む。
type Middleware func(http.Handler) http.Handler

// Chain は、外側から順に包む（Chain(h, a, b) は a(b(h))）。
func Chain(h http.Handler, mws ...Middleware) http.Handler {
	for i := len(mws) - 1; i >= 0; i-- {
		h = mws[i](h)
	}
	return h
}

// Logf は、ログの出力先（log.Logger.Printf など）。
type Logf func(format string, args ...any)

// recorder は、応答の状態・書いたバイト数を覚える ResponseWriter。
// Flush と Unwrap を通すので、あとの段のストリーミング（SSE）や http.ResponseController を妨げない。
type recorder struct {
	http.ResponseWriter
	status int
	bytes  int
	wrote  bool
}

func (r *recorder) WriteHeader(code int) {
	if !r.wrote {
		r.status, r.wrote = code, true
	}
	r.ResponseWriter.WriteHeader(code)
}

func (r *recorder) Write(b []byte) (int, error) {
	if !r.wrote {
		r.status, r.wrote = http.StatusOK, true
	}
	n, err := r.ResponseWriter.Write(b)
	r.bytes += n
	return n, err
}

func (r *recorder) Flush() {
	if f, ok := r.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (r *recorder) Unwrap() http.ResponseWriter { return r.ResponseWriter }

// AccessLog は、リクエストを 1 行ずつ記録する（uvicorn のアクセスログと同じ位置づけ）。
// 記録するのは、メソッド・パス・状態・バイト数・所要時間だけ。クエリ文字列・ヘッダー（Authorization）・本文は出さない。
// パスは %q で書く（%0A などで改行を混ぜられても、ログが 1 行のまま読める）。
func AccessLog(logf Logf) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			rec := &recorder{ResponseWriter: w, status: http.StatusOK}
			next.ServeHTTP(rec, r)
			logf("%s %q -> %d (%dB, %s)", r.Method, r.URL.Path, rec.status, rec.bytes, time.Since(start).Round(10*time.Microsecond))
		})
	}
}

// Recover は、ハンドラーの panic を 500（{"error":{"code":"internal_error",…}}）にする（errors.py の _unexpected と同じ）。
// 応答にもログにも、panic の値は入れない（出すのは型と、Go の実行時エラーの文だけ。値に入力・秘密が混ざりうるため）。
// すでに応答を書き始めていたら、接続を切る（途中で終わった応答を、正常に見せない）。
func Recover(logf Logf) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			rec, isRec := w.(*recorder)
			if !isRec {
				rec = &recorder{ResponseWriter: w, status: http.StatusOK}
				w = rec
			}
			defer func() {
				v := recover()
				if v == nil {
					return
				}
				if v == http.ErrAbortHandler {
					panic(v)
				}
				logf("想定外のエラー: %s\n%s", describePanic(v), debug.Stack())
				if rec.wrote {
					panic(http.ErrAbortHandler)
				}
				apierr.Write(w, apierr.Internal())
			}()
			next.ServeHTTP(w, r)
		})
	}
}

func describePanic(v any) string {
	if e, ok := v.(runtime.Error); ok {
		return e.Error()
	}
	return fmt.Sprintf("%T", v)
}

// SecurityHeaders は、全応答に X-Content-Type-Options: nosniff を付ける（JSON を別の型として読ませない）。
// Python の API には、この種のヘッダーを付ける仕組みが無い（main.py にミドルウェアが無い）。足したのは Go 側だけの安全側の違い。
func SecurityHeaders() Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("X-Content-Type-Options", "nosniff")
			next.ServeHTTP(w, r)
		})
	}
}

// LimitBody は、リクエスト本文の大きさに上限を付ける。Content-Length が上限を超えていれば、読まずに 413。
// 申告が無い・小さいのに、読み進めて超えたときは、本文を読む側が *http.MaxBytesError を受け取る（apierr.PayloadTooLarge にする）。
func LimitBody(limit int64) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.ContentLength > limit {
				apierr.Write(w, apierr.PayloadTooLarge())
				return
			}
			if r.Body != nil {
				r.Body = http.MaxBytesReader(w, r.Body, limit)
			}
			next.ServeHTTP(w, r)
		})
	}
}
