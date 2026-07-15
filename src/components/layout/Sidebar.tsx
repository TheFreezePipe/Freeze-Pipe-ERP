import { NavLink, useLocation } from "react-router-dom";
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
  ChevronDown,
  Home,
  ClipboardList,
  PackageOpen,
  Building2,
  Beaker,
  Calendar,
  Tag,
  Rocket,
  Megaphone,
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
      { to: "/manufacturing/performance", label: "Performance", icon: BarChart3, roles: ["admin", "manager", "user"] },
    ],
  },
  {
    label: "Inventory",
    items: [
      { to: "/inventory", label: "Stock Levels", icon: Package, roles: ["admin", "manager"] },
      // Inbound freight — lives here now (the on-order → in-transit → on-hand flow);
      // page route stays /freight.
      { to: "/freight", label: "Shipments", icon: Ship, roles: ["admin", "manager"] },
      { to: "/inventory/factory-orders", label: "Factory Orders", icon: Truck, roles: ["admin", "manager"] },
      { to: "/inventory/materials", label: "Materials", icon: Beaker, roles: ["admin", "manager"] },
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
    label: "Marketing",
    items: [
      { to: "/marketing", label: "Calendar", icon: Calendar, roles: ["admin", "manager", "user"] },
      { to: "/marketing/sales", label: "Sales", icon: Tag, roles: ["admin", "manager", "user"] },
      { to: "/marketing/launches", label: "Launches", icon: Rocket, roles: ["admin", "manager", "user"] },
      { to: "/marketing/broadcasts", label: "Broadcasts", icon: Megaphone, roles: ["admin", "manager", "user"] },
    ],
  },
  {
    items: [
      { to: "/settings", label: "Settings", icon: Settings, roles: ["admin"] },
    ],
  },
  // Supplier-only nav. Internal roles don't see any of these.
  {
    label: "Supplier Portal",
    items: [
      { to: "/supplier", label: "Overview", icon: Home, roles: ["supplier"] },
      { to: "/supplier/orders", label: "Factory Orders", icon: ClipboardList, roles: ["supplier"] },
      { to: "/supplier/shipments", label: "Shipments", icon: PackageOpen, roles: ["supplier"] },
    ],
  },
];

const COLLAPSED_GROUPS_KEY = "sidebar.collapsedGroups";

interface SidebarProps {
  collapsed?: boolean;
  onCollapse?: (collapsed: boolean) => void;
  onNavClick?: () => void;
}

export function Sidebar({ collapsed: controlledCollapsed, onCollapse, onNavClick }: SidebarProps) {
  const [internalCollapsed, setInternalCollapsed] = useState(false);
  const collapsed = controlledCollapsed ?? internalCollapsed;
  const { role } = useAuth();
  const { pathname } = useLocation();

  // Which labeled groups the user has collapsed (persisted). Default: none —
  // every folder starts expanded.
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>(() => {
    try {
      const raw = localStorage.getItem(COLLAPSED_GROUPS_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  });

  function toggleGroup(label: string) {
    setCollapsedGroups((prev) => {
      const next = { ...prev, [label]: !prev[label] };
      try {
        localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify(next));
      } catch {
        /* ignore storage failures */
      }
      return next;
    });
  }

  function handleCollapse() {
    const next = !collapsed;
    setInternalCollapsed(next);
    onCollapse?.(next);
  }

  const isActivePath = (to: string) => pathname === to || pathname.startsWith(`${to}/`);

  // Filter nav groups based on user role
  const filteredGroups = navGroups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => item.roles.includes(role)),
    }))
    .filter((group) => group.items.length > 0);

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
        {filteredGroups.map((group, gi) => {
          const hasLabel = !!group.label;
          const groupActive = group.items.some((item) => isActivePath(item.to));
          // A labeled folder shows its items when: the sidebar is in icon mode
          // (labels hidden anyway), the user hasn't collapsed it, OR it contains
          // the current page (so you never lose your place).
          const open =
            !hasLabel || collapsed || !collapsedGroups[group.label!] || groupActive;

          return (
            <div key={gi} className="mb-2">
              {hasLabel && !collapsed && (
                <button
                  type="button"
                  onClick={() => toggleGroup(group.label!)}
                  className="mb-1 flex w-full items-center justify-between rounded px-2 py-1 text-xs font-medium uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
                >
                  <span>{group.label}</span>
                  {open ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
                </button>
              )}
              {gi > 0 && !hasLabel && <Separator className="my-2" />}
              {open &&
                group.items.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.to === "/manufacturing" || item.to === "/freight" || item.to === "/inventory" || item.to === "/economics" || item.to === "/supplier" || item.to === "/marketing"}
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
          );
        })}
      </ScrollArea>
    </aside>
  );
}
