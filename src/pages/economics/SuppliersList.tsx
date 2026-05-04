import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Plus, Building2, ShieldCheck, PackageCheck, Factory } from "lucide-react";
import {
  useSuppliers,
  useCreateSupplier,
  useUpdateSupplierActive,
} from "@/lib/hooks";

/**
 * Admin suppliers directory. Add new vendor rows so they can be picked from
 * the "New Factory Order" dialog. Capability flags (is_producer / is_filler /
 * is_export_broker) control workflow routing; for "odd items" one-off vendors
 * the default (producer only) is fine.
 *
 * Does NOT create a supplier USER here — that's a separate flow (deployed
 * manually for Nancy + YX for the pilot). Adding a supplier here just lets
 * admins route orders through them.
 */
export default function SuppliersList() {
  const navigate = useNavigate();
  const { data: suppliers = [], isLoading } = useSuppliers();
  const createSupplier = useCreateSupplier();
  const updateActive = useUpdateSupplierActive();
  const [open, setOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [country, setCountry] = useState("CN");
  const [contactName, setContactName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [leadTime, setLeadTime] = useState<string>("");
  const [notes, setNotes] = useState("");
  const [isProducer, setIsProducer] = useState(true);
  const [isFiller, setIsFiller] = useState(false);
  const [isExportBroker, setIsExportBroker] = useState(false);

  function reset() {
    setCode("");
    setName("");
    setCountry("CN");
    setContactName("");
    setContactEmail("");
    setLeadTime("");
    setNotes("");
    setIsProducer(true);
    setIsFiller(false);
    setIsExportBroker(false);
    setFormError(null);
  }

  async function handleCreate() {
    setFormError(null);
    try {
      await createSupplier.mutateAsync({
        code: code.trim().toUpperCase(),
        name: name.trim(),
        country: country.trim() || "CN",
        contactName: contactName.trim() || null,
        contactEmail: contactEmail.trim() || null,
        defaultLeadTimeDays: leadTime ? parseInt(leadTime, 10) : null,
        notes: notes.trim() || null,
        isProducer,
        isFiller,
        isExportBroker,
      });
      reset();
      setOpen(false);
    } catch (err) {
      if (err instanceof Error) setFormError(err.message);
      else if (err && typeof err === "object") {
        const e = err as { message?: unknown; code?: unknown };
        if (typeof e.message === "string") setFormError(e.message);
      } else {
        setFormError("Create failed");
      }
    }
  }

  if (isLoading) return <div className="p-8 text-muted-foreground">Loading…</div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {suppliers.length} supplier{suppliers.length === 1 ? "" : "s"} ·{" "}
          {suppliers.filter((s) => s.is_active).length} active
        </p>
        <Button size="sm" onClick={() => setOpen(true)}>
          <Plus className="mr-1.5 h-4 w-4" />
          New Supplier
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                <th className="px-4 py-3">Supplier</th>
                <th className="px-3 py-3">Country</th>
                <th className="px-3 py-3">Capabilities</th>
                <th className="px-3 py-3">Contact</th>
                <th className="px-3 py-3">Lead</th>
                <th className="px-3 py-3">Status</th>
                <th className="px-3 py-3 w-28"></th>
              </tr>
            </thead>
            <tbody>
              {suppliers.map((s) => (
                <tr
                  key={s.id}
                  className={`border-b border-border/50 cursor-pointer hover:bg-muted/40 ${s.is_active ? "" : "opacity-50"}`}
                  onClick={() => navigate(`/economics/suppliers/${s.id}`)}
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <Building2 className="h-4 w-4 text-muted-foreground" />
                      <div>
                        <div className="font-medium">{s.name}</div>
                        <div className="text-[10px] font-mono text-muted-foreground">{s.code}</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-3 text-xs">{s.country}</td>
                  <td className="px-3 py-3">
                    <div className="flex flex-wrap gap-1">
                      {s.is_producer && (
                        <Badge variant="outline" className="text-[10px] border-blue-500/30 text-blue-400">
                          <Factory className="mr-1 h-2.5 w-2.5" /> producer
                        </Badge>
                      )}
                      {s.is_filler && (
                        <Badge variant="outline" className="text-[10px] border-amber-500/30 text-amber-400">
                          <PackageCheck className="mr-1 h-2.5 w-2.5" /> filler
                        </Badge>
                      )}
                      {s.is_export_broker && (
                        <Badge variant="outline" className="text-[10px] border-green-500/30 text-green-400">
                          <ShieldCheck className="mr-1 h-2.5 w-2.5" /> broker
                        </Badge>
                      )}
                    </div>
                    {s.consolidates_for.length > 0 && (
                      <div className="text-[10px] text-muted-foreground mt-1">
                        Consolidates for {s.consolidates_for.length} supplier(s)
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-3 text-xs">
                    {s.contact_name ? (
                      <>
                        <div>{s.contact_name}</div>
                        {s.contact_email && (
                          <div className="text-muted-foreground">{s.contact_email}</div>
                        )}
                      </>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-3 py-3 text-xs tabular-nums">
                    {s.default_lead_time_days ? `${s.default_lead_time_days}d` : <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="px-3 py-3">
                    <Badge
                      variant="outline"
                      className={`text-[10px] ${s.is_active ? "border-green-500/30 text-green-400" : "border-muted text-muted-foreground"}`}
                    >
                      {s.is_active ? "active" : "inactive"}
                    </Badge>
                  </td>
                  <td className="px-3 py-3 text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      disabled={updateActive.isPending}
                      onClick={(e) => {
                        e.stopPropagation();
                        updateActive.mutate({ id: s.id, isActive: !s.is_active });
                      }}
                    >
                      {s.is_active ? "Deactivate" : "Reactivate"}
                    </Button>
                  </td>
                </tr>
              ))}
              {suppliers.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-sm text-muted-foreground">
                    No suppliers yet. Click <span className="font-medium">New Supplier</span> to add one.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {/* Add supplier dialog */}
      <Dialog
        open={open}
        onOpenChange={(o) => {
          if (!o) reset();
          setOpen(o);
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Add supplier</DialogTitle>
            <DialogDescription>
              Adds a vendor to the directory so orders can be routed to them. Doesn't create a login —
              supplier portal access is a separate (and more involved) process reserved for long-term
              partners.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="grid grid-cols-[1fr_2fr] gap-3">
              <div className="space-y-1">
                <Label htmlFor="sup-code" className="text-xs">Code</Label>
                <Input
                  id="sup-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="VENDOR-A"
                  className="font-mono uppercase"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="sup-name" className="text-xs">Name</Label>
                <Input
                  id="sup-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Vendor A (Specialty)"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="sup-country" className="text-xs">Country</Label>
                <Input
                  id="sup-country"
                  value={country}
                  onChange={(e) => setCountry(e.target.value.toUpperCase())}
                  placeholder="CN"
                  maxLength={2}
                  className="font-mono"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="sup-lead" className="text-xs">Default lead time (days)</Label>
                <Input
                  id="sup-lead"
                  type="number"
                  min={0}
                  value={leadTime}
                  onChange={(e) => setLeadTime(e.target.value)}
                  placeholder="30"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="sup-contact-name" className="text-xs">Contact name</Label>
                <Input
                  id="sup-contact-name"
                  value={contactName}
                  onChange={(e) => setContactName(e.target.value)}
                  placeholder="Optional"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="sup-contact-email" className="text-xs">Contact email</Label>
                <Input
                  id="sup-contact-email"
                  type="email"
                  value={contactEmail}
                  onChange={(e) => setContactEmail(e.target.value)}
                  placeholder="Optional"
                />
              </div>
            </div>

            <div className="space-y-2 pt-1">
              <Label className="text-xs">Capabilities</Label>
              <div className="flex flex-col gap-2 rounded-md border border-border p-3 text-xs">
                <label className="flex items-center gap-2 cursor-pointer">
                  <Checkbox
                    checked={isProducer}
                    onCheckedChange={(c) => setIsProducer(c === true)}
                  />
                  <span>Producer — makes goods</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <Checkbox
                    checked={isFiller}
                    onCheckedChange={(c) => setIsFiller(c === true)}
                  />
                  <span>Filler — does fillable-product assembly</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <Checkbox
                    checked={isExportBroker}
                    onCheckedChange={(c) => setIsExportBroker(c === true)}
                  />
                  <span>Export broker — can create freight shipments to you</span>
                </label>
              </div>
            </div>

            <div className="space-y-1">
              <Label htmlFor="sup-notes" className="text-xs">Notes (optional)</Label>
              <Textarea
                id="sup-notes"
                rows={2}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Anything internal staff should know"
              />
            </div>

            {formError && <p className="text-xs text-red-400">{formError}</p>}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => { reset(); setOpen(false); }}>
              Cancel
            </Button>
            <Button
              onClick={handleCreate}
              disabled={
                !code.trim() ||
                !name.trim() ||
                createSupplier.isPending
              }
            >
              {createSupplier.isPending ? "Creating…" : "Add supplier"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
