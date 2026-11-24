import type { Metadata } from 'next';
import { AccuracyView } from '../../components/AccuracyView';

export const metadata: Metadata = { title: 'このアプリの精度' };

export default function AccuracyPage() {
  return <AccuracyView />;
}
