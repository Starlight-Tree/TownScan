# TownScan

[![CI](https://github.com/Starlight-Tree/TownScan/actions/workflows/ci.yml/badge.svg)](https://github.com/Starlight-Tree/TownScan/actions/workflows/ci.yml)

English | [日本語](README.ja.md)

TownScan is a chat app that finds candidates for new buildings in central Kumamoto City from aerial photos of two years (2018 and 2023) and answers questions about them with counts, a map and the detected images (FastAPI, Next.js, Postgres 17, Docker Compose, a building-extraction model run on Google Colab).
It is a local prototype: not deployed, and the answers come from a mock model (fixed replies) that calls the tools. The accuracy shown in the app is measured, and it is low (see "Features").

## Features

- **Chat that cites its tools.** Counts, areas and coordinates come only from tool results (candidate lists, per-area counts, maps, image crops), never from the model's own text. Questions outside the data are declined. The model is a mock by default; a real LLM is not wired in yet.
- **Three classes of "new building" candidates, from a difference.** A 2023 building outline that is not in the 2018 building data is checked against the 2018 photo: `confirmed_new` (nothing there in 2018), `existing_omission` (already in the 2018 photo, so the building data missed it) or `uncertain`. The difference is the entry point; the photo decides. The UI calls them "appeared (not in the old photo)", "existing, missing from the data" and "undecided", and tells them apart by colour, line style and shape.
- **Map and side-by-side photos.** Candidates are drawn on Geospatial Information Authority of Japan (GSI) tiles (standard map, 2018 photo, 2023 photo). A drawer shows the 2018 and 2023 crops of one building with its evidence numbers.
- **An accuracy page that shows its limits.** Building extraction is measured against the 2018 building data with pixel IoU and object-level F1, with the tuning tiles and the held-out tiles reported separately (held-out object F1 is about 0.16 for the chosen setting, and the threshold is an untuned initial value). In the current run, about a third of the existing buildings checked (66 of 200) are invisible to the 2018 extraction, which pushes existing buildings into "appeared". Recall for new buildings is "not measured" because there are no hand labels yet.
- **Synthetic data is never mistaken for real data.** Every run records its kind (`real` or `synthetic`), and the UI shows a banner for synthetic test data.

## Architecture

```mermaid
flowchart LR
    B[Browser] --> W["Next.js<br/>web (:3500)"]
    W -->|"/api/* forwarded"| A["FastAPI<br/>api (:8500)"]
    A --> DB[("Postgres 17")]
    A -.->|"read-only: photo tiles"| D[("data/townscan")]
    B -->|"map tiles"| G["GSI tile server"]
```

The data comes from an offline pipeline, run on demand:

```mermaid
flowchart LR
    P["GSI photos<br/>2018 / 2023"] --> C["Google Colab (T4)<br/>building extraction"]
    C --> PP["pipeline/<br/>vectorize, diff against the<br/>2018 building data, 3 classes, evaluation"]
    K[("Fundamental Geospatial Data<br/>building outlines 2018-10")] --> PP
    PP --> O["out/<br/>run.json, candidates.geojson, eval.json"]
    O -->|"python -m app.load"| DB[("Postgres 17")]
```

The browser only calls the same-origin `/api/*`; the web container forwards it to the API (`API_URL`, read at run time). The ports are published on `127.0.0.1` only and the DB is not published. The data contract between the pipeline and the API is in [docs/spec-prototype.md](docs/spec-prototype.md).

## Quick start

Run these on the host (Docker and Node 24 are needed).

```bash
scripts/dev-up.sh    # creates .env on the first run (random DB password), builds the frontend, starts db / api / web
```

- UI: <http://127.0.0.1:3500>, API docs: <http://127.0.0.1:8500/api/docs>
- The script is safe to run again. It loads a real run into the DB when `data/townscan/run1/out/run.json` exists, and skips the loading when it does not. `data/` is not in Git (the photos and building data are not redistributed), so a fresh clone starts without candidates. The files a run must contain are listed in [docs/spec-prototype.md](docs/spec-prototype.md) §4.1; `python -m pipeline.run_postprocess` builds them from the Colab output.
- Stop: `docker compose down`. To delete the DB as well: `docker compose down -v`.

Checks: `scripts/verify.sh [repo|pipeline|backend|frontend|all]`. `backend` runs `pytest` against a throwaway Postgres (Docker is needed), and the heavy frontend steps (`npm ci`, type check, tests, `next build`) run on the host's Node 24 because the Docker VM has little free memory.

## Documentation

The documents are written in Japanese.

| Document | Contents |
|---|---|
| [docs/plan.md](docs/plan.md) | Plan, stages, exit criteria and the decisions still pending |
| [docs/spec-prototype.md](docs/spec-prototype.md) | The prototype's contract: data files, DB, API, the three classes, evaluation, UI, exit criteria |
| [docs/decisions/](docs/decisions/) | Decisions and their reasons: data candidates and terms of use (0001), direction (0002) |
| [frontend/README.md](frontend/README.md) | Frontend: running it, checks |
| [backend/README.md](backend/README.md) | Backend: running it, tests, the API |
| [CLAUDE.md](CLAUDE.md) | Development conventions (for AI agents) |

## About this repository

A personal project published as a portfolio, built to explore: image recognition whose evaluation is honest about its limits, a chat that cannot write numbers by itself, and a map UI for checking detections against photos. It contains no secrets (`.env` is outside Git; only `.env.example` is committed). Pattern-based secret checks are not a complete guarantee.

Data: the photos are GSI tiles (the source is shown in the app), the reference buildings are GSI Fundamental Geospatial Data, and the model is `giswqs/whu-building-unetplusplus-efficientnet-b4` (Apache-2.0; the terms of its training data, WHU, are unverified). None of them is redistributed here. Details are in [docs/decisions/0001-data-candidates.md](docs/decisions/0001-data-candidates.md).

## License

[MIT](LICENSE) (the code in this repository; the data and the model above keep their own terms)
