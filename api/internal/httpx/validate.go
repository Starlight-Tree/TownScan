package httpx

import (
	"fmt"
	"math/big"
	"regexp"
	"strings"
	"unicode"

	"townscan/api/internal/apierr"
)

// この検証は、FastAPI（Pydantic v2）の Query(...)・Path(...)・Literal の、観測できる結果（検証エラーの場所と英語の文言）を写したもの。
// 表（validate_test.go）は、Pydantic 2.14 に同じ入力を渡して得た結果で作ってある。

// Errors は、検証エラーを集める（引数ごとに独立に検証し、宣言の順に並べる。FastAPI と同じ）。
type Errors struct{ details []apierr.Detail }

// Add は、場所（"query"・"path"）と引数名、理由を足す。
func (e *Errors) Add(where, name, msg string) {
	e.details = append(e.details, apierr.Detail{Loc: []string{where, name}, Msg: msg})
}

// Err は、エラーがあれば 422 のエラー。無ければ nil。
func (e *Errors) Err() *apierr.Error {
	if len(e.details) == 0 {
		return nil
	}
	return apierr.Validation(e.details)
}

// Pattern は、文字列の引数の形（Pydantic の pattern）。
type Pattern struct {
	source string
	re     *regexp.Regexp
}

// NewPattern は、"^…$" の形の正規表現。source は、エラー文にそのまま入る。
func NewPattern(source string) Pattern {
	return Pattern{source: source, re: regexp.MustCompile(source)}
}

// Check は、s が形に合えば空の文字列、合わなければ Pydantic と同じ文言。
func (p Pattern) Check(s string) string {
	if p.re.MatchString(s) {
		return ""
	}
	return fmt.Sprintf("String should match pattern '%s'", p.source)
}

// Literal は、決まった文字列のどれかでなければならない引数（Pydantic の Literal）。
type Literal []string

// Check は、s が選択肢のどれかなら空の文字列、違えば Pydantic と同じ文言（"Input should be 'a', 'b' or 'c'"）。
func (l Literal) Check(s string) string {
	for _, o := range l {
		if s == o {
			return ""
		}
	}
	quoted := make([]string, len(l))
	for i, o := range l {
		quoted[i] = "'" + o + "'"
	}
	if len(quoted) == 1 {
		return "Input should be " + quoted[0]
	}
	return "Input should be " + strings.Join(quoted[:len(quoted)-1], ", ") + " or " + quoted[len(quoted)-1]
}

const (
	msgIntParsing     = "Input should be a valid integer, unable to parse string as an integer"
	msgIntParsingSize = "Unable to parse input string as an integer, exceeded maximum size"
	// Pydantic（pydantic-core）は、文字列から整数を読むとき、前後の空白を除いたあと 4300 バイトまでしか読まない
	maxIntBytes = 4300
)

// IntRange は、整数の引数の範囲（Pydantic の Query(ge=, le=)）。
type IntRange struct{ Ge, Le int64 }

// Check は、クエリの値（文字列）を整数として読み、範囲を確かめる。ok のとき value が値、そうでなければ msg が理由。
//
// 文字列から整数への読み方は、Pydantic の lax モードと同じ:
//   - 前後の Unicode の空白を除く（"%201"・"3\n" は通る）
//   - 符号 +/-、先頭の 0（"01"）、桁の間の 1 つだけの _（"1_0" = 10。"1__0"・"_1"・"1_" は不可）
//   - 小数点以下がすべて 0 の形（"1.0"・"1.00" = 1。"1.5"・"1."・".5"・"1e2"・"1.0_0" は不可）
//   - 全角の数字・16 進（"0x10"）・"nan"・"true" は不可。桁数に上限は無い（大きな値は範囲の違反として扱う）
func (r IntRange) Check(raw string) (value int64, msg string) {
	s := strings.TrimFunc(raw, unicode.IsSpace)
	if len(s) > maxIntBytes {
		return 0, msgIntParsingSize
	}
	n, ok := parsePydanticInt(s)
	if !ok {
		return 0, msgIntParsing
	}
	if n.Cmp(big.NewInt(r.Ge)) < 0 {
		return 0, fmt.Sprintf("Input should be greater than or equal to %d", r.Ge)
	}
	if n.Cmp(big.NewInt(r.Le)) > 0 {
		return 0, fmt.Sprintf("Input should be less than or equal to %d", r.Le)
	}
	return n.Int64(), ""
}

var intPattern = regexp.MustCompile(`^([+-]?)([0-9]+(?:_[0-9]+)*)(?:\.0+)?$`)

func parsePydanticInt(s string) (*big.Int, bool) {
	m := intPattern.FindStringSubmatch(s)
	if m == nil {
		return nil, false
	}
	n, ok := new(big.Int).SetString(strings.ReplaceAll(m[2], "_", ""), 10)
	if !ok {
		return nil, false
	}
	if m[1] == "-" {
		n.Neg(n)
	}
	return n, true
}
