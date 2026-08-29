import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { AuthProvider, useAuth } from './context/AuthContext';
import { isModuleEnabled } from './services/planService';
import DashboardLayout from './layouts/DashboardLayout';
import Dashboard from './pages/Dashboard';
import Leads from './pages/Leads';
import SiteVisits from './pages/SiteVisits';
import Inventory from './pages/Inventory';
import Projects from './pages/Projects';
import Execution from './pages/Execution';
import Procurement from './pages/Procurement';
import HR from './pages/HR';
import Accounts from './pages/Accounts';
import Land from './pages/Land';
import BD from './pages/BD';
import SalesPerformance from './pages/SalesPerformance';
import AIStudio from './pages/AIStudio';
import Campaigns from './pages/Campaigns';
import Calendar from './pages/Calendar';
import Reports from './pages/Reports';
import Settings from './pages/Settings';
import Messages from './pages/Messages';
import Documents from './pages/Documents';
import Billing from './pages/Billing';
import Service from './pages/Service';
import Bookings from './pages/Bookings';
import CostSheets from './pages/CostSheets';
import Customers from './pages/Customers';
import Possession from './pages/Possession';
import Leasing from './pages/Leasing';
import Brokers from './pages/Brokers';
import SuperAdmin from './pages/SuperAdmin';
import Login from './pages/Login';
import AccessDenied from './pages/AccessDenied';
import PortalLogin from './pages/PortalLogin';
import PortalDashboard from './pages/PortalDashboard';
import ChatbotPortal from './pages/ChatbotPortal';
import Microsite from './pages/Microsite';
import ChatbotWidget from './pages/ChatbotWidget';
import ForcePasswordChange from './components/ForcePasswordChange';
import ErrorBoundary from './components/ErrorBoundary';

function AuthGuard({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading, user } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-zinc-50">
        <div className="flex flex-col items-center gap-4">
          <div className="h-12 w-12 rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center animate-pulse">
            <span className="text-white font-bold text-lg">F</span>
          </div>
          <div className="flex gap-1.5">
            <span className="h-2 w-2 rounded-full bg-indigo-400 animate-bounce" style={{ animationDelay: '0ms' }} />
            <span className="h-2 w-2 rounded-full bg-indigo-400 animate-bounce" style={{ animationDelay: '150ms' }} />
            <span className="h-2 w-2 rounded-full bg-indigo-400 animate-bounce" style={{ animationDelay: '300ms' }} />
          </div>
          <p className="text-sm text-zinc-500">Loading your workspace...</p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  // Admin issued a temporary password: block the entire app until the user sets
  // their own. Enforced here (not just in a route) so no deep link bypasses it.
  if (user?.mustChangePassword) {
    return <ForcePasswordChange />;
  }

  return <>{children}</>;
}

function PermissionGuard({ permission, module, children }: { permission: string; module?: string; children: React.ReactNode }) {
  const { hasPermission, isLoading, tenant } = useAuth();

  if (isLoading) return null;
  if (!hasPermission(permission)) {
    return <AccessDenied />;
  }
  // Super-admin module toggle: a disabled module is blocked at the route
  // level too, not just hidden from the nav
  if (module && !isModuleEnabled(tenant, module)) {
    return <AccessDenied />;
  }
  return <>{children}</>;
}

function AppRoutes() {
  const { isAuthenticated } = useAuth();

  return (
    <Routes>
      <Route path="/login" element={isAuthenticated ? <Navigate to="/" replace /> : <Login />} />

      {/* Customer & channel-partner portal — separate auth, outside the CRM guard */}
      <Route path="/portal" element={<PortalLogin />} />
      <Route path="/portal/home" element={<PortalDashboard />} />

      {/* Public project microsite — no auth; captures leads into the CRM */}
      <Route path="/site/:slug/:projectId" element={<Microsite />} />
      <Route path="/chat/:slug" element={<ChatbotWidget />} />

      <Route
        element={
          <AuthGuard>
            <DashboardLayout />
          </AuthGuard>
        }
      >
        <Route path="/" element={<PermissionGuard permission="view_dashboard"><Dashboard /></PermissionGuard>} />
        <Route path="/leads" element={<PermissionGuard permission="view_leads" module="leads"><Leads /></PermissionGuard>} />
        {/* Gated on view_leads, the same key the routes use — a visit is an
            event in a lead's life, not a module of its own. */}
        <Route path="/site-visits" element={<PermissionGuard permission="view_leads" module="leads"><SiteVisits /></PermissionGuard>} />
        <Route path="/inventory" element={<PermissionGuard permission="view_inventory" module="inventory"><Inventory /></PermissionGuard>} />
        <Route path="/projects" element={<PermissionGuard permission="view_projects" module="projects"><Projects /></PermissionGuard>} />
        <Route path="/execution" element={<PermissionGuard permission="view_execution" module="execution"><Execution /></PermissionGuard>} />
        <Route path="/procurement" element={<PermissionGuard permission="view_procurement" module="procurement"><Procurement /></PermissionGuard>} />
        <Route path="/hr" element={<PermissionGuard permission="view_hr" module="hr"><HR /></PermissionGuard>} />
        <Route path="/accounts" element={<PermissionGuard permission="view_accounts" module="accounts"><Accounts /></PermissionGuard>} />
        <Route path="/bd" element={<PermissionGuard permission="view_bd" module="bd"><BD /></PermissionGuard>} />
        <Route path="/land" element={<PermissionGuard permission="view_land" module="land"><Land /></PermissionGuard>} />
        <Route path="/sales-performance" element={<PermissionGuard permission="view_sales_performance" module="sales-performance"><SalesPerformance /></PermissionGuard>} />
        <Route path="/ai-studio" element={<PermissionGuard permission="use_ai_studio" module="ai-studio"><AIStudio /></PermissionGuard>} />
        <Route path="/campaigns" element={<PermissionGuard permission="view_campaigns" module="campaigns"><Campaigns /></PermissionGuard>} />
        <Route path="/calendar" element={<PermissionGuard permission="view_calendar" module="calendar"><Calendar /></PermissionGuard>} />
        <Route path="/reports" element={<PermissionGuard permission="view_reports" module="reports"><Reports /></PermissionGuard>} />
        <Route path="/whatsapp" element={<PermissionGuard permission="view_messages" module="messages"><Messages /></PermissionGuard>} />
        {/* Old path kept as a redirect so existing links and bookmarks survive
            the rename (query string included, for /messages?lead=<id>). */}
        <Route path="/messages" element={<Navigate to={{ pathname: '/whatsapp', search: window.location.search }} replace />} />
        <Route path="/documents" element={<PermissionGuard permission="view_documents" module="documents"><Documents /></PermissionGuard>} />
        <Route path="/billing" element={<PermissionGuard permission="view_finance" module="billing"><Billing /></PermissionGuard>} />
        <Route path="/service" element={<PermissionGuard permission="view_service" module="service"><Service /></PermissionGuard>} />
        <Route path="/bookings" element={<PermissionGuard permission="view_bookings" module="bookings"><Bookings /></PermissionGuard>} />
        <Route path="/cost-sheets" element={<PermissionGuard permission="view_bookings" module="bookings"><CostSheets /></PermissionGuard>} />
        <Route path="/customers" element={<PermissionGuard permission="view_leads"><Customers /></PermissionGuard>} />
        <Route path="/possession" element={<PermissionGuard permission="view_bookings" module="bookings"><Possession /></PermissionGuard>} />
        <Route path="/leasing" element={<PermissionGuard permission="view_leasing" module="leasing"><Leasing /></PermissionGuard>} />
        <Route path="/brokers" element={<PermissionGuard permission="view_brokers" module="brokers"><Brokers /></PermissionGuard>} />
        <Route path="/platform" element={<PermissionGuard permission="view_platform"><SuperAdmin /></PermissionGuard>} />
        <Route path="/settings" element={<PermissionGuard permission="manage_settings"><Settings /></PermissionGuard>} />
        <Route path="/integrations/chatbot" element={<PermissionGuard permission="manage_settings"><ChatbotPortal /></PermissionGuard>} />
      </Route>

      <Route path="*" element={<Navigate to={isAuthenticated ? '/' : '/login'} replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        {/* Top-level net: catches crashes outside the dashboard shell too
            (login, portal, public microsite) so nothing ever blanks to white. */}
        <ErrorBoundary>
          <AppRoutes />
        </ErrorBoundary>
        <Toaster
          position="top-right"
          toastOptions={{
            duration: 3000,
            style: {
              borderRadius: '12px',
              background: '#18181b',
              color: '#fafafa',
              fontSize: '14px',
              padding: '12px 16px',
              boxShadow: '0 8px 24px rgba(0,0,0,0.15)',
            },
            success: { iconTheme: { primary: '#10b981', secondary: '#fafafa' } },
            error: { iconTheme: { primary: '#ef4444', secondary: '#fafafa' } },
          }}
        />
      </AuthProvider>
    </BrowserRouter>
  );
}
