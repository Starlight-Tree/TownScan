package httpx

import (
	"strconv"
	"strings"
	"testing"
)

const (
	parse = "Input should be a valid integer, unable to parse string as an integer"
	ge1   = "Input should be greater than or equal to 1"
	le500 = "Input should be less than or equal to 500"
	size  = "Unable to parse input string as an integer, exceeded maximum size"
)

// Pydantic 2.14.4（FastAPI 0.165.0 の Query(ge=1, le=500)）に、同じ文字列を渡して得た結果。want が "ok:N" なら値 N、そうでなければ検証エラーの文言。
func TestIntRangeMatchesPydantic(t *testing.T) {
	cases := []struct{ in, want string }{
		{"1", "ok:1"}, {"0", ge1}, {"-0", ge1}, {"+0", ge1}, {"-1", ge1}, {"+1", "ok:1"}, {"01", "ok:1"}, {"007", "ok:7"},
		{"1_0", "ok:10"}, {"1__0", parse}, {"_1", parse}, {"1_", parse}, {"1_000", le500}, {"+_1", parse}, {"-1_0", ge1},
		{"1_0.0", "ok:10"}, {"1.0_0", parse},
		{"1.0", "ok:1"}, {"1.00", "ok:1"}, {"1.000", "ok:1"}, {"+1.0", "ok:1"}, {"-1.0", ge1}, {"1.", parse}, {".0", parse},
		{"0.0", ge1}, {"00.0", ge1}, {"1.10", parse}, {"1.01", parse}, {"1.5", parse}, {"1e2", parse}, {"1E2", parse}, {"1.0e0", parse},
		{" 1", "ok:1"}, {"1 ", "ok:1"}, {"\t5", "ok:5"}, {"\n3", "ok:3"}, {"3\n", "ok:3"}, {"1 0", parse},
		{"１", parse}, {"٣", parse}, {"0x10", parse}, {"0b1", parse}, {"0o7", parse}, {"", parse}, {" ", parse}, {"-", parse}, {"+", parse},
		{"--1", parse}, {"+-1", parse},
		{"9223372036854775807", le500}, {"9223372036854775808", le500}, {"-9223372036854775808", ge1}, {"-9223372036854775809", ge1},
		{"99999999999999999999", le500}, {"-99999999999999999999", ge1},
		{strings.Repeat("1", 4300), le500}, {strings.Repeat("1", 4301), size},
		{"　1", "ok:1"}, {"1　", "ok:1"}, {" 1", "ok:1"}, {"\x1c1", parse}, {"\u00851", "ok:1"},
		{"nan", parse}, {"inf", parse}, {"-inf", parse}, {"true", parse}, {"True", parse}, {"none", parse}, {"null", parse},
		{"1.0000000000000000000000001", parse}, {"1.0000000000000000000000", "ok:1"},
		{"100.0", "ok:100"}, {"500.0", "ok:500"}, {"501.0", le500},
		{"1_0.0_0", parse}, {"1,000", parse}, {"1.0.0", parse}, {"0.5e1", parse}, {"5e-1", parse}, {"٠", parse}, {"1\x00", parse},
		{"​1", parse}, {"٣.٠", parse},
	}
	r := IntRange{Ge: 1, Le: 500}
	for _, c := range cases {
		v, msg := r.Check(c.in)
		got := msg
		if msg == "" {
			got = "ok:" + strconv.FormatInt(v, 10)
		}
		if got != c.want {
			label := c.in
			if len(label) > 30 {
				label = label[:20] + "…"
			}
			t.Errorf("Check(%q) = %q, Pydantic = %q", label, got, c.want)
		}
	}
}

func TestIntRangeOffsetMessages(t *testing.T) {
	r := IntRange{Ge: 0, Le: 1_000_000}
	for in, want := range map[string]string{
		"0": "", "1000000": "", "1_000_000": "",
		"-1":      "Input should be greater than or equal to 0",
		"1000001": "Input should be less than or equal to 1000000",
	} {
		if _, msg := r.Check(in); msg != want {
			t.Errorf("Check(%q) = %q, 期待 %q", in, msg, want)
		}
	}
}

func TestPatternMatchesPydantic(t *testing.T) {
	area := NewPattern(`^z[0-9]{1,2}-[0-9]{1,7}-[0-9]{1,7}$`)
	cand := NewPattern(`^c-[0-9]{1,7}-[0-9]{1,7}-[0-9]{1,7}$`)
	wantMsg := "String should match pattern '^z[0-9]{1,2}-[0-9]{1,7}-[0-9]{1,7}$'"
	ok := []string{"z18-1-1", "z0-0-0", "z18-226249-105759", "z99-1234567-7654321"}
	bad := []string{"", "z18-1-1\n", " z18-1-1", "z18-١-1", "Z18-1-1", "z100-1-1", "z18-12345678-1", "z18-1-1-1", "z-1-1", "z18-1", "nope", "z18-1-1' OR '1'='1"}
	for _, s := range ok {
		if m := area.Check(s); m != "" {
			t.Errorf("%q は通るはず: %s", s, m)
		}
	}
	for _, s := range bad {
		if m := area.Check(s); m != wantMsg {
			t.Errorf("%q: %q", s, m)
		}
	}
	if m := cand.Check("c-226250-105759-1"); m != "" {
		t.Error(m)
	}
	for _, s := range []string{"c-1-2", "c-1-2-3\n", "c-1-2-3-4", "c-a-b-c", "c-12345678-1-1", "", "x"} {
		if m := cand.Check(s); m != "String should match pattern '^c-[0-9]{1,7}-[0-9]{1,7}-[0-9]{1,7}$'" {
			t.Errorf("%q: %q", s, m)
		}
	}
}

func TestLiteralMessages(t *testing.T) {
	classes := Literal{"confirmed_new", "existing_omission", "uncertain"}
	sorts := Literal{"area_desc", "area_asc"}
	if m := classes.Check("uncertain"); m != "" {
		t.Error(m)
	}
	if m := classes.Check("Confirmed_new"); m != "Input should be 'confirmed_new', 'existing_omission' or 'uncertain'" {
		t.Error(m)
	}
	if m := sorts.Check(""); m != "Input should be 'area_desc' or 'area_asc'" {
		t.Error(m)
	}
	if m := (Literal{"2014", "2024"}).Check("2020"); m != "Input should be '2014' or '2024'" {
		t.Error(m)
	}
	if m := (Literal{"x"}).Check("y"); m != "Input should be 'x'" {
		t.Error(m)
	}
}

func TestErrorsKeepDeclarationOrder(t *testing.T) {
	var e Errors
	if e.Err() != nil {
		t.Fatal("エラーが無ければ nil")
	}
	e.Add("query", "area_id", "a")
	e.Add("query", "limit", "b")
	err := e.Err()
	if err == nil || err.Status != 422 || err.Message != "引数が不正です（query.area_id）" || len(err.Details) != 2 || err.Details[1].Loc[1] != "limit" {
		t.Errorf("err = %+v", err)
	}
}
