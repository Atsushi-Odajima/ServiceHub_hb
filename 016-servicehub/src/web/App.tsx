import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router';
import { AppLayout, AuthGate } from './components/Layout';
import { RequirePerm } from './components/RequirePerm';
import type { Permission } from '../shared/permissions';
import { Spinner } from './components/ui';
import { AcceptInvitePage, ForgotPasswordPage, LoginPage, ResetPasswordPage, SelectOrgPage } from './pages/auth/AuthPages';
import { DashboardPage } from './pages/DashboardPage';
import { AccountPage, OrgSettingsPage, SettingsHome } from './pages/settings/OrgAndAccount';
import { LocationEditPage, LocationsPage } from './pages/settings/LocationsPages';
import { MembersPage } from './pages/settings/MembersPage';
import { ResourcesPage, ServiceEditPage, ServicesPage, StaffPage } from './pages/settings/CatalogPages';
import { ShiftsPage } from './pages/ShiftsPage';
import { ManageBookingPage, PublicBookingPage, PublicOrgPage, PublicWaitlistPage } from './pages/public/PublicPages';
import { CustomerDetailPage, CustomersPage } from './pages/customers/CustomerPages';
import { BookingDetailPage, BookingsPage } from './pages/bookings/BookingPages';
import { NotificationsPage } from './pages/NotificationsPage';
import { CompletionPage } from './pages/operations/CompletionPage';
import { NextBookingPage } from './pages/operations/NextBookingPage';
import { ReceptionPage } from './pages/operations/ReceptionPage';
import { SchedulePage } from './pages/operations/SchedulePage';
import { WaitlistPage } from './pages/operations/WaitlistPage';
import { AnnouncementPage } from './pages/operations/AnnouncementPage';
import { AuditPage } from './pages/analytics/AuditPage';
import { CsvPage } from './pages/analytics/CsvPage';
import { KpiPage } from './pages/analytics/KpiPage';
import { SearchPage } from './pages/analytics/SearchPage';
import { PassDetailPage, PassesPage, PlanDetailPage, PlansPage } from './pages/entitlements/EntitlementPages';
import { PassProductsPage, PlanProductsPage } from './pages/settings/ProductPages';
import { BackupPage } from './pages/settings/BackupPage';

const NotFound = () => (
  <div className="content">
    <h1>ページが見つかりません</h1>
    <a href="/app">トップへ</a>
  </div>
);

export function App() {
  return (
    <Suspense fallback={<Spinner />}>
      <Routes>
        <Route path="/" element={<Navigate to="/app" replace />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/select-org" element={<SelectOrgPage />} />
        <Route path="/invite/:token" element={<AcceptInvitePage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route path="/p/:org" element={<PublicOrgPage />} />
        <Route path="/p/:org/:loc" element={<PublicBookingPage />} />
        <Route path="/p/:org/:loc/waitlist" element={<PublicWaitlistPage />} />
        <Route path="/b/:token" element={<ManageBookingPage />} />
        {/* 受付モードは全画面(サイドバーなし) */}
        <Route
          path="/app/reception"
          element={
            <AuthGate>
              <RequirePerm any={['reception.operate']} bare>
                <ReceptionPage />
              </RequirePerm>
            </AuthGate>
          }
        />
        <Route
          path="/app"
          element={
            <AuthGate>
              <AppLayout />
            </AuthGate>
          }
        >
          <Route index element={<DashboardPage />} />
          <Route path="account" element={<AccountPage />} />
          <Route path="settings" element={<RequirePerm any={['org.manage','location.manage','location.schedule.manage','service.manage','staff.manage','resource.manage','member.manage','pass.product.manage','plan.product.manage','backup.manage'] as Permission[]}><SettingsHome /></RequirePerm>} />
          <Route path="settings/org" element={<RequirePerm any={['org.manage'] as Permission[]}><OrgSettingsPage /></RequirePerm>} />
          <Route path="settings/locations" element={<RequirePerm any={['location.manage','location.schedule.manage'] as Permission[]}><LocationsPage /></RequirePerm>} />
          <Route path="settings/locations/:id" element={<RequirePerm any={['location.manage','location.schedule.manage'] as Permission[]}><LocationEditPage /></RequirePerm>} />
          <Route path="settings/members" element={<RequirePerm any={['member.manage'] as Permission[]}><MembersPage /></RequirePerm>} />
          <Route path="settings/services" element={<RequirePerm any={['service.manage'] as Permission[]}><ServicesPage /></RequirePerm>} />
          <Route path="settings/services/:id" element={<RequirePerm any={['service.manage'] as Permission[]}><ServiceEditPage /></RequirePerm>} />
          <Route path="settings/staff" element={<RequirePerm any={['staff.manage'] as Permission[]}><StaffPage /></RequirePerm>} />
          <Route path="settings/resources" element={<RequirePerm any={['resource.manage'] as Permission[]}><ResourcesPage /></RequirePerm>} />
          <Route path="settings/pass-products" element={<RequirePerm any={['pass.product.manage'] as Permission[]}><PassProductsPage /></RequirePerm>} />
          <Route path="settings/plan-products" element={<RequirePerm any={['plan.product.manage'] as Permission[]}><PlanProductsPage /></RequirePerm>} />
          <Route path="settings/backup" element={<RequirePerm any={['backup.manage'] as Permission[]}><BackupPage /></RequirePerm>} />
          <Route path="schedule" element={<RequirePerm any={['booking.read.all','booking.read.own'] as Permission[]}><SchedulePage /></RequirePerm>} />
          <Route path="announcement" element={<RequirePerm any={['booking.create.all'] as Permission[]}><AnnouncementPage /></RequirePerm>} />
          <Route path="waitlist" element={<RequirePerm any={['waitlist.read'] as Permission[]}><WaitlistPage /></RequirePerm>} />
          <Route path="kpi" element={<RequirePerm any={['kpi.read'] as Permission[]}><KpiPage /></RequirePerm>} />
          <Route path="search" element={<SearchPage />} />
          <Route path="csv" element={<RequirePerm any={['csv.export.customers','csv.export.bookings','csv.export.master','csv.export.ledger','csv.import'] as Permission[]}><CsvPage /></RequirePerm>} />
          <Route path="audit" element={<RequirePerm any={['audit.read'] as Permission[]}><AuditPage /></RequirePerm>} />
          <Route path="shifts" element={<RequirePerm any={['shift.manage','shift.read.all','shift.read.own'] as Permission[]}><ShiftsPage /></RequirePerm>} />
          <Route path="customers" element={<RequirePerm any={['customer.read'] as Permission[]}><CustomersPage /></RequirePerm>} />
          <Route path="customers/:id" element={<RequirePerm any={['customer.read'] as Permission[]}><CustomerDetailPage /></RequirePerm>} />
          <Route path="bookings" element={<RequirePerm any={['booking.read.all','booking.read.own'] as Permission[]}><BookingsPage /></RequirePerm>} />
          <Route path="bookings/:id" element={<RequirePerm any={['booking.read.all','booking.read.own'] as Permission[]}><BookingDetailPage /></RequirePerm>} />
          <Route path="bookings/:id/complete" element={<RequirePerm any={['booking.status.all','booking.status.own','record.read'] as Permission[]}><CompletionPage /></RequirePerm>} />
          <Route path="bookings/:id/consume" element={<RequirePerm any={['booking.status.all','booking.status.own','record.read'] as Permission[]}><CompletionPage /></RequirePerm>} />
          <Route path="bookings/:id/next" element={<RequirePerm any={['booking.create.all','booking.create.own'] as Permission[]}><NextBookingPage /></RequirePerm>} />
          <Route path="passes" element={<RequirePerm any={['pass.read'] as Permission[]}><PassesPage /></RequirePerm>} />
          <Route path="passes/:id" element={<RequirePerm any={['pass.read'] as Permission[]}><PassDetailPage /></RequirePerm>} />
          <Route path="plans" element={<RequirePerm any={['plan.read'] as Permission[]}><PlansPage /></RequirePerm>} />
          <Route path="plans/:id" element={<RequirePerm any={['plan.read'] as Permission[]}><PlanDetailPage /></RequirePerm>} />
          <Route path="notifications" element={<RequirePerm any={['notification.read'] as Permission[]}><NotificationsPage /></RequirePerm>} />
          <Route path="*" element={<NotFound />} />
        </Route>
        <Route path="*" element={<NotFound />} />
      </Routes>
    </Suspense>
  );
}

export { lazy };
