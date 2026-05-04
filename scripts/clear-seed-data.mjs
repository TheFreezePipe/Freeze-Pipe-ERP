/**
 * Clears all seeded / demo inventory and transactional data from Supabase.
 * Keeps the product SKU catalog intact.
 *
 * Usage (from the project root):
 *   node scripts/clear-seed-data.mjs
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { join, dirname } from "path";

// ---------------------------------------------------------------------------
// Load .env.local manually (no dotenv dependency needed)
// ---------------------------------------------------------------------------
const __dir = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dir, "../.env.local");
const env = Object.fromEntries(
  readFileSync(envPath, "utf8")
    .split("\n")
    .filter(l => l.trim() && !l.trim().startsWith("#"))
    .map(l => {
      const idx = l.indexOf("=");
      return [l.slice(0, idx).trim(), l.slice(idx + 1).trim()];
    })
);

const SUPABASE_URL = env.VITE_SUPABASE_URL;
const SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error(
    "ERROR: SUPABASE_SERVICE_ROLE_KEY is empty in .env.local.\n" +
    "Get it from Supabase dashboard → Settings → API → service_role secret,\n" +
    "then set SUPABASE_SERVICE_ROLE_KEY=<value> in .env.local and re-run."
  );
  process.exit(1);
}

// Service-role client bypasses RLS — required for bulk deletes
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

async function run() {
  console.log("Connecting to", SUPABASE_URL);

  // 1. Zero out inventory buckets
  console.log("\n→ Zeroing inventory_levels...");
  const { error: invErr } = await supabase
    .from("inventory_levels")
    .update({
      warehouse_raw: 0,
      warehouse_in_production: 0,
      warehouse_finished: 0,
      warehouse_selling: 0,
      transit_sea: 0,
      transit_air: 0,
      on_order: 0,
    })
    .gte("id", "00000000-0000-0000-0000-000000000000"); // matches all rows
  if (invErr) { console.error("  ✗ inventory_levels:", invErr.message); }
  else { console.log("  ✓ inventory_levels zeroed"); }

  // 2. Delete transactional tables (order matters due to FK constraints)
  const tables = [
    "task_logs",
    "factory_order_items",
    "factory_orders",
    "freight_line_items",
    "freight_shipments",
    "audit_log",
    "factory_order_fulfillments",
  ];

  for (const table of tables) {
    console.log(`\n→ Truncating ${table}...`);
    const { error } = await supabase
      .from(table)
      .delete()
      .gte("id", "00000000-0000-0000-0000-000000000000");
    if (error) { console.error(`  ✗ ${table}:`, error.message); }
    else { console.log(`  ✓ ${table} cleared`); }
  }

  console.log("\n✅ Done. Reload the app — all inventory will show $0.");
}

run().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
