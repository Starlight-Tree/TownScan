package imaging

import (
	"bytes"
	"context"
	"image"
	"image/color"
	"image/png"
	"math/rand"
	"testing"

	xdraw "golang.org/x/image/draw"
)

// texturedTile は、傾斜に粒（±8）を足した写真（PNG の圧縮が効きにくい、実際の写真に近い条件）。
func texturedTile(px int, seed int64) *image.RGBA {
	rng := rand.New(rand.NewSource(seed))
	img := image.NewRGBA(image.Rect(0, 0, px, px))
	n := func(v int) uint8 { return uint8(min(255, max(0, v+rng.Intn(17)-8))) }
	for y := 0; y < px; y++ {
		for x := 0; x < px; x++ {
			img.SetRGBA(x, y, color.RGBA{R: n(x), G: n(y), B: n((x + y) / 2), A: 255})
		}
	}
	return img
}

func benchRenderer(b *testing.B) *Renderer {
	dir := b.TempDir()
	for _, year := range Years {
		writeFile(b, tilePath(dir, year, tileX0, tileY0), encodePNG(b, texturedTile(256, int64(year))))
	}
	return NewRenderer(dir)
}

// 1 枚の画像を作る時間（サーバーの 1 リクエストの、画像を作る部分）
func BenchmarkRender(b *testing.B) {
	r := benchRenderer(b)
	for _, size := range []int{256, 512, 1024} {
		b.Run(itoa(size), func(b *testing.B) {
			q := request(2014, boxNew, "confirmed_new", size)
			b.ReportAllocs()
			for i := 0; i < b.N; i++ {
				if _, err := r.Render(context.Background(), q); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}

// 内訳: 拡大（x/image の補間）と PNG の符号化
func BenchmarkScaleAndEncode(b *testing.B) {
	crop := texturedTile(120, 7)
	for _, size := range []int{512, 1024} {
		out := image.NewRGBA(image.Rect(0, 0, size, size))
		b.Run("scale-"+itoa(size), func(b *testing.B) {
			for i := 0; i < b.N; i++ {
				xdraw.CatmullRom.Scale(out, out.Bounds(), crop, crop.Bounds(), xdraw.Src, nil)
			}
		})
		xdraw.CatmullRom.Scale(out, out.Bounds(), crop, crop.Bounds(), xdraw.Src, nil)
		for name, level := range map[string]png.CompressionLevel{"default": png.DefaultCompression, "speed": png.BestSpeed} {
			b.Run("encode-"+name+"-"+itoa(size), func(b *testing.B) {
				enc := png.Encoder{CompressionLevel: level}
				var n int
				for i := 0; i < b.N; i++ {
					var buf bytes.Buffer
					if err := enc.Encode(&buf, out); err != nil {
						b.Fatal(err)
					}
					n = buf.Len()
				}
				b.ReportMetric(float64(n), "bytes")
			})
		}
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var d []byte
	for ; n > 0; n /= 10 {
		d = append([]byte{byte('0' + n%10)}, d...)
	}
	return string(d)
}
