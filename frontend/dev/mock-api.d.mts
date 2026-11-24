import type { Server } from 'node:http';
import type { ChatRequestMessage, ChatResponse, CandidateClass } from '../lib/api-types';

export interface MockCandidate {
  id: string;
  area_id: string;
  class: CandidateClass;
  area_m2: number;
  bbox: [number, number, number, number];
  centroid: [number, number];
  evidence: Record<string, number | boolean>;
  reason: string;
}

export interface MockDataset {
  runKind: 'real' | 'synthetic';
  run: { run_id: string; kind: 'real' | 'synthetic'; created_at: string };
  areas: Array<{ id: string; name: string; counts: Record<string, number> }>;
  candidates: MockCandidate[];
}

export function buildDataset(options?: { runKind?: 'real' | 'synthetic' }): MockDataset;
export function answerChat(data: MockDataset, messages: ChatRequestMessage[]): ChatResponse;
export function renderCandidateImage(candidate: MockCandidate, year: number, size: number): Buffer;
export function createMockApi(options?: { runKind?: 'real' | 'synthetic' }): Server;
