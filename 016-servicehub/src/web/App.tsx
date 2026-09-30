import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router';
import { AppLayout, AuthGate } from './components/Layout';
import { Spinner } from './components/ui';
import { AcceptInvitePage, ForgotPasswordPage, LoginPage, ResetPasswordPage, SelectOrgPage } from './pages/auth/AuthPages';
import { DashboardPage } from './pages/DashboardPage';
import { AccountPage, OrgSettingsPage, SettingsHome } from './pages/settings/OrgAndAccount';
import { LocationEditPage, LocationsPage } from './pages/settings/LocationsPages';
import { MembersPage } from './pages/settings/MembersPage';
import { ResourcesPage, ServiceEditPage, ServicesPage, StaffPage } from './pages/settings/CatalogPages';
import { ShiftsPage } from './pages/ShiftsPage';
import { ManageBookingPage, PublicBookingPage, PublicOrgPage } from './pages/public/PublicPages';
import { CustomerDetailPage, CustomersPage } from './pages/customers/CustomerPages';
import { BookingDetailPage, BookingsPage } from './pages/bookings/BookingPages';
import { NotificationsPage } from './pages/NotificationsPage';

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
        <Route path="/b/:token" element={<ManageBookingPage />} />
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
          <Route path="settings" element={<SettingsHome />} />
          <Route path="settings/org" element={<OrgSettingsPage />} />
          <Route path="settings/locations" element={<LocationsPage />} />
          <Route path="settings/locations/:id" element={<LocationEditPage />} />
          <Route path="settings/members" element={<MembersPage />} />
          <Route path="settings/services" element={<ServicesPage />} />
          <Route path="settings/services/:id" element={<ServiceEditPage />} />
          <Route path="settings/staff" element={<StaffPage />} />
          <Route path="settings/resources" element={<ResourcesPage />} />
          <Route path="shifts" element={<ShiftsPage />} />
          <Route path="customers" element={<CustomersPage />} />
          <Route path="customers/:id" element={<CustomerDetailPage />} />
          <Route path="bookings" element={<BookingsPage />} />
          <Route path="bookings/:id" element={<BookingDetailPage />} />
          <Route path="notifications" element={<NotificationsPage />} />
          <Route path="*" element={<NotFound />} />
        </Route>
        <Route path="*" element={<NotFound />} />
      </Routes>
    </Suspense>
  );
}

export { lazy };
