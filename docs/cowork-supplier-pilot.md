# Cowork prompt — seed supplier pilot data + pilot playbook

Two-part doc. Part 1 is for Cowork. Part 2 (below the fold) is your click-by-click walkthrough once seeding is done.

---

## Part 1 — Cowork task: seed pilot data

Run the SQL below via the Management API or SQL Editor. It configures Nancy and YX with the right capability flags and creates Nancy's facility as a location. It is idempotent — safe to re-run.

```sql
-- =============================================================
-- Supplier pilot seed — capability flags + Nancy's location
-- =============================================================
-- Nancy and YX already exist from migration 017. This just updates them
-- with the post-020 capability flags + consolidation wiring and adds a
-- location for Nancy's facility so koozie/consumable inventory can live
-- somewhere. Idempotent — safe to re-run.

-- Nancy: producer + filler + export broker, consolidates for YX
UPDATE suppliers
   SET is_producer       = true,
       is_filler         = true,
       is_export_broker  = true,
       consolidates_for  = ARRAY['00000000-0000-0000-0000-000000000202'::uuid]
 WHERE id = '00000000-0000-0000-0000-000000000201';

-- YX: producer only (matches "today" state; flip is_export_broker later)
UPDATE suppliers
   SET is_producer       = true,
       is_filler         = false,
       is_export_broker  = false,
       consolidates_for  = '{}'::uuid[]
 WHERE id = '00000000-0000-0000-0000-000000000202';

-- Nancy's facility as a location. Owner = Nancy. This is where her
-- consumable inventory (koozies, etc.) lives.
INSERT INTO locations (id, code, name, location_type, owner_supplier_id, country, is_default, is_active)
VALUES (
  '00000000-0000-0000-0000-000000000301',
  'NANCY-DOCK',
  'Nancy Facility (Shenzhen)',
  'supplier_warehouse',  -- actual location_type value accepted by the CHECK constraint (verified on deploy)
  '00000000-0000-0000-0000-000000000201',
  'CN',
  false,
  true
)
ON CONFLICT (id) DO UPDATE
  SET owner_supplier_id = EXCLUDED.owner_supplier_id,
      is_active = true;

-- Verify the seed took
SELECT code, name, is_producer, is_filler, is_export_broker, consolidates_for
  FROM suppliers
 WHERE code IN ('NANCY', 'YX')
 ORDER BY code;

SELECT id, code, name, owner_supplier_id
  FROM locations
 WHERE owner_supplier_id IS NOT NULL;
```

Paste back the output of both `SELECT` statements so I can verify.

**Note**: initial draft used `'supplier_facility'` which the CHECK rejected. The deployed seed uses `'supplier_warehouse'` — the value accepted by `locations.location_type`'s CHECK. If you're redeploying to a fresh project and that constraint ever changes, update this accordingly.

---

## Part 2 — Pilot playbook (for the user, not Cowork)

### Prereqs
- [ ] Cowork seed SQL above ran successfully.
- [ ] Dev server running locally: `npm run dev`.
- [ ] Environment pointed at staging (`VITE_APP_ENV=staging`, real `VITE_SUPABASE_URL` + anon key). Not demo mode.

### Happy-path exercise — ~15 minutes

**Step 1 — Log in as admin and invite Nancy as a supplier user.**
1. Navigate to `/settings` → User Management.
2. Click **Invite Supplier User** (top right).
3. Fill in:
   - Email: a real mailbox you can access (use a `+nancy` alias to keep testing isolated, e.g. `chase+nancy@freezepipe.com`)
   - Full name: `Nancy Test`
   - Supplier: **NANCY · Nancy (Glass)**
4. Click **Send invite**. Expect a magic-link email within 30 seconds.

**Step 2 — Accept the invite in a private/incognito window.**
1. Click the magic link from the email. Supabase will finalize the account and redirect to the app.
2. You should land on `/supplier` (auto-routed because `role = 'supplier'`).
3. The sidebar should show **Supplier Portal** with 5 items (Overview, Factory Orders, Shipments, Breakage, Variances) and nothing else.

**Step 3 — Invite YX the same way** (new private window, new email alias). Pick supplier **YX · YX (Hardware)**.

**Step 4 — From the YX window, create a factory order.**
1. `/supplier/orders` → **New Order**.
2. Expected completion: 30 days out (pre-filled).
3. Add one line: pick a coil SKU (e.g., BW21P) with quantity 500.
4. **Create Order**. Expect toast + redirect to the order detail page.
5. On the detail page, click **Advance** to move `ordered → in_production`. No notes needed.
6. Click **Advance** again to move `in_production → finished`. Add a note like "Off the line."

**Step 5 — From the Nancy window, receive the YX order.**
1. `/supplier/orders`. Nancy should see the YX order (because `consolidates_for` contains YX).
2. Click into it. You should see a **Receive** panel (which YX did NOT see).
3. Enter: Confirmed = 498, Breakage = 2, Reason = `crushed_in_transit`, Description = "Corner carton crushed."
4. **Submit receive**. Expect a toast mentioning "1 breakage report auto-opened."

**Step 6 — From the YX window, check Breakage.**
1. Refresh `/supplier/breakage` (or wait for the query to refetch).
2. Under **Filed against you**, the breakage report from Nancy should appear with status `open`.
3. Click **Respond** → **Acknowledge**. Status flips to `acknowledged`.

**Step 7 — From the Nancy window, create a shipment.**
1. `/supplier/shipments/new`.
2. Carrier: DHL. Tracking #: `TEST-123` (optional at this stage). ETA: 30 days out. Total cartons: 40.
3. Add one line: pick the same coil SKU, quantity 498 (what Nancy actually received).
4. **Create Shipment**. Redirect to list. Status should be `pending`.

**Step 8 — Verify admin can see all of this.**
1. Back to your admin window.
2. `/supplier` (admins are allowed). Counters should reflect what you just created.
3. `/supplier/orders` shows the YX order.
4. `/supplier/breakage` shows the acknowledged report.

### What to look for (bugs / rough edges)

- **SKU picker is empty** on a create form → RLS is filtering them out. Supplier needs at least one link to the SKU (either via BOM or an existing factory order). If you hit this, report which form + supplier.
- **Advance button does nothing / spins forever** → check the browser console for the RPC response envelope. Most likely `version_conflict` (stale cache) or `invalid_transition`.
- **Breakage dialog doesn't close after Acknowledge** → React Query invalidation not wired. Minor; report it.
- **Nancy doesn't see YX's order** → `consolidates_for` seed didn't take. Check with:
  ```sql
  SELECT code, consolidates_for FROM suppliers;
  ```
  Nancy's row should have YX's UUID in the array.
- **Invite email doesn't arrive** → check Supabase Auth email rate limits + that the recipient isn't in spam.

### If you want to clean up after the pilot

```sql
-- Deactivate test supplier users (auth rows left intact — don't delete)
UPDATE profiles SET is_active = false
 WHERE email ILIKE 'chase+nancy@%' OR email ILIKE 'chase+yx@%';

-- Remove pilot factory orders + shipments (cascade clears items/lines)
DELETE FROM factory_orders   WHERE notes IN ('Off the line.', 'Q2 run', 'Idempotency test');
DELETE FROM freight_shipments WHERE tracking_number = 'TEST-123';
```

### What you're NOT testing in this pass

- Admin `rpc_resolve_shipment_variance` / `rpc_resolve_breakage_report` — no admin resolution UI yet, that'd be a separate pass.
- Consolidator breakage filing via standalone `/supplier/breakage` button — today reports only auto-open during receive.
- Replacement-FO linkage on resolve.
- Internal cost/duty flowing into the supplier-declared shipment (receiver fills on delivery).

Flag any bugs you find and we'll triage into another batch.
