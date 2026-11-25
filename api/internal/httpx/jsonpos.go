package httpx

// 壊れた JSON の「位置」を、Python（json.loads。C の高速版。3.13）と同じにするための読み取り。
// FastAPI は、JSON として読めない本文を、422 の loc に ["body", JSONDecodeError.pos] として返す（pos は文字数）。
// Go の encoding/json は、同じ誤りでも位置が違う（リテラル・数字・文字列の中の誤り・末尾のコンマなど）ので、
// 失敗したあとだけ、Python の読み方（Modules/_json.c の scan_once・_parse_object・_parse_array・scanstring と、
// Lib/json/decoder.py の decode）をなぞって、最初に誤りになる位置を探す。受け入れる本文の範囲は広げない（読むのは encoding/json）。

// pyJSONError は、Python の JSONDecodeError（位置 = 文字数）。
type pyJSONError struct{ pos int }

type pyJSONScanner struct{ s []rune }

// pyJSONErrorPos は、text（UTF-8 から復号した文字列）を Python の json.loads で読んだときの誤りの位置。
// Python が受け入れる本文（NaN・Infinity など。encoding/json は断る）なら ok=false。
func pyJSONErrorPos(text []rune) (pos int, ok bool) {
	p := pyJSONScanner{text}
	end, err := p.value(p.ws(0))
	if err != nil {
		return err.pos, true
	}
	if end = p.ws(end); end != len(text) { // Extra data
		return end, true
	}
	return 0, false
}

// ws は、JSON の空白（半角の空白・タブ・改行・CR）を読み飛ばす。
func (p *pyJSONScanner) ws(i int) int {
	for i < len(p.s) && (p.s[i] == ' ' || p.s[i] == '\t' || p.s[i] == '\n' || p.s[i] == '\r') {
		i++
	}
	return i
}

func (p *pyJSONScanner) has(i int, lit string) bool {
	r := []rune(lit)
	return i+len(r) <= len(p.s) && string(p.s[i:i+len(r)]) == lit
}

// value は、i から値を 1 つ読み、次の位置を返す（scan_once。値が無ければ Expecting value = 値の始まりの位置）。
func (p *pyJSONScanner) value(i int) (int, *pyJSONError) {
	if i >= len(p.s) {
		return 0, &pyJSONError{i}
	}
	switch p.s[i] {
	case '"':
		return p.str(i + 1)
	case '{':
		return p.object(i + 1)
	case '[':
		return p.array(i + 1)
	case 'n':
		if p.has(i, "null") {
			return i + 4, nil
		}
	case 't':
		if p.has(i, "true") {
			return i + 4, nil
		}
	case 'f':
		if p.has(i, "false") {
			return i + 5, nil
		}
	case 'N':
		if p.has(i, "NaN") {
			return i + 3, nil
		}
	case 'I':
		if p.has(i, "Infinity") {
			return i + 8, nil
		}
	case '-':
		if p.has(i, "-Infinity") {
			return i + 9, nil
		}
	}
	return p.number(i)
}

func isJSONDigit(r rune) bool { return r >= '0' && r <= '9' }

// number は、数字（_match_number_unicode）。整数部が無ければ Expecting value（始まりの位置）。
// 数字の後ろの「.」「e」の続きが数字になっていなければ、そこで止める（残りは、呼び出し側が Extra data などにする）。
func (p *pyJSONScanner) number(start int) (int, *pyJSONError) {
	s, n, i := p.s, len(p.s), start
	if s[i] == '-' {
		if i++; i >= n {
			return 0, &pyJSONError{start}
		}
	}
	switch {
	case s[i] >= '1' && s[i] <= '9':
		for i++; i < n && isJSONDigit(s[i]); i++ {
		}
	case s[i] == '0':
		i++
	default:
		return 0, &pyJSONError{start}
	}
	if i+1 < n && s[i] == '.' && isJSONDigit(s[i+1]) {
		for i += 2; i < n && isJSONDigit(s[i]); i++ {
		}
	}
	if i+1 < n && (s[i] == 'e' || s[i] == 'E') {
		eStart := i
		i++
		if i+1 < n && (s[i] == '-' || s[i] == '+') {
			i++
		}
		for ; i < n && isJSONDigit(s[i]); i++ {
		}
		if !isJSONDigit(s[i-1]) { // 指数に数字が無かった: 「e」の手前へ戻る
			i = eStart
		}
	}
	return i, nil
}

// hex4 は、4 文字の 16 進数（大文字小文字は問わない）を値にする。
func hex4(r []rune) (v rune, ok bool) {
	for _, c := range r {
		v <<= 4
		switch {
		case c >= '0' && c <= '9':
			v |= c - '0'
		case c >= 'a' && c <= 'f':
			v |= c - 'a' + 10
		case c >= 'A' && c <= 'F':
			v |= c - 'A' + 10
		default:
			return 0, false
		}
	}
	return v, true
}

// str は、文字列（scanstring。i は、始まりの「"」の次）。制御文字・閉じていない・不正な逃がしは、それぞれ Python の位置で誤りにする。
func (p *pyJSONScanner) str(i int) (int, *pyJSONError) {
	s, n, begin := p.s, len(p.s), i-1
	end := i
	for {
		next := end
		for ; next < n && s[next] != '"' && s[next] != '\\'; next++ {
			if s[next] <= 0x1f { // Invalid control character
				return 0, &pyJSONError{next}
			}
		}
		if next >= n { // Unterminated string starting at
			return 0, &pyJSONError{begin}
		}
		c := s[next]
		next++
		if c == '"' {
			return next, nil
		}
		if next == n {
			return 0, &pyJSONError{begin}
		}
		if s[next] != 'u' {
			end = next + 1
			switch s[next] {
			case '"', '\\', '/', 'b', 'f', 'n', 'r', 't':
			default: // Invalid \escape（位置は、逆スラッシュ）
				return 0, &pyJSONError{end - 2}
			}
			continue
		}
		next++
		end = next + 4
		if end > n { // Invalid \uXXXX escape（4 桁の分の文字が無い）
			return 0, &pyJSONError{next - 1}
		}
		hi, ok := hex4(s[next:end])
		if !ok {
			return 0, &pyJSONError{end - 5}
		}
		// 上位サロゲートの直後に、もう 1 つ \uXXXX があれば、対として読む（その 4 桁が 16 進数でなければ、これも誤り）
		if hi >= 0xd800 && hi <= 0xdbff && end+6 < n && s[end] == '\\' && s[end+1] == 'u' {
			lo, ok := hex4(s[end+2 : end+6])
			if !ok {
				return 0, &pyJSONError{end + 1}
			}
			if lo >= 0xdc00 && lo <= 0xdfff {
				end += 6
			}
		}
	}
}

// array は、配列（_parse_array_unicode。i は、「[」の次）。
func (p *pyJSONScanner) array(i int) (int, *pyJSONError) {
	s, n := p.s, len(p.s)
	if i = p.ws(i); i < n && s[i] == ']' {
		return i + 1, nil
	}
	for {
		end, err := p.value(i)
		if err != nil {
			return 0, err
		}
		i = p.ws(end)
		if i < n && s[i] == ']' {
			return i + 1, nil
		}
		if i >= n || s[i] != ',' { // Expecting ',' delimiter
			return 0, &pyJSONError{i}
		}
		comma := i
		if i = p.ws(i + 1); i < n && s[i] == ']' { // Illegal trailing comma before end of array
			return 0, &pyJSONError{comma}
		}
	}
}

// object は、オブジェクト（_parse_object_unicode。i は、「{」の次）。
func (p *pyJSONScanner) object(i int) (int, *pyJSONError) {
	s, n := p.s, len(p.s)
	if i = p.ws(i); i < n && s[i] == '}' {
		return i + 1, nil
	}
	for {
		if i >= n || s[i] != '"' { // Expecting property name enclosed in double quotes
			return 0, &pyJSONError{i}
		}
		end, err := p.str(i + 1)
		if err != nil {
			return 0, err
		}
		if i = p.ws(end); i >= n || s[i] != ':' { // Expecting ':' delimiter
			return 0, &pyJSONError{i}
		}
		if end, err = p.value(p.ws(i + 1)); err != nil {
			return 0, err
		}
		i = p.ws(end)
		if i < n && s[i] == '}' {
			return i + 1, nil
		}
		if i >= n || s[i] != ',' { // Expecting ',' delimiter
			return 0, &pyJSONError{i}
		}
		comma := i
		if i = p.ws(i + 1); i < n && s[i] == '}' { // Illegal trailing comma before end of object
			return 0, &pyJSONError{comma}
		}
	}
}
