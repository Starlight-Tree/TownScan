package pyjson

import (
	"encoding/json"
	"math"
	"strings"
	"testing"
)

// Python 3.13 の repr(float)（json.dumps と同じ）で作った表。キーは float64 のビット列（-0.0 などを正確に書くため）。
var pythonFloats = []struct {
	bits uint64
	want string
}{
	{0x0000000000000000, "0.0"},
	{0x8000000000000000, "-0.0"},
	{0x3ff0000000000000, "1.0"},
	{0xbff0000000000000, "-1.0"},
	{0x4059000000000000, "100.0"},
	{0x3fb999999999999a, "0.1"},
	{0x3ee4f8b588e368f1, "1e-05"},
	{0x3f1a36e2eb1c432d, "0.0001"},
	{0x3f202e4b6ce5dc68, "0.00012345"},
	{0x4341c37937e08000, "1e+16"},
	{0x430c6bf526340000, "1000000000000000.0"},
	{0x4341c37937e07fff, "9999999999999998.0"},
	{0x4376345785d89fff, "9.999999999999998e+16"},
	{0x437b69b4ba630f35, "1.2345678901234568e+17"},
	{0x0000000000000001, "5e-324"},
	{0x7fefffffffffffff, "1.7976931348623157e+308"},
	{0x406056a43c551ae4, "130.70754829999998"},
	{0x3fd3333333333334, "0.30000000000000004"},
	{0x4480f0cf064dd592, "1e+22"},
	{0x444b1ae4d6e2ef50, "1e+21"},
	{0x419d6f3454000000, "123456789.0"},
	{0x3e90c6f7a0b5ed8d, "2.5e-07"},
	{0x54b249ad2594c37d, "1e+100"},
	{0xbde49da7e361ce4c, "-1.5e-10"},
	{0x407f7ccccccccccd, "503.8"},
	{0x404067358e0820a4, "32.806321863144404"},
	{0x410b9e4800000000, "226249.0"},
	{0x3fe0000000000000, "0.5"},
	{0x4345ee2a2eb5a5c4, "1.2345678901234568e+16"},
	{0x43118b54f22aeb00, "1234567890123456.0"},
	{0x3f50624dd2f1a9fc, "0.001"},
	{0x400921f9f01b866e, "3.14159"},
	{0x3f1a36371ea531a8, "9.999e-05"},
	{0x432ee89a998bc000, "4350000000000000.0"},
	{0x4372dfb0cb5e8800, "8.5e+16"},
	{0x4376345785d8a000, "1e+17"},
	{0x7e41eb2d66005835, "1.5e+300"},
	{0x0010000000000000, "2.2250738585072014e-308"},
	{0xf2a74de452e6b438, "-1.989032661366619e+244"},
	{0x6513270e269e0d37, "7.761117632285041e+178"},
	{0x0c5c7fd0a6a3a450, "3.980498358697587e-249"},
	{0xd23f0824128b2f33, "-1.5432835417340557e+88"},
	{0x1818e811892f902b, "1.3647584518757569e-192"},
	{0x9531985d5d9dc9f8, "-1.3701135617873088e-206"},
	{0xe8e25d940ed90475, "-1.7160537630466207e+197"},
	{0x36f675cc81e74ef5, "6.294675241195386e-44"},
	{0x1600a35a099950d8, "1.0613447212142254e-202"},
	{0x6b0d549b6f03675a, "4.708325160387546e+207"},
	{0x3d9c172411e20b8f, "6.387016158513563e-12"},
	{0x8d116ece1738f7d9, "-9.973130378568733e-246"},
	{0x0f21ddb66cad4a26, "8.779753225680271e-236"},
	{0x90c192cfd3ac94af, "-5.795503248498993e-228"},
	{0xf28c105d1fb17c23, "-5.988180159386011e+243"},
	{0xa170b33839263059, "-1.306052388527796e-147"},
	{0x953f48f1a09f76b5, "-2.436117699484841e-206"},
	{0x0fd630f1f29d0da9, "2.233386999150174e-232"},
	{0x95e60af593bd04cf, "-3.51527970626667e-203"},
	{0x0cb1e29c658cda14, "1.5987381841032883e-247"},
	{0x4067e00000000000, "191.0"},
	{0x4036ab851eb851ec, "22.67"},
	{0xc0550a3d70a3d70a, "-84.16"},
	{0x4030463c13e45ad5, "16.274354213"},
	{0xc053270a3d70a3d7, "-76.61"},
	{0xc063d8e30a9dac93, "-158.777715023"},
	{0x404bc85eb313be23, "55.56539"},
	{0xc064200000000000, "-161.0"},
	{0x4039bf502ef95f1e, "25.747317253"},
	{0xc05d6774fac90974, "-117.61651487"},
}

func TestFormatFloatMatchesPythonRepr(t *testing.T) {
	for _, c := range pythonFloats {
		f := math.Float64frombits(c.bits)
		got, err := FormatFloat(f)
		if err != nil {
			t.Fatalf("%#x: %v", c.bits, err)
		}
		if got != c.want {
			t.Errorf("%#x: FormatFloat = %q, Python = %q", c.bits, got, c.want)
		}
		// Float の MarshalJSON も同じ文字列を書く
		b, err := Marshal(Float(f))
		if err != nil || string(b) != c.want {
			t.Errorf("%#x: Marshal(Float) = %q, %v; 期待 %q", c.bits, b, err, c.want)
		}
	}
}

func TestFloatRejectsNaNAndInfinity(t *testing.T) {
	for _, f := range []float64{math.NaN(), math.Inf(1), math.Inf(-1)} {
		if _, err := Marshal(Float(f)); err == nil {
			t.Errorf("%v は書けないはず", f)
		}
	}
}

func TestMarshalUsesCompactUnescapedUTF8(t *testing.T) {
	type row struct {
		Name string  `json:"name"`
		Note *string `json:"note"`
		Vals []Float `json:"vals"`
	}
	got, err := Marshal(row{Name: "合成町 <a & b>", Vals: []Float{1, 0.5}})
	if err != nil {
		t.Fatal(err)
	}
	want := `{"name":"合成町 <a & b>","note":null,"vals":[1.0,0.5]}`
	if string(got) != want {
		t.Errorf("Marshal = %s\n期待   = %s", got, want)
	}
}

// Python の json.dumps(ensure_ascii=False) の文字列の書き方と同じ（短い形は \b \f \n \r \t、そのほかの制御文字は小文字の \u00xx、DEL は書き換えない）
func TestMarshalStringEscapesLikePython(t *testing.T) {
	got, err := Marshal("a\"b\\c\bd\fe\nf\rg\th\x01i\x1fj\x7fk")
	if err != nil {
		t.Fatal(err)
	}
	want := "\"a\\\"b\\\\c\\bd\\fe\\nf\\rg\\th\\u0001i\\u001fj\x7fk\""
	if string(got) != want {
		t.Errorf("Marshal = %q\n期待   = %q", got, want)
	}
}

// 左: Postgres の jsonb が書く形（": " と ", " の間に空白がある。numeric は "0.00001"・"1.50"）。右: Python の API（json.loads → json.dumps）が返すバイト列。
// 右は Python 3.13 で作った。
var normalizeCases = []struct{ in, want string }{
	{`{"b": [1, 2.50, 1e-05, "x y"], "a": {"c": null, "d": true}}`, `{"b":[1,2.5,1e-05,"x y"],"a":{"c":null,"d":true}}`},
	{`{"x": 0.00001, "y": 0.0001, "z": 1.0, "w": 100.0, "v": 100, "u": -0.5, "t": 1E5, "s": 1.5e-7, "r": 12345678901234567890}`,
		`{"x":1e-05,"y":0.0001,"z":1.0,"w":100.0,"v":100,"u":-0.5,"t":100000.0,"s":1.5e-07,"r":12345678901234567890}`},
	{`[0.1000, 5.0, 5, -0, -0.0, 1e16, 1e15, 123456789012345678.5, 1.7976931348623157e308, 5e-324, 0.30000000000000004]`,
		`[0.1,5.0,5,0,-0.0,1e+16,1000000000000000.0,1.2345678901234568e+17,1.7976931348623157e+308,5e-324,0.30000000000000004]`},
	{`{"s": "あ\n\t\"\\ \u001f 😀 / ", "e": "", "n": [], "o": {}}`, `{"s":"あ\n\t\"\\ \u001f 😀 / ","e":"","n":[],"o":{}}`},
	{`{"deep": [[[{"k": [1.25, {"j": 2.0}]}]]], "bb": 1, "a": 2}`, `{"deep":[[[{"k":[1.25,{"j":2.0}]}]]],"bb":1,"a":2}`},
	{" \n {\"a\" : [ 1 , 2 ] } \t", `{"a":[1,2]}`},
	{`"just a string"`, `"just a string"`},
	{`12`, `12`}, {`12.50`, `12.5`}, {`null`, `null`}, {`true`, `true`}, {`[]`, `[]`}, {`{}`, `{}`},
	{`{"area": 503.80, "nums": [0.10, 0.200, 3.000]}`, `{"area":503.8,"nums":[0.1,0.2,3.0]}`},
	{`{"coordinates": [[[130.7074142, 32.8066285], [130.7076824, 32.8064481]]]}`, `{"coordinates":[[[130.7074142,32.8066285],[130.7076824,32.8064481]]]}`},
}

func TestNormalizeMatchesPythonRedump(t *testing.T) {
	for _, c := range normalizeCases {
		got, err := Normalize([]byte(c.in))
		if err != nil {
			t.Errorf("%s: %v", c.in, err)
			continue
		}
		if string(got) != c.want {
			t.Errorf("Normalize(%s)\n  = %s\n期待 %s", c.in, got, c.want)
		}
	}
}

func TestNormalizeRejectsBrokenOrOutOfRangeInput(t *testing.T) {
	for _, src := range []string{`{"a":`, ``, `{"a": 1e999}`, `[1.5e999]`, `{"a" 1}`} {
		if _, err := Normalize([]byte(src)); err == nil {
			t.Errorf("%q はエラーのはず", src)
		}
	}
	// 整数は、桁数が多くても書かれたまま（範囲外にならない）
	big := `[` + strings.Repeat("9", 400) + `]`
	if got, err := Normalize([]byte(big)); err != nil || string(got) != big {
		t.Errorf("大きな整数: %v", err)
	}
}

func TestObjectKeepsKeyOrderAndReplacesInPlace(t *testing.T) {
	obj, err := ParseObject([]byte(`{"z": 1, "provenance": "old", "a": {"k": [1, 2]}}`))
	if err != nil {
		t.Fatal(err)
	}
	obj.Set("provenance", json.RawMessage(`{"x":1}`))
	obj.Set("new", json.RawMessage(`2`))
	got, err := Marshal(obj)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"z":1,"provenance":{"x":1},"a":{"k":[1,2]},"new":2}`
	if string(got) != want {
		t.Errorf("Marshal = %s\n期待   = %s", got, want)
	}
}

func TestParseObjectRejectsNonObjects(t *testing.T) {
	for _, src := range []string{`[1]`, `1`, `"x"`, `null`, `{"a":1} 2`, `{"a":1`, ``, `{1:2}`} {
		if _, err := ParseObject([]byte(src)); err == nil {
			t.Errorf("%q はエラーのはず", src)
		}
	}
	if obj, err := ParseObject([]byte(`{}`)); err != nil || len(obj) != 0 {
		t.Errorf("空のオブジェクト: %v, %v", obj, err)
	}
	// 空でも "{}" と書く（null にならない）
	if b, _ := Marshal(Object{}); strings.TrimSpace(string(b)) != "{}" {
		t.Errorf("空の Object = %s", b)
	}
}
