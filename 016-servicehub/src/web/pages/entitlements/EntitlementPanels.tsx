import { EmptyState } from '../../components/ui';

/** 顧客詳細の回数券・利用プラン(Phase 5-6 で実装) */
export function CustomerEntitlements({ customerId: _c, customerActive: _a }: { customerId: string; customerActive: boolean }) {
  return <EmptyState title="回数券・利用プランはまだありません" />;
}
