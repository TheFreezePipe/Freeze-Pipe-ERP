import { NavLink } from "react-router-dom";
import { cn } from "@/lib/utils";
import { useAuth, type UserRole } from "@/lib/auth-context";
import {
  LayoutDashboard,
  Factory,
  ScanLine,
  BarChart3,
  Ship,
  Package,
  Truck,
  DollarSign,
  Settings,
  ChevronLeft,
  ChevronRight,
  Home,
  ClipboardList,
  PackageOpen,
  Building2,
  Beaker,
} from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";

interface NavItem {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  roles: UserRole[];
}

interface NavGroup {
  label?: string;
  items: NavItem[];
}

const navGroups: NavGroup[] = [
  {
    items: [
      { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard, roles: ["admin", "manager"] },
    ],
  },
  {
    label: "Manufacturing",
    items: [
      { to: "/manufacturing", label: "Overview", icon: Factory, roles: ["admin", "manager", "user"] },
      { to: "/manufacturing/workspace", label: "Workspace", icon: ScanLine, roles: ["admin", "manager", "user"] },
      { to: "/manufacturing/performance", label: "Performance", icon: BarChart3, roles: ["admin", "manager"] },
    ],
  },
  {
    label: "Freight",
    items: [
      { to: "/freight", label: "Shipments", icon: Ship, roles: ["admin", "manager"] },
    ],
  },
  {
    label: "Inventory",
    items: [
      { to: "/inventory", label: "Stock Levels", icon: Package, roles: ["admin", "manager"] },
      { to: "/inventory/factory-orders", label: "Factory Orders", icon: Truck, roles: ["admin", "manager"] },
      // Materials — feature-flagged. Removed from the rendered list for users
      // who aren't in the feature-flag allow-list (see render logic below).
      { to: "/inventory/materials", label: "Materials", icon: Beaker, roles: ["admin", "manager"] },
      // Quality Issues shelved out of scope. Route + page + RPCs remain wired
      // at /inventory/quality-issues so re-enabling is a one-line change.
    ],
  },
  {
    label: "Economics",
    items: [
      { to: "/economics", label: "SKU Costs", icon: DollarSign, roles: ["admin"] },
      { to: "/economics/suppliers", label: "Suppliers", icon: Building2, roles: ["admin"] },
    ],
  },
  {
    items: [
      { to: "/settings", label: "Settings", icon: Settings, roles: ["admin"] },
    ],
  },
  // Supplier-only nav. Internal roles don't see any of these.
  // Breakage + variances surfaces exist in the DB and routes stay wired, but
  // they're hidden from nav for the pilot — suppliers handle these off-app.
  {
    label: "Supplier Portal",
    items: [
      { to: "/supplier", label: "Overview", icon: Home, roles: ["supplier"] },
      { to: "/supplier/orders", label: "Factory Orders", icon: ClipboardList, roles: ["supplier"] },
      { to: "/supplier/shipments", label: "Shipments", icon: PackageOpen, roles: ["supplier"] },
    ],
  },
];

interface SidebarProps {
  collapsed?: boolean;
  onCollapse?: (collapsed: boolean) => void;
  onNavClick?: () => void;
}

export function Sidebar({ collapsed: controlledCollapsed, onCollapse, onNavClick }: SidebarProps) {
  const [internalCollapsed, setInternalCollapsed] = useState(false);
  const collapsed = controlledCollapsed ?? internalCollapsed;
  const { role } = useAuth();

  function handleCollapse() {
    const next = !collapsed;
    setInternalCollapsed(next);
    onCollapse?.(next);
  }

  // Filter nav groups based on user role
  const filteredGroups = navGroups
    .map(group => ({
      ...group,
      items: group.items.filter(item => item.roles.includes(role)),
    }))
    .filter(group => group.items.length > 0);

  return (
    <aside
      className={cn(
        "flex flex-col border-r border-border bg-sidebar transition-all duration-200",
        collapsed ? "w-16" : "w-60"
      )}
    >
      <div className="flex h-14 items-center justify-between px-3">
        {!collapsed && (
          <span className="text-sm font-semibold text-primary truncate">
            Freeze Pipe ERP
          </span>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          onClick={handleCollapse}
        >
          {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
        </Button>
      </div>
      <Separator />
      <ScrollArea className="flex-1 px-2 py-2">
        {filteredGroups.map((group, gi) => (
          <div key={gi} className="mb-2">
            {group.label && !collapsed && (
              <p className="mb-1 px-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                {group.label}
              </p>
            )}
            {gi > 0 && !group.label && <Separator className="my-2" />}
            {group.items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === "/manufacturing" || item.to === "/freight" || item.to === "/inventory" || item.to === "/economics" || item.to === "/supplier"}
                className={({ isActive }) =>
                  cn(
                    "flex items-center gap-3 rounded-md px-2 py-2 text-sm font-medium transition-colors",
                    isActive
                      ? "bg-sidebar-accent text-primary"
                      : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                  )
                }
                title={collapsed ? item.label : undefined}
                onClick={onNavClick}
              >
                <item.icon className="h-4 w-4 shrink-0" />
                {!collapsed && <span className="truncate">{item.label}</span>}
              </NavLink>
            ))}
          </div>
        ))}
      </ScrollArea>
    </aside>
  );
}
