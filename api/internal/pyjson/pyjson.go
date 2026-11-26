// Package pyjson は、Python の API（FastAPI）と同じ書式で JSON を書く。
//
// Python の API は json.dumps(ensure_ascii=False, allow_nan=False, separators=(",", ":")) で本文を作る。
// Go の encoding/json との違いは次の 3 つで、ここで合わせる（JSON として同値でも、バイト列が違うと差分検査が読みにくくなるため）。
//   - 浮動小数点: Python は 100.0 を "100.0"、1e-5 を "1e-05" と書く（Go は "100"・"0.00001"）。Float がそれを書く
//   - HTML 用の置き換え（< > & を 16 進の逃がしに変える）をしない
//   - 末尾に改行を付けない
//
// DB の jsonb の列は、Python の API が「読んで書き直す」のと同じバイト列にして通す（Normalize）。
//
// 合わせていない点が 1 つある: Go の encoding/json は、文字列の中の U+2028・U+2029 を、常に 6 文字の逃がしで書く
// （Python はそのまま書く）。値としては同じで、データに現れる文字ではない。
package pyjson

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"strconv"
	"strings"
)

// Float は、Python の float の repr と同じ書き方で JSON に書く float64。
// NaN と ±Inf は書けない（Python の allow_nan=False と同じく、書き出しの失敗になる）。
type Float float64

// MarshalJSON は json.Marshaler。
func (f Float) MarshalJSON() ([]byte, error) {
	s, err := FormatFloat(float64(f))
	if err != nil {
		return nil, err
	}
	return []byte(s), nil
}

// FormatFloat は、Python の repr(float) と同じ文字列を返す（最短の桁。指数が -4 未満か 16 以上なら指数表記。整数の値には ".0" を付ける）。
func FormatFloat(f float64) (string, error) {
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return "", errors.New("pyjson: NaN と無限大は JSON に書けません")
	}
	if f == 0 {
		if math.Signbit(f) {
			return "-0.0", nil
		}
		return "0.0", nil
	}
	// 'e' 形式の最短表現（例: "1.2345e+02"）から、桁（digits）と 10 進の指数を取り出す
	e := strconv.FormatFloat(f, 'e', -1, 64)
	sign := ""
	if e[0] == '-' {
		sign, e = "-", e[1:]
	}
	mant, expStr, _ := strings.Cut(e, "e")
	exp, err := strconv.Atoi(expStr)
	if err != nil {
		return "", fmt.Errorf("pyjson: 指数を読めません: %w", err)
	}
	digits := strings.Replace(mant, ".", "", 1)
	// 値 = 0.d1d2d3… × 10^decpt（Python の format_float_short の decpt と同じ）
	decpt := exp + 1

	var b strings.Builder
	b.WriteString(sign)
	if decpt <= -4 || decpt > 16 {
		b.WriteString(digits[:1])
		if len(digits) > 1 {
			b.WriteByte('.')
			b.WriteString(digits[1:])
		}
		b.WriteByte('e')
		x := decpt - 1
		if x < 0 {
			b.WriteByte('-')
			x = -x
		} else {
			b.WriteByte('+')
		}
		if x < 10 {
			b.WriteByte('0')
		}
		b.WriteString(strconv.Itoa(x))
		return b.String(), nil
	}
	switch {
	case decpt <= 0:
		b.WriteString("0.")
		b.WriteString(strings.Repeat("0", -decpt))
		b.WriteString(digits)
	case decpt >= len(digits):
		b.WriteString(digits)
		b.WriteString(strings.Repeat("0", decpt-len(digits)))
		b.WriteString(".0")
	default:
		b.WriteString(digits[:decpt])
		b.WriteByte('.')
		b.WriteString(digits[decpt:])
	}
	return b.String(), nil
}

// Marshal は、v を Python の API と同じ書式（上のパッケージの説明）で JSON にする。
func Marshal(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buf.Bytes(), []byte("\n")), nil
}

// Normalize は、Postgres の jsonb の出力を、Python の API が返すのと同じバイト列にする。
// Python の API は、jsonb を読んで（json.loads）、書き直している（json.dumps）。その結果と同じになるように、次を行う。
//   - 文字列の外の空白を除く（Postgres の出力は ": " と ", " の形）。キーの並び・文字列の書き方は変えない
//     （Postgres が書く文字列の逃がし方は、Python の json.dumps(ensure_ascii=False) と同じ）
//   - 小数点か指数のある数は、Python の float に読んで、repr で書き直す（Postgres の numeric の "0.00001" → "1e-05"、"1.50" → "1.5"）。
//     整数（小数点も指数も無い数）は、桁数が多くても、書かれたまま（Python の int と同じ）。"-0" は Python の int と同じ "0"
//
// 入力は、Postgres が書いた、正しい JSON であること（そうでなければエラー）。
func Normalize(src []byte) (json.RawMessage, error) {
	if !json.Valid(src) {
		return nil, errors.New("pyjson: JSON として読めません")
	}
	out := make([]byte, 0, len(src))
	for i := 0; i < len(src); {
		c := src[i]
		switch {
		case c == ' ' || c == '\t' || c == '\n' || c == '\r':
			i++
		case c == '"':
			j := i + 1
			for src[j] != '"' { // json.Valid を通っているので、閉じの " は必ずある
				if src[j] == '\\' {
					j++
				}
				j++
			}
			out = append(out, src[i:j+1]...)
			i = j + 1
		case c == '-' || (c >= '0' && c <= '9'):
			j := i
			for j < len(src) && strings.IndexByte("+-.eE0123456789", src[j]) >= 0 {
				j++
			}
			tok := string(src[i:j])
			switch {
			case tok == "-0":
				out = append(out, '0')
			case strings.ContainsAny(tok, ".eE"):
				f, err := strconv.ParseFloat(tok, 64)
				if err != nil { // 範囲外（Python では inf になり、書き出しで失敗する）
					return nil, fmt.Errorf("pyjson: 数を float に読めません: %w", err)
				}
				text, err := FormatFloat(f)
				if err != nil {
					return nil, err
				}
				out = append(out, text...)
			default:
				out = append(out, tok...)
			}
			i = j
		default: // { } [ ] , : と true・false・null の文字
			out = append(out, c)
			i++
		}
	}
	return json.RawMessage(out), nil
}

// Pair は、JSON のオブジェクトの 1 組（キーと、書き換えない値）。
type Pair struct {
	Key   string
	Value json.RawMessage
}

// Object は、キーの並びを保つ JSON のオブジェクト（Python の dict と同じ）。
type Object []Pair

// ParseObject は、JSON のオブジェクトを、キーの並びを保ったまま読む。オブジェクトでなければエラー（Python では dict の展開が TypeError になる場面）。
func ParseObject(src []byte) (Object, error) {
	dec := json.NewDecoder(bytes.NewReader(src))
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	if d, ok := tok.(json.Delim); !ok || d != '{' {
		return nil, errors.New("pyjson: JSON のオブジェクトではありません")
	}
	var obj Object
	for dec.More() {
		keyTok, err := dec.Token()
		if err != nil {
			return nil, err
		}
		key, ok := keyTok.(string)
		if !ok {
			return nil, errors.New("pyjson: キーが文字列ではありません")
		}
		var raw json.RawMessage
		if err := dec.Decode(&raw); err != nil {
			return nil, err
		}
		obj.Set(key, raw)
	}
	if _, err := dec.Token(); err != nil { // 閉じの }
		return nil, err
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return nil, errors.New("pyjson: オブジェクトのあとに余分な内容があります")
	}
	return obj, nil
}

// Has は、そのキーがあるか。
func (o Object) Has(key string) bool {
	for i := range o {
		if o[i].Key == key {
			return true
		}
	}
	return false
}

// Set は、キーがあればその位置の値を置き換え、無ければ末尾に足す（Python の dict の代入と同じ）。
func (o *Object) Set(key string, value json.RawMessage) {
	for i := range *o {
		if (*o)[i].Key == key {
			(*o)[i].Value = value
			return
		}
	}
	*o = append(*o, Pair{Key: key, Value: value})
}

// MarshalJSON は json.Marshaler。
func (o Object) MarshalJSON() ([]byte, error) {
	var buf bytes.Buffer
	buf.WriteByte('{')
	for i, p := range o {
		if i > 0 {
			buf.WriteByte(',')
		}
		k, err := Marshal(p.Key)
		if err != nil {
			return nil, err
		}
		buf.Write(k)
		buf.WriteByte(':')
		buf.Write(p.Value)
	}
	buf.WriteByte('}')
	return buf.Bytes(), nil
}
