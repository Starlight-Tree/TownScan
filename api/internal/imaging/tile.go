package imaging

import (
	"errors"
	"image"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"

	// 写真の復号に使う形式（ファイルの中身で判別する。Pillow の Image.open と同じ。拡張子は見ない）
	_ "image/jpeg"
	_ "image/png"
)

// loadTile は、年・タイル番号の写真を読む。年・番号の検証 → パスの解決（TILES_DIR の外を拒否）→ 大きさ・寸法の上限 → 復号。
// 用意できないときは *TileError（理由は固定の文。パスを含まない）。
func (r *Renderer) loadTile(year, x, y int) (image.Image, error) {
	if !allowedYear(year) {
		return nil, &TileError{reasonYear}
	}
	limit := 1 << TileZ
	if x < 0 || x >= limit || y < 0 || y >= limit {
		return nil, &TileError{reasonTileNumber}
	}
	if r.dir == "" {
		return nil, &TileError{reasonMissing}
	}

	// TILES_DIR を、シンボリックリンクを辿った実体にする（TILES_DIR 自体がリンクでもよい）
	base, err := filepath.Abs(r.dir)
	if err == nil {
		base, err = filepath.EvalSymlinks(base)
	}
	if err != nil {
		return nil, &TileError{reasonMissing}
	}
	// パスは、整数の年・番号からだけ作る（利用者の文字列は入らない）
	rel := filepath.Join(strconv.Itoa(year), strconv.Itoa(x)+"_"+strconv.Itoa(y)+".png")
	resolved, err := filepath.EvalSymlinks(filepath.Join(base, rel))
	switch {
	case errors.Is(err, fs.ErrNotExist), errors.Is(err, syscall.ENOTDIR): // 年のディレクトリが無い・途中がファイル
		return nil, &TileError{reasonMissing}
	case err != nil: // リンクの輪・権限など
		return nil, &TileError{reasonUnreadable}
	}
	inside, err := filepath.Rel(base, resolved)
	if err != nil || inside == ".." || strings.HasPrefix(inside, ".."+string(filepath.Separator)) {
		return nil, &TileError{reasonOutside}
	}

	// 開くときも、TILES_DIR の中に閉じ込める（上の確認と開くあいだに、リンクを差し替えられても外へ出られない）
	root, err := os.OpenRoot(base)
	if err != nil {
		return nil, &TileError{reasonMissing}
	}
	defer root.Close()
	f, err := root.Open(inside)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, &TileError{reasonMissing}
		}
		return nil, &TileError{reasonUnreadable}
	}
	defer f.Close()

	st, err := f.Stat()
	if err != nil || !st.Mode().IsRegular() { // ディレクトリ・デバイスなどは、写真ではない
		return nil, &TileError{reasonMissing}
	}
	if st.Size() == 0 || st.Size() > r.maxTileBytes {
		return nil, &TileError{reasonUnreadable}
	}

	// 先に寸法だけを読み、上限を超える画像は復号しない（小さなファイルが巨大な画像になる、圧縮爆弾の対策）
	src := io.NewSectionReader(f, 0, st.Size())
	cfg, _, err := image.DecodeConfig(src)
	if err != nil || cfg.Width <= 0 || cfg.Width != cfg.Height || cfg.Width > r.maxTilePx {
		return nil, &TileError{reasonUnreadable}
	}
	if _, err := src.Seek(0, io.SeekStart); err != nil {
		return nil, &TileError{reasonUnreadable}
	}
	img, _, err := image.Decode(src)
	if err != nil {
		return nil, &TileError{reasonUnreadable}
	}
	return img, nil
}

func allowedYear(year int) bool {
	for _, y := range Years {
		if y == year {
			return true
		}
	}
	return false
}
