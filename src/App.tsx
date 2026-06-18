import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "@/lib/query-client";
import { AuthProvider, useAuth } from "@/lib/auth-context";
import { RequireRole } from "@/components/shared/RequireRole";
import { Toaster } from "@/components/ui/toaster";
import { Layout } from "@/components/layout/Layout";
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
import InventoryDashboard from "@/pages/inventory/InventoryDashboard";
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

import { isDemoMode, APP_ENV, shouldShowEnvBanner } from "@/lib/env";

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (isDemoMode) return <>{children}</>;
  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

/** Smart default redirect based on user role */
function DefaultRedirect() {
  const { role } = useAuth();
  if (role === "user") return <Navigate to="/manufacturing/workspace" replace />;
  if (role === "supplier") return <Navigate to="/supplier" replace />;
  return <Navigate to="/dashboard" replace />;
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          {shouldShowEnvBanner && (
            <div className={`text-center text-xs py-1 font-semibold ${
              APP_ENV === "staging" ? "bg-amber-500 text-black" :
              isDemoMode ? "bg-orange-500 text-black" :
              "bg-blue-500 text-white"
            }`}>
              {isDemoMode
                ? "DEMO MODE — data is in-memory and will be lost on reload"
                : `${APP_ENV.toUpperCase()} ENVIRONMENT — not production data`}
            </div>
          )}
          <Routes>
            {/* Public routes */}
            <Route path="/login" element={<Login />} />
            <Route path="/register" element={<Register />} />

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
              <Route path="/manufacturing/performance" element={
                <RequireRole allowed={["admin", "manager"]}>
                  <Performance />
                </RequireRole>
              } />

              {/* Freight - admin & manager only */}
              <Route path="/freight" element={
                <RequireRole allowed={["admin", "manager"]}>
                  <FreightDashboard />
                </RequireRole>
              } />
              <Route path="/freight/new" element={
                <RequireRole allowed={["admin", "manager"]}>
                  <FreightNew />
                </RequireRole>
              } />
              <Route path="/freight/:id" element={
                <RequireRole allowed={["admin", "manager"]}>
                  <FreightDetail />
                </RequireRole>
              } />

              {/* Inventory - admin & manager only */}
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
              <Route path="/inventory" element={
                <RequireRole allowed={["admin", "manager"]}>
                  <InventoryDashboard />
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
              <Route path="/inventory/quality-issues" element={
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

              {/* Marketing - admin & manager only */}
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
