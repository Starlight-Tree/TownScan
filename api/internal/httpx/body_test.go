package httpx

import (
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// リクエスト本文（JSON）の読み方（body.go）。FastAPI が、本文を 1 つのモデルとして受けるときの決まり。

func bodyReq(body, contentType string) *http.Request {
	r := httptest.NewRequest(http.MethodPost, "/x", strings.NewReader(body))
	if contentType != "" {
		r.Header.Set("Content-Type", contentType)
	}
	return r
}

func TestReadJSONBodyKinds(t *testing.T) {
	cases := []struct {
		name, body, ct string
		kind           BodyKind
	}{
		{"本文が空", ``, "application/json", BodyMissing},
		{"本文が空・型なし", ``, "", BodyMissing},
		{"JSON", `{"a":1}`, "application/json", BodyJSON},
		{"文字コードの指定つき", `{"a":1}`, "application/json; charset=utf-8", BodyJSON},
		{"大文字小文字は問わない", `{"a":1}`, "Application/JSON", BodyJSON},
		{"application/*+json", `{"a":1}`, "application/vnd.api+json", BodyJSON},
		{"+json の大文字", `{"a":1}`, "APPLICATION/LD+JSON", BodyJSON},
		{"パラメーターの書き方の誤りは、型だけを見る", `{"a":1}`, "application/json; charset", BodyJSON},
		{"型が無い", `{"a":1}`, "", BodyOpaque},
		{"text/plain", `{"a":1}`, "text/plain", BodyOpaque},
		{"フォーム", `a=1`, "application/x-www-form-urlencoded", BodyOpaque},
		{"application/jsonx は JSON でない", `{"a":1}`, "application/jsonx", BodyOpaque},
		{"text/json は JSON でない（application だけ）", `{"a":1}`, "text/json", BodyOpaque},
		{"読めない型", `{"a":1}`, ";;", BodyOpaque},
	}
	for _, c := range cases {
		b, e := ReadJSONBody(bodyReq(c.body, c.ct))
		if e != nil || b.Kind != c.kind {
			t.Errorf("%s: kind=%v err=%v, 期待 %v", c.name, b.Kind, e, c.kind)
		}
	}
	// 本文の無いリクエスト（r.Body が nil）
	r := httptest.NewRequest(http.MethodPost, "/x", nil)
	r.Body = nil
	if b, e := ReadJSONBody(r); e != nil || b.Kind != BodyMissing {
		t.Errorf("Body が nil: %v %v", b, e)
	}
}

func TestReadJSONBodyValues(t *testing.T) {
	b, e := ReadJSONBody(bodyReq("\xef\xbb\xbf"+`{"s":"あ","n":1.5,"l":[true,null],"o":{}}`, "application/json")) // UTF-8 の BOM は読み飛ばす
	if e != nil || b.Kind != BodyJSON {
		t.Fatalf("%v %v", b, e)
	}
	m := b.Value.(map[string]any)
	if m["s"] != "あ" || m["n"] != 1.5 || len(m["l"].([]any)) != 2 || m["o"] == nil {
		t.Errorf("値 = %v", m)
	}
	if b, _ := ReadJSONBody(bodyReq(`null`, "application/json")); b.Kind != BodyJSON || b.Value != nil {
		t.Errorf("null = %+v", b)
	}
	if b, _ := ReadJSONBody(bodyReq(`["x"]`, "application/json")); b.Kind != BodyJSON || len(b.Value.([]any)) != 1 {
		t.Errorf("配列 = %+v", b)
	}
}

func TestReadJSONBodyErrors(t *testing.T) {
	// UTF-8 でない: 400（JSON として壊れているのではなく、文字として読めない）
	_, e := ReadJSONBody(bodyReq("{\"a\":\"\xff\"}", "application/json"))
	if e == nil || e.Status != 400 || !strings.Contains(e.Message, "There was an error parsing the body") {
		t.Errorf("UTF-8 でない: %+v", e)
	}
	// JSON として壊れている: 422（loc は ["body", 位置]）。入力の値は載せない
	for _, c := range []struct {
		raw, pos string
	}{
		{`x`, "0"},
		{`{"a" 1}`, "5"},
		{`[1,]`, "2"}, // 末尾のコンマは、コンマの位置（Python 3.13。encoding/json の位置は 3）
		{`{"a":1}x`, "7"},
		{`{"a":`, "5"},
		{`["あ", x]`, "6"}, // 位置は、バイトではなく文字数
		{`{"secret":"pw-marker" x}`, "22"},
	} {
		_, e := ReadJSONBody(bodyReq(c.raw, "application/json"))
		if e == nil || e.Status != 422 || len(e.Details) != 1 || e.Details[0].Msg != "JSON decode error" ||
			len(e.Details[0].Loc) != 2 || e.Details[0].Loc[0] != "body" || e.Details[0].Loc[1] != c.pos {
			t.Errorf("%q: %+v", c.raw, e)
			continue
		}
		if strings.Contains(string(e.Marshal()), "pw-marker") {
			t.Errorf("入力の値が応答に出ている: %s", e.Marshal())
		}
	}
}

type brokenReader struct{ err error }

func (b brokenReader) Read([]byte) (int, error) { return 0, b.err }

func TestReadJSONBodyReadFailures(t *testing.T) {
	// 上限を超えた: 413
	w := httptest.NewRecorder()
	r := bodyReq(strings.Repeat("a", 100), "application/json")
	r.Body = http.MaxBytesReader(w, r.Body, 10)
	if _, e := ReadJSONBody(r); e == nil || e.Status != 413 || e.Code != "payload_too_large" {
		t.Errorf("上限超え: %+v", e)
	}
	// 途中で切れた・読めなかった: 400
	r = bodyReq("", "application/json")
	r.Body = io.NopCloser(brokenReader{errors.New("connection reset")})
	if _, e := ReadJSONBody(r); e == nil || e.Status != 400 || strings.Contains(e.Message, "connection reset") {
		t.Errorf("読めない: %+v", e)
	}
	r.Body = io.NopCloser(brokenReader{io.ErrUnexpectedEOF})
	if _, e := ReadJSONBody(r); e == nil || e.Status != 400 {
		t.Errorf("途中で切れた: %+v", e)
	}
}
