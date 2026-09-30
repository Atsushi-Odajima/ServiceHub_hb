import { useMe } from '../api/hooks';
import { PageHeader } from '../components/ui';

export function DashboardPage() {
  const me = useMe();
  return <PageHeader title="ダッシュボード" sub={me.data?.organization?.name} />;
}
