// Package imaging は、検出画像（GET /api/candidates/{id}/image）を作る。backend/app/imaging.py（Pillow）の Go 版。
//
// IGN の z18 タイル（256x256）から、候補の外接矩形＋余白（約 20 m）の正方形を切り出して size x size に拡大し、
// 候補の外周を分類ごとの色・線種（実線＞破線＞点線）で描いた PNG を返す。向きは北が上。
// 候補がタイルの縁にあるときは、正方形のまま、タイルの内側へずらす（外側を埋めた画素を作らない）。
//
// 安全の決まり（テストで確かめる）:
//   - 年は許可リスト（2014・2024）だけ。タイルのパスは、DB の整数 x・y と許可済みの年からだけ作る（利用者の文字列を使わない）
//   - 解決したパス（シンボリックリンクを辿った先）が TILES_DIR の外なら読まない。開くときも os.Root で TILES_DIR の中に閉じ込める
//   - ファイルの大きさ・画像の寸法を、復号の前に上限で止める（巨大な画像でメモリーを食わない）。同時に作る数にも上限がある
//   - 応答・ログに、パス・環境の詳細を出さない（TileError の Reason は固定の文だけ）
//
// 拡大の補間は x/image の CatmullRom。Pillow の BICUBIC（a=-0.5）と同じ 3 次の核（Catmull-Rom。台は 2 画素）で、画素の中心の
// 取り方（(i+0.5)/倍率-0.5）も同じ。縮小（size 64 で、約 120 画素の切り出しを縮める）でも、核を倍率で広げるところまで同じ。
// 違いは、Pillow が横・縦の間で 8 ビットに丸めること（±1 程度）。
//
// 選んだ理由（実測。api/difftest/image.sh。24 候補 x 2 年 x 5 つの大きさ（64〜1024）= 240 組を、同じ候補・年・大きさで Python の API（Pillow
// BICUBIC）と比べた、輪郭を除く写真の部分の平均絶対差（0〜255）。補間以外は同じコードで、方式だけを替えて測った）:
//
//	CatmullRom 0.18 ・ BiLinear 0.68 ・ ApproxBiLinear 0.83 ・ NearestNeighbor 1.88
//
// 双 1 次（BiLinear）は核が違い（台 1 画素）、細い線・屋根の縁がなまる。ApproxBiLinear は、拡大（size 256 以上）では BiLinear と同じ結果で、
// 縮小（size 64）では 4 画素しか見ないため、差が 1.41 に開く。最近傍は、画素が見える。
//
// PNG の符号化は BestSpeed（画素は同じで、ファイルが約 2 割大きい）。実測（bench_test.go。粒のある写真の 512 x 512）で、標準の圧縮は約 110 ms、
// BestSpeed は約 14 ms（拡大は約 3 ms）。1024 では約 470 ms と約 50 ms。認証なしで開く入口なので、1 枚あたりの CPU を抑えるほうを選ぶ。
// 応答は private に 60 秒しか持たれないので、大きさの増加は、時間の短縮に見合う。
package imaging

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/png"

	xdraw "golang.org/x/image/draw"
)

// 切り出しの決まり（backend/app/imaging.py と同じ値）
const (
	// TileZ は、写真タイルの拡大レベル（IGN の z18。パリ近郊で 1 画素 約 0.4 m）
	TileZ = 18
	// MarginM は、候補の外接矩形に足す余白（m）
	MarginM = 20.0
	// MinSidePx は、小さい候補でも周囲が分かるように、切り出しの一辺の下限（256 画素のタイルでの値。z18 で約 19 m）
	MinSidePx = 32
	// MinSize・MaxSize・DefaultSize は、応答の画像の一辺（画素）
	MinSize     = 64
	MaxSize     = 1024
	DefaultSize = 512
)

// 輪郭の太さ（出力の画素。size によらず一定）。白い縁取り（暗い写真でも見える）の上に、分類の色を重ねる
const (
	casingWidth  = 7.0
	outlineWidth = 4.0
)

// pngEncoder は、応答の PNG の符号化（上の説明のとおり BestSpeed。状態を持たないので、同時に使ってよい）。
var pngEncoder = png.Encoder{CompressionLevel: png.BestSpeed}

// Years は、写真の年の許可リスト。
var Years = []int{2014, 2024}

// 上限（Python には無い。巨大・壊れた入力でメモリー・時間を食わないための、Go 側の守り）
const (
	// 写真ファイルの大きさ。z18 の 256x256 の PNG は数十 KB
	defaultMaxTileBytes = 8 << 20
	// 写真の一辺（画素）。256 のタイルの 4 倍まで
	defaultMaxTilePx = 1024
	// 候補の外周の頂点数。建物の外周は数十〜数百点
	defaultMaxVertices = 10_000
	// 同時に作る画像の数。1 枚の作業用メモリーは、最大でも数十 MB（写真の復号・切り出し・拡大・符号化）
	defaultMaxConcurrent = 8
)

// 理由の文（応答の message に入る。Python の TileUnavailable と同じ文。パス・環境の詳細を含めない）
const (
	reasonYear       = "対応していない年です"
	reasonTileNumber = "タイル番号が不正です"
	reasonOutside    = "許可された場所の外です"
	reasonMissing    = "この年の写真がありません"
	reasonUnreadable = "写真を読めません"
)

// TileError は、写真を用意できないとき（無い・読めない・許可された場所の外）。API は 404 tile_not_found にする。
// Reason は応答にそのまま載せてよい固定の文（パスを含まない）。
type TileError struct{ Reason string }

func (e *TileError) Error() string {
	return "imaging: 写真を用意できません（" + e.Reason + "）"
}

// ErrInvalid は、入力が不正なとき（外接矩形・外周の座標が数でない・桁外れ、頂点が多すぎる、外周を読めない、size が範囲外）。
// 検証済みの入力では起きない。DB の値の誤りなので、API は 500 にする（Python も例外のまま 500 になる）。
var ErrInvalid = errors.New("imaging: 入力が不正です")

func invalid(what string) error { return fmt.Errorf("%w: %s", ErrInvalid, what) }

// Request は、画像 1 枚の入力。写真の場所は、地区のタイル番号（TileX・TileY）と年から決まる。
type Request struct {
	Year         int
	TileX, TileY int
	// 候補の外接矩形 [西, 南, 東, 北]（経度・緯度）
	BBox [4]float64
	// 候補の形（GeoJSON の Polygon。外周だけを使う）
	Geometry []byte
	// 候補の分類（confirmed_new・existing_omission・uncertain。知らない値は uncertain の見た目）
	Class string
	// 応答の画像の一辺（MinSize〜MaxSize）
	Size int
}

// Renderer は、TILES_DIR の写真から検出画像を作る。同時に使ってよい。
type Renderer struct {
	dir string
	sem chan struct{}

	maxTileBytes int64
	maxTilePx    int
	maxVertices  int
}

// NewRenderer は、写真の置き場（TILES_DIR）を指定して作る。空の文字列は「置き場が無い」（カレントディレクトリは読まない）。
func NewRenderer(tilesDir string) *Renderer {
	return &Renderer{
		dir:          tilesDir,
		sem:          make(chan struct{}, defaultMaxConcurrent),
		maxTileBytes: defaultMaxTileBytes,
		maxTilePx:    defaultMaxTilePx,
		maxVertices:  defaultMaxVertices,
	}
}

// Render は、PNG（RGB 8 ビット。size x size）を作る。写真を用意できなければ *TileError、入力の誤りは ErrInvalid、
// 待っているあいだに ctx が取り消されれば ctx.Err()。
func (r *Renderer) Render(ctx context.Context, q Request) ([]byte, error) {
	if q.Size < MinSize || q.Size > MaxSize {
		return nil, invalid("size が範囲外です")
	}
	select {
	case r.sem <- struct{}{}:
		defer func() { <-r.sem }()
	case <-ctx.Done():
		return nil, ctx.Err()
	}

	// 順序は Python と同じ: 写真（年・番号・パス・復号）→ 切り出し → 拡大 → 外周 → 符号化
	tile, err := r.loadTile(q.Year, q.TileX, q.TileY)
	if err != nil {
		return nil, err
	}
	tilePx := tile.Bounds().Dx()
	box, err := cropBox(q.BBox, q.TileX, q.TileY, tilePx, MarginM)
	if err != nil {
		return nil, err
	}
	crop := extract(tile, box)

	// 拡大。Pillow の crop().resize((size, size), BICUBIC) と同じ（核は Catmull-Rom。上の説明）
	out := image.NewRGBA(image.Rect(0, 0, q.Size, q.Size))
	xdraw.CatmullRom.Scale(out, out.Bounds(), crop, crop.Bounds(), xdraw.Src, nil)

	if err := r.drawOutline(out, q, box, tilePx); err != nil {
		return nil, err
	}

	var buf bytes.Buffer
	if err := pngEncoder.Encode(&buf, out); err != nil {
		return nil, fmt.Errorf("imaging: PNG に書けません: %w", err)
	}
	return buf.Bytes(), nil
}

// extract は、写真の r の範囲を、原点が (0,0) の RGBA（不透明）にして返す。
// 透明度は無視して、RGB の値をそのまま使う（Pillow の convert("RGB") と同じ）。
func extract(src image.Image, r image.Rectangle) *image.RGBA {
	b := src.Bounds()
	dst := image.NewRGBA(image.Rect(0, 0, r.Dx(), r.Dy()))
	for y := 0; y < r.Dy(); y++ {
		for x := 0; x < r.Dx(); x++ {
			// 非乗算済み（NRGBA）にしてから RGB を取る: 乗算済みの値のままだと、半透明の画素が暗くなる
			c := color.NRGBAModel.Convert(src.At(b.Min.X+r.Min.X+x, b.Min.Y+r.Min.Y+y)).(color.NRGBA)
			dst.SetRGBA(x, y, color.RGBA{R: c.R, G: c.G, B: c.B, A: 0xff})
		}
	}
	return dst
}
