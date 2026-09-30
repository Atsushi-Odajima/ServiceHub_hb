import { useRef } from 'react';
import { useNavigate, useParams } from 'react-router';
import { addDays, todayIn } from '../../../shared/time';
import { useApi } from '../../api/hooks';
import { useToast } from '../../components/Toast';
import { ErrorMessage, PageHeader, Spinner } from '../../components/ui';
import { fmtDateTime, localDateOf } from '../../lib/format';
import type { BookingDto } from '../bookings/BookingPages';
import { BookingFormModal } from '../bookings/BookingForm';

/** 完了した予約から次回予約を作る(同じ顧客・サービス・担当を初期値に。実施記録に紐付く) */
export function NextBookingPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const created = useRef(false);
  const q = useApi<{ booking: BookingDto; record: { nextRecommendedOn: string | null } | null }>(['booking', id, 'completion'], `/api/v1/bookings/${id}/completion`);
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorMessage error={q.error} />;
  const b = q.data!.booking;
  const tz = b.timezone;
  const today = todayIn(tz);
  const suggested = q.data!.record?.nextRecommendedOn ?? addDays(localDateOf(b.startsAt, tz), 7);
  const date = suggested < today ? today : suggested;
  return (
    <>
      <PageHeader title="次回予約" sub={`${b.customerName} 様 ・ 前回 ${fmtDateTime(b.startsAt, tz)} ${b.serviceName}`} />
      <BookingFormModal
        initial={{
          title: '次回予約を作成',
          locationId: b.locationId,
          serviceId: b.serviceId,
          staffId: b.staffId,
          date,
          customer: { id: b.customerId, name: b.customerName },
          previousBookingId: b.id,
        }}
        onClose={() => {
          if (!created.current) navigate(`/app/bookings/${b.id}`);
        }}
        onCreated={(nb) => {
          created.current = true;
          toast.push({ tone: 'success', message: '次回予約を作成しました' });
          navigate(`/app/bookings/${nb.id}`);
        }}
      />
    </>
  );
}
