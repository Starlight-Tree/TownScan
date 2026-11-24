// @vitest-environment node
// api-types（契約）とスタブ API（dev/mock-api.mjs）が食い違っていないことを、実際に起動して確かめる。
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMockApi } from '../dev/mock-api.mjs';
import {
  checkAreaList,
  checkCandidateDetail,
  checkCandidateList,
  checkChatResponse,
  checkErrorBody,
  checkFeatureCollection,
  checkHealth,
  checkMetrics,
  checkToolResult,
} from './api-guards';
import { TOOL_RESULT_TYPES, type CandidateFeatureCollection, type CandidateList, type ChatResponse } from './api-types';

let server: Server;
let base = '';
let realServer: Server;
let realBase = '';

function listen(s: Server): Promise<string> {
  return new Promise((resolve) => {
    s.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(s.address() as AddressInfo).port}`));
  });
}

async function get(path: string, from = base) {
  const res = await fetch(`${from}${path}`);
  return { res, body: (await res.json()) as unknown };
}

async function chat(content: string): Promise<ChatResponse> {
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content }] }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as ChatResponse;
}

beforeAll(async () => {
  server = createMockApi();
  realServer = createMockApi({ runKind: 'real' });
  base = await listen(server);
  realBase = await listen(realServer);
});

afterAll(async () => {
  await Promise.all([server, realServer].map((s) => new Promise((resolve) => s.close(resolve))));
});

describe('スタブ API は契約どおり', () => {
  it('health: synthetic が既定で、real も選べる', async () => {
    const synthetic = await get('/api/health');
    expect(checkHealth(synthetic.body)).toEqual([]);
    expect((synthetic.body as { run: { kind: string } }).run.kind).toBe('synthetic');
    expect((synthetic.body as { llm: string }).llm).toBe('mock');
    const real = await get('/api/health', realBase);
    expect((real.body as { run: { kind: string } }).run.kind).toBe('real');
  });

  it('areas: 12 地区、件数の合計が候補数と一致する', async () => {
    const { body } = await get('/api/areas');
    expect(checkAreaList(body)).toEqual([]);
    expect(Array.isArray(body) && body.length).toBe(12);
    const total = (body as Array<{ counts: { total: number } }>).reduce((n, a) => n + a.counts.total, 0);
    const health = (await get('/api/health')).body as { counts: { candidates: number } };
    expect(total).toBe(health.counts.candidates);
  });

  it('candidates・geojson・詳細・画像・エラー', async () => {
    const list = await get('/api/candidates?sort=area_desc&limit=3');
    expect(checkCandidateList(list.body)).toEqual([]);
    const { items, total } = list.body as CandidateList;
    expect(items).toHaveLength(3);
    expect(items[0]!.area_m2).toBeGreaterThanOrEqual(items[1]!.area_m2);

    const geo = await get('/api/candidates.geojson');
    expect(checkFeatureCollection(geo.body)).toEqual([]);
    expect((geo.body as CandidateFeatureCollection).features).toHaveLength(total);

    const first = items[0]!;
    const detail = await get(`/api/candidates/${first.id}`);
    expect(detail.res.status).toBe(200);
    expect(checkCandidateDetail(detail.body)).toEqual([]);

    for (const year of [2018, 2023]) {
      const img = await fetch(`${base}/api/candidates/${first.id}/image?year=${year}&size=128`);
      expect(img.status).toBe(200);
      expect(img.headers.get('content-type')).toBe('image/png');
      const buf = Buffer.from(await img.arrayBuffer());
      expect(buf.subarray(1, 4).toString('ascii')).toBe('PNG');
    }

    const missing = await get('/api/candidates/c-0-0-0');
    expect(missing.res.status).toBe(404);
    expect(checkErrorBody(missing.body)).toEqual([]);
    const badYear = await get(`/api/candidates/${first.id}/image?year=1999`);
    expect(badYear.res.status).toBe(422);
    const badCls = await get('/api/candidates?cls=nope');
    expect(badCls.res.status).toBe(422);
  });

  it('metrics: 新築の再現率は null（未測定）', async () => {
    const { body } = await get('/api/metrics');
    expect(checkMetrics(body)).toEqual([]);
    expect((body as { new_building_recall: unknown }).new_building_recall).toBeNull();
  });

  it('chat: 7 種類の結果がすべて契約どおりに出る', async () => {
    const prompts = [
      '新規出現の候補は何件ありますか？',
      '地区ごとの候補数を比べて',
      '面積の大きい候補を一覧にして',
      'いちばん大きい候補の写真を見せて',
      '新規出現の候補を地図で見せて',
      'このアプリの精度は？',
      '渋谷の新築は？',
      '2025 年に建った建物は？',
      '衛星で変化の当たりを出して',
      '存在しない地区のデータ',
    ];
    const seen = new Set<string>();
    const reasons = new Set<string>();
    for (const p of prompts) {
      const res = await chat(p);
      expect(checkChatResponse(res), p).toEqual([]);
      for (const r of res.message.results) {
        seen.add(r.type);
        if (r.type === 'refusal') reasons.add(r.reason);
      }
    }
    expect([...seen].sort()).toEqual([...TOOL_RESULT_TYPES].sort());
    expect([...reasons].sort()).toEqual(['no_data', 'no_photo_period', 'not_implemented', 'out_of_scope']);
  });

  it('chat: 数字は結果に含まれる値だけ（返答文に出る数字は results にある）', async () => {
    for (const p of ['新規出現の候補は何件ありますか？', '面積の大きい候補を一覧にして', 'テスト地区 03 の件数は？']) {
      const { message } = await chat(p);
      const known = JSON.stringify(message.results);
      for (const n of message.content.match(/\d+(?:\.\d+)?/g) ?? []) {
        expect(known, `${p}: 「${n}」`).toContain(n);
      }
    }
  });

  it('chat: 不正な本文は 422、わざとのエラーは 500 とエラー本文', async () => {
    const bad = await fetch(`${base}/api/chat`, { method: 'POST', body: '{' });
    expect(bad.status).toBe(422);
    expect(checkErrorBody(await bad.json())).toEqual([]);
    const boom = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'エラーを起こして' }] }),
    });
    expect(boom.status).toBe(500);
    expect(checkErrorBody(await boom.json())).toEqual([]);
  });
});

describe('検査（api-guards）自体が食い違いを見つける', () => {
  it('未知の type・欠けた項目・型違いを指摘する', () => {
    expect(checkToolResult({ type: 'heatmap' })).toHaveLength(1);
    expect(checkToolResult({ type: 'refusal', reason: 'because', message: 1, suggestions: 'x' })).not.toHaveLength(0);
    expect(checkToolResult({ type: 'count', title: 'x', total: '3', breakdown: [], filter: {} })).not.toHaveLength(0);
    expect(checkHealth({ status: 'ok' })).not.toHaveLength(0);
    expect(checkCandidateList({ total: 1, items: [{ id: 'c-1-1-1', class: 'sure_new' }] })).not.toHaveLength(0);
    expect(checkMetrics({})).toContain('metrics.new_building_recall: ありません（手ラベルが無いうちは null）');
  });
});
