package httpx

import (
	"net/http"
	"sort"
	"strings"

	"townscan/api/internal/apierr"
)

// Params は、パスの {名前} に当たった値（デコード済み）。
type Params map[string]string

// HandlerFunc は、ルートのハンドラー。
type HandlerFunc func(w http.ResponseWriter, r *http.Request, p Params)

// Router は、FastAPI（Starlette）のルーティングと同じ振る舞いをする小さなルーター。
//
//   - パスは、デコードしたあとの文字列で合わせる（%2F は / になり、別の階層として扱われる）。{名前} は、/ を含まない 1 文字以上
//   - パスは合うがメソッドが違えば、405（HEAD も同じ。FastAPI の GET は HEAD を受けない）。Allow に、そのパスで使えるメソッドを書く
//     （RFC 9110 §15.5.6 は、405 に Allow を付けることを求める。Python の API は、独自のエラー応答が Allow を落とすので付かない。これは写さない）
//   - どのルートにも合わず、末尾の / を足す・外す（複数あれば全部外す）とルートに合うときは、307 でそちらへ移す（Starlette の redirect_slashes）
//   - それ以外は 404
//
// http.ServeMux は、メソッド付きのパターンが HEAD を通す・パスを掃除して 301 にする・%2F を区別する、の 3 点が違うので使わない。
type Router struct {
	routes []route
}

type route struct {
	method string
	segs   []segment
	h      HandlerFunc
}

type segment struct {
	literal string
	param   string // 空でなければ {param}
}

// Handle は、ルートを足す。pattern は "/api/candidates/{candidate_id}" の形。
func (rt *Router) Handle(method, pattern string, h HandlerFunc) {
	var segs []segment
	for _, s := range strings.Split(pattern, "/") {
		if strings.HasPrefix(s, "{") && strings.HasSuffix(s, "}") {
			segs = append(segs, segment{param: s[1 : len(s)-1]})
		} else {
			segs = append(segs, segment{literal: s})
		}
	}
	rt.routes = append(rt.routes, route{method: method, segs: segs, h: h})
}

func (rte route) match(path string) (Params, bool) {
	parts := strings.Split(path, "/")
	if len(parts) != len(rte.segs) {
		return nil, false
	}
	var params Params
	for i, seg := range rte.segs {
		if seg.param == "" {
			if parts[i] != seg.literal {
				return nil, false
			}
			continue
		}
		if parts[i] == "" {
			return nil, false
		}
		if params == nil {
			params = Params{}
		}
		params[seg.param] = parts[i]
	}
	return params, true
}

// matchesAnyMethod は、メソッドを問わず、パスに合うルートがあるか。
func (rt *Router) matchesAnyMethod(path string) bool {
	for _, rte := range rt.routes {
		if _, ok := rte.match(path); ok {
			return true
		}
	}
	return false
}

// ServeHTTP は http.Handler。
func (rt *Router) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	var allowed []string
	for _, rte := range rt.routes {
		params, ok := rte.match(path)
		if !ok {
			continue
		}
		if rte.method == r.Method {
			rte.h(w, r, params)
			return
		}
		allowed = append(allowed, rte.method)
	}
	if len(allowed) > 0 {
		e := apierr.MethodNotAllowed()
		e.Headers = map[string]string{"Allow": joinUnique(allowed)}
		apierr.Write(w, e)
		return
	}
	if path != "/" {
		alt := path + "/"
		if strings.HasSuffix(path, "/") {
			alt = strings.TrimRight(path, "/")
		}
		if rt.matchesAnyMethod(alt) {
			redirect(w, r, alt)
			return
		}
	}
	apierr.Write(w, apierr.NotFound())
}

// joinUnique は、メソッドを重複なく、並べ替えて ", " でつなぐ（Allow の値）。
func joinUnique(methods []string) string {
	seen := map[string]bool{}
	var out []string
	for _, m := range methods {
		if !seen[m] {
			seen[m] = true
			out = append(out, m)
		}
	}
	sort.Strings(out)
	return strings.Join(out, ", ")
}

// redirect は、307 で path へ移す。Location の作り方は Starlette の RedirectResponse と同じ:
// 「スキーム://Host ヘッダーの値 + デコード済みのパス + ?生のクエリ」を、安全な文字（:/%#?=@[]!$&'()*+,;）以外パーセントエンコードする。
func redirect(w http.ResponseWriter, r *http.Request, path string) {
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	host := r.Host
	if host == "" {
		if a, ok := r.Context().Value(http.LocalAddrContextKey).(interface{ String() string }); ok {
			host = a.String()
		}
	}
	target := scheme + "://" + host + strings.ToValidUTF8(path, "�")
	if r.URL.RawQuery != "" {
		target += "?" + r.URL.RawQuery
	}
	h := w.Header()
	h.Set("Location", pyQuote(target))
	h.Set("Content-Length", "0")
	w.WriteHeader(http.StatusTemporaryRedirect)
}

// pyQuote は、Python の urllib.parse.quote(s, safe=":/%#?=@[]!$&'()*+,;") と同じ。
func pyQuote(s string) string {
	const safe = ":/%#?=@[]!$&'()*+,;"
	const hex = "0123456789ABCDEF"
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '_' || c == '.' || c == '-' || c == '~' || strings.IndexByte(safe, c) >= 0 {
			b.WriteByte(c)
			continue
		}
		b.WriteByte('%')
		b.WriteByte(hex[c>>4])
		b.WriteByte(hex[c&15])
	}
	return b.String()
}
