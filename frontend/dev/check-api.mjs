// 動いている API（スタブでも実 API でも）が、契約（lib/api-types.ts・仕様 §4.4・§4.5）に合っているかを調べる。
//
//   node dev/check-api.mjs [ベース URL]      # 既定: $API_URL か http://127.0.0.1:8599（スタブ）
//   node dev/check-api.mjs http://127.0.0.1:8500   # backend
//   node dev/check-api.mjs http://127.0.0.1:3500   # web 経由（プロキシも一緒に確かめられる）
//
// 読み取りだけ（POST /api/chat は質問を送るだけ）。Node 24 の型除去で lib/api-guards.ts を直接読む。
import {
  checkAreaList,
  checkCandidateDetail,
  checkCandidateList,
  checkChatResponse,
  checkErrorBody,
  checkFeatureCollection,
  checkHealth,
  checkMetrics,
} from '../lib/api-guards.ts';
import { TOOL_RESULT_TYPES } from '../lib/api-types.ts';

const base = (process.argv[2] ?? process.env.API_URL ?? 'http://127.0.0.1:8599').replace(/\/$/, '');
const PROMPTS = [
  '新規出現の候補は何件ありますか？',
  '地区ごとの候補数を比べて',
  '面積の大きい候補を一覧にして',
  'いちばん大きい候補の写真を見せて',
  '新規出現の候補を地図で見せて',
  'このアプリの精度は？',
  '渋谷の新築は？',
  '2025 年に建った建物は？',
  '衛星で変化の当たりを出して',
];

let failed = 0;
const seen = new Set();

function report(name, problems, extra = '') {
  if (problems.length === 0) {
    console.log(`合格   ${name}${extra ? `  ${extra}` : ''}`);
  } else {
    failed += 1;
    console.log(`失敗   ${name}`);
    for (const p of problems.slice(0, 8)) console.log(`         - ${p}`);
    if (problems.length > 8) console.log(`         ... ほか ${problems.length - 8} 件`);
  }
}

async function getJson(path, init) {
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  return { res, body, text };
}

async function step(name, fn) {
  try {
    await fn();
  } catch (e) {
    failed += 1;
    console.log(`失敗   ${name}（${e instanceof Error ? e.message : e}）`);
  }
}

console.log(`対象: ${base}`);

await step('GET /api/health', async () => {
  const { res, body } = await getJson('/api/health');
  report('GET /api/health', res.status === 200 ? checkHealth(body) : [`HTTP ${res.status}`], body?.run ? `run.kind=${body.run.kind} llm=${body.llm}` : '');
});

let areas = [];
await step('GET /api/areas', async () => {
  const { res, body } = await getJson('/api/areas');
  areas = Array.isArray(body) ? body : (body?.items ?? []);
  report('GET /api/areas', res.status === 200 ? checkAreaList(body) : [`HTTP ${res.status}`], `${areas.length} 地区`);
});

let first;
await step('GET /api/candidates', async () => {
  const { res, body } = await getJson('/api/candidates?sort=area_desc&limit=5');
  first = body?.items?.[0];
  report('GET /api/candidates', res.status === 200 ? checkCandidateList(body) : [`HTTP ${res.status}`], `total=${body?.total}`);
});

await step('GET /api/candidates.geojson', async () => {
  const { res, body } = await getJson('/api/candidates.geojson');
  report('GET /api/candidates.geojson', res.status === 200 ? checkFeatureCollection(body) : [`HTTP ${res.status}`], `${body?.features?.length ?? 0} 件`);
});

if (first) {
  await step('GET /api/candidates/{id}', async () => {
    const { res, body } = await getJson(`/api/candidates/${encodeURIComponent(first.id)}`);
    report(`GET /api/candidates/${first.id}`, res.status === 200 ? checkCandidateDetail(body) : [`HTTP ${res.status}`]);
  });
  for (const year of [2018, 2023]) {
    await step(`image ${year}`, async () => {
      const res = await fetch(`${base}/api/candidates/${encodeURIComponent(first.id)}/image?year=${year}&size=512`);
      const buf = Buffer.from(await res.arrayBuffer());
      const problems = [];
      if (res.status !== 200) problems.push(`HTTP ${res.status}`);
      if (!String(res.headers.get('content-type')).startsWith('image/png')) problems.push(`content-type: ${res.headers.get('content-type')}`);
      if (buf.subarray(1, 4).toString('ascii') !== 'PNG') problems.push('PNG の署名がありません');
      report(`GET /api/candidates/${first.id}/image?year=${year}`, problems, `${buf.length} バイト`);
    });
  }
}

await step('404', async () => {
  const { res, body } = await getJson('/api/candidates/c-0-0-0');
  report('存在しない id は 404 とエラー本文', res.status === 404 ? checkErrorBody(body) : [`HTTP ${res.status}（404 のはず）`]);
});

await step('422', async () => {
  if (!first) return;
  const { res, body } = await getJson(`/api/candidates/${encodeURIComponent(first.id)}/image?year=1999`);
  report('不正な year は 422 とエラー本文', res.status === 422 ? checkErrorBody(body) : [`HTTP ${res.status}（422 のはず）`]);
});

await step('GET /api/metrics', async () => {
  const { res, body } = await getJson('/api/metrics');
  report('GET /api/metrics', res.status === 200 ? checkMetrics(body) : [`HTTP ${res.status}`], `new_building_recall=${JSON.stringify(body?.new_building_recall)}`);
});

for (const prompt of PROMPTS) {
  await step(`chat: ${prompt}`, async () => {
    const { res, body } = await getJson('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: prompt }] }),
    });
    const problems = res.status === 200 ? checkChatResponse(body) : [`HTTP ${res.status}`];
    const types = (body?.message?.results ?? []).map((r) => r?.type);
    for (const t of types) seen.add(t);
    report(`POST /api/chat 「${prompt}」`, problems, `type=${types.join(',') || '-'}`);
  });
}

const missing = TOOL_RESULT_TYPES.filter((t) => !seen.has(t));
console.log(`\n結果カードの型 ${seen.size}/${TOOL_RESULT_TYPES.length} を確認${missing.length ? `（出なかった型: ${missing.join('・')}。質問の文言を変えると出るかもしれません）` : ''}`);
console.log(failed === 0 ? '全部合格' : `${failed} 件が失敗`);
process.exit(failed === 0 ? 0 : 1);
