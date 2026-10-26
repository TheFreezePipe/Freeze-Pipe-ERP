import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "@/lib/query-client";
import { AuthProvider, useAuth } from "@/lib/auth-context";
import { RequireRole } from "@/components/shared/RequireRole";
import { Toaster } from "@/components/ui/toaster";
import { Layout } from "@/components/layout/Layout";
import { GoLayout } from "@/components/layout/GoLayout";
import { EnvBanner } from "@/components/layout/EnvBanner";
import { landingPathFor } from "@/lib/landing";
import { LEGACY_ROUTE_PATHS, legacyRedirect } from "@/lib/inventory-routes";
import type { ReactNode } from "react";

// Pages
import Login from "@/pages/auth/Login";
import Register from "@/pages/auth/Register";
import Dashboard from "@/pages/Dashboard";
import ManufacturingDashboard from "@/pages/manufacturing/ManufacturingDashboard";
import Workspace from "@/pages/manufacturing/Workspace";
import Performance from "@/pages/manufacturing/Performance";
import FreightDashboard from "@/pages/freight/FreightDashboard";
import FreightDetail from "@/pages/freight/FreightDetail";
import FreightNew from "@/pages/freight/FreightNew";
import InventoryOverview from "@/pages/inventory/InventoryOverview";
import StockPage from "@/pages/inventory/Stock";
import FactoryOrders from "@/pages/inventory/FactoryOrders";
import AdminFactoryOrderDetail from "@/pages/inventory/FactoryOrderDetail";
import QualityIssues from "@/pages/inventory/QualityIssues";
// Feature-flagged page — Materials catalog. Visible only to Chase
// during development. Drop the import + route block + sidebar entry
// to remove access entirely.
import MaterialsList from "@/pages/inventory/MaterialsList";
import MaterialDetail from "@/pages/inventory/materials/MaterialDetail";
import SKUList from "@/pages/economics/SKUList";
import SKUDetail from "@/pages/economics/SKUDetail";
import SuppliersList from "@/pages/economics/SuppliersList";
import SupplierDetail from "@/pages/economics/SupplierDetail";
import MarketingCalendar from "@/pages/marketing/MarketingCalendar";
import SalesList from "@/pages/marketing/SalesList";
import SalesDetail from "@/pages/marketing/SalesDetail";
import Launches from "@/pages/marketing/Launches";
import Broadcasts from "@/pages/marketing/Broadcasts";
import ProductDevelopment from "@/pages/marketing/ProductDevelopment";
import SettingsPage from "@/pages/settings/Settings";
import SupplierDashboard from "@/pages/supplier/SupplierDashboard";
import FactoryOrdersList from "@/pages/supplier/FactoryOrdersList";
import NewFactoryOrder from "@/pages/supplier/NewFactoryOrder";
import FactoryOrderDetail from "@/pages/supplier/FactoryOrderDetail";
import ShipmentsList from "@/pages/supplier/ShipmentsList";
import NewShipment from "@/pages/supplier/NewShipment";
import SupplierShipmentDetail from "@/pages/supplier/SupplierShipmentDetail";
import BreakageInbox from "@/pages/supplier/BreakageInbox";
import VarianceInbox from "@/pages/supplier/VarianceInbox";
import FloorHome from "@/pages/floor/FloorHome";
import LookupPage from "@/pages/floor/LookupPage";
import GoPutaway from "@/pages/floor/GoPutaway";
import GoCount from "@/pages/floor/GoCount";
import GoMove from "@/pages/floor/GoMove";

import { isDemoMode } from "@/lib/env";

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (isDemoMode) return <>{children}</>;
  if (loading) {
    return (
      <div className="flex h-dvh items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

/** Smart default redirect based on user role */
function DefaultRedirect() {
  const { role, roleResolved } = useAuth();
  // Wait for the real role — redirecting on the "user" fallback would send
  // admins to the staff workspace whenever the profile loads a beat late.
  if (!roleResolved) {
    return (
      <div className="flex h-dvh items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }
  return <Navigate to={landingPathFor(role)} replace />;
}

/**
 * Pre-merge routes (/freight/*, /warehouse/*, /inventory/quality-issues)
 * redirect into the Inventory module with their query string and path
 * params carried over. The target route does its own auth and role check.
 */
function LegacyRedirect() {
  const { pathname, search } = useLocation();
  return <Navigate to={legacyRedirect(pathname, search) ?? "/"} replace />;
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <Routes>
            {/* Public routes. The signed-in shell (Layout) renders the
                environment banner inside its own column. */}
            <Route path="/login" element={<><EnvBanner /><Login /></>} />
            <Route path="/register" element={<><EnvBanner /><Register /></>} />

            {/* Legacy routes from before the Inventory merge (2026-10-21) */}
            {LEGACY_ROUTE_PATHS.map((path) => (
              <Route key={path} path={path} element={<LegacyRedirect />} />
            ))}

            {/* Floor (/go): phone-first screens for every internal role. GoLayout
                is the task-mode shell below md and the normal Layout above. */}
            <Route
              element={
                <RequireAuth>
                  <GoLayout />
                </RequireAuth>
              }
            >
              <Route path="/go" element={
                <RequireRole allowed={["admin", "manager", "user"]}>
                  <FloorHome />
                </RequireRole>
              } />
              <Route path="/go/lookup" element={
                <RequireRole allowed={["admin", "manager", "user"]}>
                  <LookupPage />
                </RequireRole>
              } />
              <Route path="/go/putaway" element={
                <RequireRole allowed={["admin", "manager", "user"]}>
                  <GoPutaway />
                </RequireRole>
              } />
              <Route path="/go/count" element={
                <RequireRole allowed={["admin", "manager", "user"]}>
                  <GoCount />
                </RequireRole>
              } />
              <Route path="/go/move" element={
                <RequireRole allowed={["admin", "manager", "user"]}>
                  <GoMove />
                </RequireRole>
              } />
            </Route>

            {/* Protected routes */}
            <Route
              element={
                <RequireAuth>
                  <Layout />
                </RequireAuth>
              }
            >
              {/* Dashboard - admin & manager only */}
              <Route path="/dashboard" element={
                <RequireRole allowed={["admin", "manager"]}>
                  <Dashboard />
                </RequireRole>
              } />

              {/* Manufacturing */}
              <Route path="/manufacturing" element={
                <RequireRole allowed={["admin", "manager", "user"]}>
                  <ManufacturingDashboard />
                </RequireRole>
              } />
              <Route path="/manufacturing/workspace" element={
                <RequireRole allowed={["admin", "manager", "user"]}>
                  <Workspace />
                </RequireRole>
              } />
              {/* Staff get the same page scoped to "Just me" by default;
                  the team leaderboard stays visible to everyone (owner
                  decision 2026-07-15). */}
              <Route path="/manufacturing/performance" element={
                <RequireRole allowed={["admin", "manager", "user"]}>
                  <Performance />
                </RequireRole>
              } />

              {/* Inventory - admin & manager only (Floor at /go is the
                  module's phone home for every internal role). */}
              <Route path="/inventory" element={
                <RequireRole allowed={["admin", "manager"]}>
                  <InventoryOverview />
                </RequireRole>
              } />
              {/* Materials catalog — released to all admin/manager users
                  (2026-06-10). Listed before the /inventory route so a
                  URL-typed visit lands cleanly. */}
              <Route path="/inventory/materials" element={
                <RequireRole allowed={["admin", "manager"]}>
                  <MaterialsList />
                </RequireRole>
              } />
              <Route path="/inventory/materials/:materialId" element={
                <RequireRole allowed={["admin", "manager"]}>
                  <MaterialDetail />
                </RequireRole>
              } />
              <Route path="/inventory/stock" element={
                <RequireRole allowed={["admin", "manager"]}>
                  <StockPage />
                </RequireRole>
              } />
              {/* Shipments (inbound freight), moved from /freight */}
              <Route path="/inventory/shipments" element={
                <RequireRole allowed={["admin", "manager"]}>
                  <FreightDashboard />
                </RequireRole>
              } />
              <Route path="/inventory/shipments/new" element={
                <RequireRole allowed={["admin", "manager"]}>
                  <FreightNew />
                </RequireRole>
              } />
              <Route path="/inventory/shipments/:id" element={
                <RequireRole allowed={["admin", "manager"]}>
                  <FreightDetail />
                </RequireRole>
              } />
              <Route path="/inventory/factory-orders" element={
                <RequireRole allowed={["admin", "manager"]}>
                  <FactoryOrders />
                </RequireRole>
              } />
              <Route path="/inventory/factory-orders/:id" element={
                <RequireRole allowed={["admin", "manager"]}>
                  <AdminFactoryOrderDetail />
                </RequireRole>
              } />
              <Route path="/inventory/issues" element={
                <RequireRole allowed={["admin", "manager"]}>
                  <QualityIssues />
                </RequireRole>
              } />

              {/* Economics - admin only */}
              <Route path="/economics" element={
                <RequireRole allowed={["admin"]}>
                  <SKUList />
                </RequireRole>
              } />
              <Route path="/economics/suppliers" element={
                <RequireRole allowed={["admin"]}>
                  <SuppliersList />
                </RequireRole>
              } />
              <Route path="/economics/suppliers/:id" element={
                <RequireRole allowed={["admin"]}>
                  <SupplierDetail />
                </RequireRole>
              } />
              <Route path="/economics/:skuId" element={
                <RequireRole allowed={["admin"]}>
                  <SKUDetail />
                </RequireRole>
              } />

              {/* Marketing - readable by all internal roles (alignment); writes stay admin/manager via page-level canEdit */}
              <Route path="/marketing" element={
                <RequireRole allowed={["admin", "manager"]}>
                  <MarketingCalendar />
                </RequireRole>
              } />
              <Route path="/marketing/sales" element={
                <RequireRole allowed={["admin", "manager"]}>
                  <SalesList />
                </RequireRole>
              } />
              <Route path="/marketing/sales/:id" element={
                <RequireRole allowed={["admin", "manager"]}>
                  <SalesDetail />
                </RequireRole>
              } />
              <Route path="/marketing/launches" element={
                <RequireRole allowed={["admin", "manager"]}>
                  <Launches />
                </RequireRole>
              } />
              <Route path="/marketing/broadcasts" element={
                <RequireRole allowed={["admin", "manager"]}>
                  <Broadcasts />
                </RequireRole>
              } />
              <Route path="/marketing/product-development" element={
                <RequireRole allowed={["admin", "manager"]}>
                  <ProductDevelopment />
                </RequireRole>
              } />

              {/* Settings - admin only */}
              <Route path="/settings" element={
                <RequireRole allowed={["admin"]}>
                  <SettingsPage />
                </RequireRole>
              } />

              {/* Supplier portal - supplier role (+ admin for support access) */}
              <Route path="/supplier" element={
                <RequireRole allowed={["supplier", "admin"]}>
                  <SupplierDashboard />
                </RequireRole>
              } />
              <Route path="/supplier/orders" element={
                <RequireRole allowed={["supplier", "admin"]}>
                  <FactoryOrdersList />
                </RequireRole>
              } />
              <Route path="/supplier/orders/new" element={
                <RequireRole allowed={["supplier", "admin"]}>
                  <NewFactoryOrder />
                </RequireRole>
              } />
              <Route path="/supplier/orders/:id" element={
                <RequireRole allowed={["supplier", "admin"]}>
                  <FactoryOrderDetail />
                </RequireRole>
              } />
              <Route path="/supplier/shipments" element={
                <RequireRole allowed={["supplier", "admin"]}>
                  <ShipmentsList />
                </RequireRole>
              } />
              <Route path="/supplier/shipments/new" element={
                <RequireRole allowed={["supplier", "admin"]}>
                  <NewShipment />
                </RequireRole>
              } />
              <Route path="/supplier/shipments/:id" element={
                <RequireRole allowed={["supplier", "admin"]}>
                  <SupplierShipmentDetail />
                </RequireRole>
              } />
              <Route path="/supplier/breakage" element={
                <RequireRole allowed={["supplier", "admin"]}>
                  <BreakageInbox />
                </RequireRole>
              } />
              <Route path="/supplier/variances" element={
                <RequireRole allowed={["supplier", "admin"]}>
                  <VarianceInbox />
                </RequireRole>
              } />
            </Route>

            {/* Default redirect based on role */}
            <Route path="*" element={
              <RequireAuth>
                <DefaultRedirect />
              </RequireAuth>
            } />
          </Routes>
          <Toaster />
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
