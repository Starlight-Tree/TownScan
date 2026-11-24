// Package store は、DB（Postgres）の読み取りと、その結果の整形。backend/app/queries.py・db.py・provenance.py・explanations.py に相当する。
//
// SQL は、値を必ずパラメータ（$1…）で渡す。SQL の文字列に入るのは、このファイルの固定の断片だけ（並び順も許可リスト）。
// 数値・文字列は DB の値のまま返す（丸めない・型を変えない）。jsonb の列は、Python の API が返すのと同じ書き方（pyjson.Normalize）にして通す。
package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"townscan/api/internal/pyjson"
)

// 候補の分類（candidates.class の CHECK 制約と同じ 3 つ）
var ClassKeys = []string{"confirmed_new", "existing_omission", "uncertain"}

// Sort は、候補一覧の並び順。許可リストにある値だけ（利用者の値を SQL に入れない）。
type Sort string

const (
	SortAreaDesc Sort = "area_desc"
	SortAreaAsc  Sort = "area_asc"
)

var sortSQL = map[Sort]string{
	SortAreaDesc: "c.area_m2 DESC, c.id ASC",
	SortAreaAsc:  "c.area_m2 ASC, c.id ASC",
}

// 接続プールの大きさ・待ち時間は、backend/app/db.py の make_pool と同じ（最小 1・最大 4・接続を待つのは 10 秒まで）
const (
	poolMinConns   = 1
	poolMaxConns   = 4
	acquireTimeout = 10 * time.Second
	connectTimeout = 10 * time.Second
)

// Store は、DB への接続プールを持つ読み取りの窓口。
type Store struct {
	pool    *pgxpool.Pool
	acquire time.Duration
}

// Open は、接続プールを作る。接続はすぐには張らない（DB が起きていなくても返る。最初の問い合わせ・スキーマの適用で張る）。
// 接続文字列に誤りがあれば、エラー。エラーの文に接続文字列（パスワード）は入れない。
func Open(ctx context.Context, databaseURL string) (*Store, error) {
	cfg, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		// pgx の文には接続文字列の一部が入りうるので、使わない
		return nil, errors.New("DATABASE_URL の形が正しくありません（postgresql://ユーザー:パスワード@ホスト:5432/DB 名 の形で書いてください）")
	}
	cfg.MinConns = poolMinConns
	cfg.MaxConns = poolMaxConns
	if cfg.ConnConfig.ConnectTimeout == 0 { // 接続文字列に connect_timeout があれば、それを使う
		cfg.ConnConfig.ConnectTimeout = connectTimeout
	}
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, classify(err)
	}
	return &Store{pool: pool, acquire: acquireTimeout}, nil
}

// Close は、プールを閉じる。
func (s *Store) Close() { s.pool.Close() }

// conn は、プールから接続を 1 本取る（取れるまで待つのは acquireTimeout まで）。返した接続は、呼び出し側が Release する。
func (s *Store) conn(ctx context.Context) (*pgxpool.Conn, error) {
	actx, cancel := context.WithTimeout(ctx, s.acquire)
	defer cancel()
	c, err := s.pool.Acquire(actx)
	if err != nil {
		// 親の ctx（クライアントの切断）が取り消されたのは、DB の不調ではない
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, classify(err)
	}
	return c, nil
}

// ---- 型。JSON の名前・並びは、Python の API の応答と同じ ----

// Run は、データの 1 回の読み込み（pipeline の出力 1 回分）。
type Run struct {
	RunID     string
	Kind      string // "real" か "synthetic"
	CreatedAt time.Time
	Model     string // NULL は ""
}

// CreatedAtISO は、Python の datetime.isoformat()（UTC）と同じ書き方。マイクロ秒が 0 でなければ 6 桁で付ける。
func (r Run) CreatedAtISO() string {
	t := r.CreatedAt.UTC()
	s := t.Format("2006-01-02T15:04:05")
	if us := t.Nanosecond() / 1000; us != 0 {
		s += fmt.Sprintf(".%06d", us)
	}
	return s + "+00:00"
}

// Counts は、run の件数。
type Counts struct {
	Areas      int64 `json:"areas"`
	Candidates int64 `json:"candidates"`
	Buildings  int64 `json:"buildings"`
}

// AreaCounts は、地区ごとの候補数（分類別と合計）。
type AreaCounts struct {
	ConfirmedNew     int64 `json:"confirmed_new"`
	ExistingOmission int64 `json:"existing_omission"`
	Uncertain        int64 `json:"uncertain"`
	Total            int64 `json:"total"`
}

// Area は、地区（z18 のタイル 1 枚）。
type Area struct {
	ID           string          `json:"id"`
	Name         string          `json:"name"`
	Ward         string          `json:"ward"`
	Municipality *string         `json:"municipality"`
	BBox         [4]pyjson.Float `json:"bbox"`     // 西・南・東・北
	Centroid     [2]pyjson.Float `json:"centroid"` // 経度・緯度
	Counts       AreaCounts      `json:"counts"`
}

// Summary は、候補の一覧の 1 件。
type Summary struct {
	ID       string          `json:"id"`
	AreaID   string          `json:"area_id"`
	AreaName *string         `json:"area_name"`
	Ward     *string         `json:"ward"`
	Class    string          `json:"class"`
	AreaM2   pyjson.Float    `json:"area_m2"`
	BBox     [4]pyjson.Float `json:"bbox"`
	Centroid [2]pyjson.Float `json:"centroid"`
	Reason   string          `json:"reason"`
}

// Candidate は、詳細用。Summary に、根拠（evidence）・形（geometry）と、写真の切り出しに要る地区のタイル番号を足したもの。
type Candidate struct {
	Summary
	Evidence json.RawMessage
	Geometry json.RawMessage
	TileX    int32
	TileY    int32
}

// Feature は、地図用 GeoJSON の 1 件。
type Feature struct {
	Type       string          `json:"type"`
	ID         string          `json:"id"`
	Geometry   json.RawMessage `json:"geometry"`
	Properties FeatureProps    `json:"properties"`
}

// FeatureProps は、Feature の properties。
type FeatureProps struct {
	ID     string       `json:"id"`
	Class  string       `json:"class"`
	AreaM2 pyjson.Float `json:"area_m2"`
	AreaID string       `json:"area_id"`
}

// Filter は、候補の絞り込み。AreaIDs が nil なら地区で絞らない。Class が "" なら分類で絞らない。
type Filter struct {
	AreaIDs []string
	Class   string
}

// ---- 問い合わせ ----

// CurrentRun は、表示する現在の run = 最新の created_at（同時刻なら run_id の大きい方）。run が無ければ nil。
func (s *Store) CurrentRun(ctx context.Context) (*Run, error) {
	c, err := s.conn(ctx)
	if err != nil {
		return nil, err
	}
	defer c.Release()
	var r Run
	var model *string
	err = c.QueryRow(ctx, "SELECT run_id, kind, created_at, model FROM runs ORDER BY created_at DESC, run_id DESC LIMIT 1").
		Scan(&r.RunID, &r.Kind, &r.CreatedAt, &model)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, classify(err)
	}
	if model != nil {
		r.Model = *model
	}
	return &r, nil
}

// RunCounts は、run の地区・候補・建物の件数。
func (s *Store) RunCounts(ctx context.Context, runID string) (Counts, error) {
	c, err := s.conn(ctx)
	if err != nil {
		return Counts{}, err
	}
	defer c.Release()
	var n Counts
	err = c.QueryRow(ctx,
		"SELECT (SELECT count(*) FROM areas WHERE run_id = $1),"+
			" (SELECT count(*) FROM candidates WHERE run_id = $1),"+
			" (SELECT count(*) FROM buildings WHERE run_id = $1)", runID).
		Scan(&n.Areas, &n.Candidates, &n.Buildings)
	return n, classify(err)
}

// ListAreas は、run の地区を、タイルの行・列の順に返す（候補数つき）。
func (s *Store) ListAreas(ctx context.Context, runID string) ([]Area, error) {
	c, err := s.conn(ctx)
	if err != nil {
		return nil, err
	}
	defer c.Release()
	rows, err := c.Query(ctx,
		"SELECT a.id, a.name, a.ward, a.municipality, a.west, a.south, a.east, a.north,"+
			" a.centroid_lon, a.centroid_lat,"+
			" count(c.id) FILTER (WHERE c.class = 'confirmed_new'),"+
			" count(c.id) FILTER (WHERE c.class = 'existing_omission'),"+
			" count(c.id) FILTER (WHERE c.class = 'uncertain'),"+
			" count(c.id)"+
			" FROM areas a LEFT JOIN candidates c ON c.run_id = a.run_id AND c.area_id = a.id"+
			" WHERE a.run_id = $1 GROUP BY a.run_id, a.id ORDER BY a.y, a.x", runID)
	if err != nil {
		return nil, classify(err)
	}
	defer rows.Close()
	out := []Area{}
	for rows.Next() {
		var a Area
		var name, ward *string
		var w, so, e, n, clon, clat float64
		if err := rows.Scan(&a.ID, &name, &ward, &a.Municipality, &w, &so, &e, &n, &clon, &clat,
			&a.Counts.ConfirmedNew, &a.Counts.ExistingOmission, &a.Counts.Uncertain, &a.Counts.Total); err != nil {
			return nil, classify(err)
		}
		// 地区名の取得に失敗した地区でも、画面が文字列として扱えるように埋める（名前→id、区→空）
		a.Name = a.ID
		if name != nil && *name != "" {
			a.Name = *name
		}
		if ward != nil {
			a.Ward = *ward
		}
		a.BBox = [4]pyjson.Float{pyjson.Float(w), pyjson.Float(so), pyjson.Float(e), pyjson.Float(n)}
		a.Centroid = [2]pyjson.Float{pyjson.Float(clon), pyjson.Float(clat)}
		out = append(out, a)
	}
	return out, classify(rows.Err())
}

// filterSQL は、WHERE の断片と、その引数（$1 は run_id）。断片は固定で、値は引数で渡す。
func filterSQL(runID string, f Filter) (string, []any) {
	where := []string{"c.run_id = $1"}
	args := []any{runID}
	if f.AreaIDs != nil {
		args = append(args, f.AreaIDs)
		where = append(where, "c.area_id = ANY($"+strconv.Itoa(len(args))+")")
	}
	if f.Class != "" {
		args = append(args, f.Class)
		where = append(where, "c.class = $"+strconv.Itoa(len(args)))
	}
	return strings.Join(where, " AND "), args
}

const summaryColumns = "c.id, c.area_id, a.name, a.ward, c.class, c.area_m2," +
	" c.west, c.south, c.east, c.north, c.centroid_lon, c.centroid_lat, c.reason"

const fromCandidates = "FROM candidates c JOIN areas a ON a.run_id = c.run_id AND a.id = c.area_id"

// summaryDest は、summaryColumns の順に Scan する先。
type summaryDest struct {
	s                              Summary
	area                           float64
	west, south, east, north, x, y float64
}

func (d *summaryDest) targets() []any {
	return []any{&d.s.ID, &d.s.AreaID, &d.s.AreaName, &d.s.Ward, &d.s.Class, &d.area,
		&d.west, &d.south, &d.east, &d.north, &d.x, &d.y, &d.s.Reason}
}

func (d *summaryDest) summary() Summary {
	s := d.s
	s.AreaM2 = pyjson.Float(d.area)
	s.BBox = [4]pyjson.Float{pyjson.Float(d.west), pyjson.Float(d.south), pyjson.Float(d.east), pyjson.Float(d.north)}
	s.Centroid = [2]pyjson.Float{pyjson.Float(d.x), pyjson.Float(d.y)}
	return s
}

// ListCandidates は、候補を（絞り込み・並び順・ページ分けのうえで）返す。total はページ分けの前の件数。
func (s *Store) ListCandidates(ctx context.Context, runID string, f Filter, sort Sort, limit, offset int) (int64, []Summary, error) {
	order, ok := sortSQL[sort]
	if !ok {
		return 0, nil, fmt.Errorf("store: 未知の並び順 %q", sort) // 呼び出し側で検証済みのはず
	}
	c, err := s.conn(ctx)
	if err != nil {
		return 0, nil, err
	}
	defer c.Release()
	where, args := filterSQL(runID, f)
	var total int64
	if err := c.QueryRow(ctx, "SELECT count(*) FROM candidates c WHERE "+where, args...).Scan(&total); err != nil {
		return 0, nil, classify(err)
	}
	args = append(args, limit, offset)
	n := len(args)
	rows, err := c.Query(ctx,
		"SELECT "+summaryColumns+" "+fromCandidates+" WHERE "+where+" ORDER BY "+order+
			" LIMIT $"+strconv.Itoa(n-1)+" OFFSET $"+strconv.Itoa(n), args...)
	if err != nil {
		return 0, nil, classify(err)
	}
	defer rows.Close()
	items := []Summary{}
	for rows.Next() {
		var d summaryDest
		if err := rows.Scan(d.targets()...); err != nil {
			return 0, nil, classify(err)
		}
		items = append(items, d.summary())
	}
	if err := rows.Err(); err != nil {
		return 0, nil, classify(err)
	}
	return total, items, nil
}

// CandidateFeatures は、地図用の候補（面積の大きい順）。
func (s *Store) CandidateFeatures(ctx context.Context, runID string, f Filter) ([]Feature, error) {
	c, err := s.conn(ctx)
	if err != nil {
		return nil, err
	}
	defer c.Release()
	where, args := filterSQL(runID, f)
	rows, err := c.Query(ctx,
		"SELECT c.id, c.area_id, c.class, c.area_m2, c.geom FROM candidates c WHERE "+where+" ORDER BY c.area_m2 DESC, c.id ASC", args...)
	if err != nil {
		return nil, classify(err)
	}
	defer rows.Close()
	out := []Feature{}
	for rows.Next() {
		var id, areaID, class string
		var area float64
		var geom json.RawMessage
		if err := rows.Scan(&id, &areaID, &class, &area, &geom); err != nil {
			return nil, classify(err)
		}
		g, err := pyjson.Normalize(geom)
		if err != nil {
			return nil, err
		}
		out = append(out, Feature{
			Type: "Feature", ID: id, Geometry: g,
			Properties: FeatureProps{ID: id, Class: class, AreaM2: pyjson.Float(area), AreaID: areaID},
		})
	}
	return out, classify(rows.Err())
}

// GetCandidate は、候補 1 件（詳細用）。無ければ nil。
func (s *Store) GetCandidate(ctx context.Context, runID, candidateID string) (*Candidate, error) {
	c, err := s.conn(ctx)
	if err != nil {
		return nil, err
	}
	defer c.Release()
	var d summaryDest
	var evidence, geom json.RawMessage
	var tileX, tileY int32
	err = c.QueryRow(ctx,
		"SELECT "+summaryColumns+", c.evidence, c.geom, a.x, a.y "+fromCandidates+" WHERE c.run_id = $1 AND c.id = $2",
		runID, candidateID).Scan(append(d.targets(), &evidence, &geom, &tileX, &tileY)...)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, classify(err)
	}
	ev, err := pyjson.Normalize(evidence)
	if err != nil {
		return nil, err
	}
	g, err := pyjson.Normalize(geom)
	if err != nil {
		return nil, err
	}
	return &Candidate{Summary: d.summary(), Evidence: ev, Geometry: g, TileX: tileX, TileY: tileY}, nil
}

// GetMetrics は、評価の結果（eval.json の内容）。無ければ nil。
func (s *Store) GetMetrics(ctx context.Context, runID string) (json.RawMessage, error) {
	c, err := s.conn(ctx)
	if err != nil {
		return nil, err
	}
	defer c.Release()
	var body json.RawMessage
	err = c.QueryRow(ctx, "SELECT body FROM metrics WHERE run_id = $1", runID).Scan(&body)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, classify(err)
	}
	return pyjson.Normalize(body)
}
