import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, Tag, Pencil } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useSales, type MktSale } from "@/lib/hooks";
import { useAuth } from "@/lib/auth-context";
import { SaleFormDialog } from "@/components/marketing/SaleFormDialog";
import { salePhase, PHASE_COLOR, isPastKey, dayKeyOf } from "@/lib/marketing-format";
import { format, parseISO } from "date-fns";

function fmt(d: string | null): string {
  if (!d) return "—";
  try {
    return format(parseISO(d), "MMM d, yyyy");
  } catch {
    return d;
  }
}
function range(s: string | null, e: string | null): string {
  if (!s && !e) return "No dates set";
  return `${fmt(s)} → ${fmt(e)}`;
}

export default function SalesList() {
  const navigate = useNavigate();
  const { data: sales = [], isLoading } = useSales();
  const { isAdmin, isManager } = useAuth();
  const canEdit = isAdmin || isManager;
  const todayKey = format(new Date(), "yyyy-MM-dd");
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<MktSale | null>(null);

  return (
    <div className="space-y-6 max-w-5xl">
      <SaleFormDialog open={createOpen} onOpenChange={setCreateOpen} />
      <SaleFormDialog
        open={!!editing}
        onOpenChange={(o) => !o && setEditing(null)}
        sale={editing}
        datesLocked={!!editing && isPastKey(dayKeyOf(editing.starts_at), todayKey)}
      />

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Sales</h1>
          <p className="text-muted-foreground">Promotions and their offers</p>
        </div>
        {canEdit && (
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="mr-2 h-4 w-4" /> New Sale
          </Button>
        )}
      </div>

      {isLoading ? (
        <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">Loading sales…</div>
      ) : sales.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <Tag className="h-8 w-8 text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">No sales yet.</p>
            {canEdit && (
              <Button variant="outline" size="sm" onClick={() => setCreateOpen(true)}>
                <Plus className="mr-2 h-4 w-4" /> Create your first sale
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="border-b border-border/50 text-left text-muted-foreground">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Sale</th>
                  <th className="px-4 py-2.5 font-medium">Dates</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {sales.map((s) => (
                  <tr
                    key={s.id}
                    className="cursor-pointer border-t border-border/40 hover:bg-muted/30"
                    onClick={() => navigate(`/marketing/sales/${s.id}`)}
                  >
                    <td className="px-4 py-3 font-medium">{s.name}</td>
                    <td className="px-4 py-3 tabular-nums text-muted-foreground">{range(s.starts_at, s.ends_at)}</td>
                    <td className="px-4 py-3">
                      {(() => {
                        const p = salePhase(s.starts_at, s.ends_at, todayKey);
                        return p ? (
                          <span className={`rounded px-2 py-0.5 text-xs capitalize ${PHASE_COLOR[p]}`}>{p}</span>
                        ) : (
                          <span className="text-xs text-muted-foreground/60">no dates</span>
                        );
                      })()}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {canEdit && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={(e) => { e.stopPropagation(); setEditing(s); }}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
