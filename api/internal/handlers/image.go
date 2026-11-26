package handlers

import (
	"errors"
	"fmt"
	"net/http"
	"strconv"

	"townscan/api/internal/apierr"
	"townscan/api/internal/httpx"
	"townscan/api/internal/imaging"
)

// 検出画像の引数の検証（routes.py の candidate_image: year は Literal["2014","2024"]、size は Query(512, ge=64, le=1024)）
var (
	yearLiteral = httpx.Literal{"2014", "2024"}
	sizeRange   = httpx.IntRange{Ge: imaging.MinSize, Le: imaging.MaxSize}
)

// msgFieldRequired は、必須の引数が無いときの文（Pydantic v2 の "Field required"）
const msgFieldRequired = "Field required"

// imageAPI は、GET /api/candidates/{id}/image。写真は TILES_DIR から読む。
type imageAPI struct {
	*api
	renderer *imaging.Renderer
}

// registerImage は、検出画像のルートを足す。
func (a *api) registerImage(rt *httpx.Router) {
	h := &imageAPI{api: a, renderer: imaging.NewRenderer(a.d.TilesDir)}
	rt.Handle(http.MethodGet, "/api/candidates/{candidate_id}/image", h.get)
}

// get は、候補の写真の切り出し（輪郭つきの PNG）。順序は Python と同じ:
// 検証（422。candidate_id → year → size の順に集める）→ run が無ければ 503 → 候補が無ければ 404 → 写真を用意できなければ 404（tile_not_found）。
func (h *imageAPI) get(w http.ResponseWriter, r *http.Request, p httpx.Params) {
	var errs httpx.Errors
	id := p["candidate_id"]
	if msg := candidateIDPattern.Check(id); msg != "" {
		errs.Add("path", "candidate_id", msg)
	}
	q := httpx.ParseQuery(r.URL.RawQuery)
	year := 0
	if v, ok := q.Get("year"); !ok {
		errs.Add("query", "year", msgFieldRequired)
	} else if msg := yearLiteral.Check(v); msg != "" {
		errs.Add("query", "year", msg)
	} else {
		year, _ = strconv.Atoi(v) // 許可リストの文字列だけが来る
	}
	size := imaging.DefaultSize
	if v, ok := q.Get("size"); ok {
		n, msg := sizeRange.Check(v)
		if msg != "" {
			errs.Add("query", "size", msg)
		} else {
			size = int(n)
		}
	}
	if e := errs.Err(); e != nil {
		httpx.WriteError(w, e)
		return
	}

	run := h.requireRun(w, r)
	if run == nil {
		return
	}
	cand, err := h.d.Store.GetCandidate(r.Context(), run.RunID, id)
	if err != nil {
		h.fail(w, err)
		return
	}
	if cand == nil {
		httpx.WriteError(w, apierr.CandidateNotFound())
		return
	}

	png, err := h.renderer.Render(r.Context(), imaging.Request{
		Year: year, TileX: int(cand.TileX), TileY: int(cand.TileY),
		BBox:     [4]float64{float64(cand.BBox[0]), float64(cand.BBox[1]), float64(cand.BBox[2]), float64(cand.BBox[3])},
		Geometry: cand.Geometry,
		Class:    cand.Class,
		Size:     size,
	})
	if err != nil {
		h.imageFail(w, year, err)
		return
	}
	hd := w.Header()
	hd.Set("Content-Type", "image/png")
	hd.Set("Content-Length", strconv.Itoa(len(png)))
	hd.Set("Cache-Control", "private, max-age=60") // 利用者ごとの写真ではないが、共有のキャッシュには載せない
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(png)
}

// imageFail は、画像を作れなかったときの応答。写真を用意できなければ 404 tile_not_found（理由は固定の文。パスを含まない）、
// ほかは 500 / 503（fail）。
func (h *imageAPI) imageFail(w http.ResponseWriter, year int, err error) {
	var te *imaging.TileError
	switch {
	case errors.As(err, &te):
		httpx.WriteError(w, apierr.New(http.StatusNotFound, "tile_not_found", fmt.Sprintf("%d 年の写真を用意できません（%s）", year, te.Reason)))
	case errors.Is(err, imaging.ErrInvalid):
		// 候補の外接矩形・形が不正（DB の値の誤り）。値は出さず、種類だけ記録する
		h.logf("検出画像を作れません: %v", err)
		httpx.WriteError(w, apierr.Internal())
	default:
		h.fail(w, err) // 待っているあいだにクライアントが切った（context.Canceled）・想定外
	}
}
