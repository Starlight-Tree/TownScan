package httpx

import (
	"net/http"
	"strconv"

	"townscan/api/internal/apierr"
	"townscan/api/internal/pyjson"
)

// Python の API が返す Content-Type（charset は付かない）
const (
	ContentTypeJSON    = "application/json"
	ContentTypeGeoJSON = "application/geo+json"
)

// WriteJSON は、v を Python の API と同じ書式（pyjson）の JSON にして書く。Content-Length を付ける。
// 本文を作れなかったとき（NaN など）は、何も書かずに error を返す（呼び出し側が 500 にする）。
func WriteJSON(w http.ResponseWriter, status int, contentType string, v any) error {
	b, err := pyjson.Marshal(v)
	if err != nil {
		return err
	}
	h := w.Header()
	h.Set("Content-Type", contentType)
	h.Set("Content-Length", strconv.Itoa(len(b)))
	w.WriteHeader(status)
	_, _ = w.Write(b)
	return nil
}

// WriteError は、エラーを書く。
func WriteError(w http.ResponseWriter, e *apierr.Error) { apierr.Write(w, e) }
