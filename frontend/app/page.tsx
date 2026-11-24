import type { Metadata } from 'next';
import { HomeClient } from '../components/HomeClient';

export const metadata: Metadata = { title: { absolute: 'チャットと地図 | TownScan' } };

export default function HomePage() {
  return <HomeClient />;
}
