import { Outlet, useLocation } from "react-router-dom";
import { Sidebar } from "./Sidebar";
import { Header } from "./Header";
import { EnvBanner } from "./EnvBanner";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { useState } from "react";
import { ErrorBoundary } from "@/components/shared/ErrorBoundary";
import { StationChip } from "@/components/warehouse/StationChip";

export function Layout() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();

  return (
    <div className="flex h-dvh overflow-hidden pt-safe pb-safe pl-safe pr-safe">
      {/* Desktop sidebar */}
      <div className="hidden md:flex">
        <Sidebar />
      </div>

      {/* Mobile sidebar drawer */}
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="w-60 p-0 pt-safe">
          <Sidebar collapsed={false} onNavClick={() => setMobileOpen(false)} />
        </SheetContent>
      </Sheet>

      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Inside the column so banner + header + page is exactly the viewport. */}
        <EnvBanner />
        {/* The live station sits on the header's free left side (after the
            hamburger on phones), so a label request always shows where it prints. */}
        <div className="relative shrink-0">
          <Header onMenuClick={() => setMobileOpen(true)} />
          <div className="pointer-events-none absolute inset-y-0 left-16 flex items-center md:left-4">
            <StationChip className="pointer-events-auto" />
          </div>
        </div>
        <main className="flex-1 overflow-auto p-4 md:p-6">
          {/* Key by pathname so navigating to another page resets the boundary
              (otherwise the old error would persist until Try again / Reload). */}
          <ErrorBoundary key={location.pathname} fallbackContext={location.pathname}>
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
}
