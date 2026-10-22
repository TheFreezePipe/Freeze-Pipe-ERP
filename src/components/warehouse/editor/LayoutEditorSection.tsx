import { lazy, Suspense } from "react";
import { Link } from "react-router-dom";
import { Map as MapIcon, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth-context";
import { useUrlFilter } from "@/lib/use-url-filter";

const LayoutEditor = lazy(() => import("./LayoutEditor").then((m) => ({ default: m.LayoutEditor })));

/**
 * Settings › Warehouse › Layout editor (admin). The editor opens full
 * screen and is bound to `?edit=layout`, so the map's Edit layout button
 * (/settings?tab=warehouse&edit=layout) lands straight in it.
 */
export function LayoutEditorSection() {
  const { hasRole } = useAuth();
  const [edit, setEdit] = useUrlFilter<string>("edit", "");
  const isAdmin = hasRole("admin");
  const open = isAdmin && edit === "layout";

  return (
    <section className="space-y-2 border-t border-border/50 pt-4" aria-labelledby="wh-layout-editor">
      <h3 id="wh-layout-editor" className="text-sm font-medium">
        Layout editor
      </h3>
      <p className="text-xs text-muted-foreground">
        Move, turn, add or retire racks and fixtures on the plan, edit faces (walk pass and direction, zones, pickable levels), then preview and
        apply the generated locations. Verify walk checks the pick sequence.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => setEdit("layout")} disabled={!isAdmin} title={isAdmin ? undefined : "Admins only"}>
          <Pencil className="mr-1.5 h-4 w-4" /> Open layout editor
        </Button>
        <Button asChild size="sm" variant="outline">
          <Link to="/inventory/stock?view=map">
            <MapIcon className="mr-1.5 h-4 w-4" /> View the map
          </Link>
        </Button>
      </div>
      {open && (
        <Suspense fallback={<div className="fixed inset-0 z-40 bg-background/80" />}>
          <LayoutEditor onClose={() => setEdit("")} />
        </Suspense>
      )}
    </section>
  );
}
