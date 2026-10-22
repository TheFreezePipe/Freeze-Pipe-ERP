# One of One markdown

Daily job that steps every unsold variant of the Shopify product **One of One
Drops** down **$10 per full week** since it was listed, stops at **50% of the
original price**, and emails the owners when a piece first hits that floor.

- Rule: `pricing.ts` (pure; see the header for the formula)
- Job: `index.ts` (reads Shopify, writes prices + state, sends the alert, logs)
- Audit log: table `one_of_one_markdown_log` (migration `20261022000006`)
- Schedule: pg_cron `one-of-one-markdown-daily`, 10:30 UTC daily

## Where the state lives

On each variant, as Shopify metafields (namespace `one_of_one`, pinned on the
variant page in admin):

| Metafield           | Meaning                                                           |
|---------------------|-------------------------------------------------------------------|
| `original_price`    | Price the clock started at. Floor = half of this.                 |
| `clock_start`       | Weeks are counted from here. Edit it to restart a piece's clock.  |
| `floor_notified_at` | When the floor email went out. Clear it to re-arm the alert.      |

Both are written on first sighting (`original_price` = live price,
`clock_start` = variant created date, or `OOO_CLOCK_NOT_BEFORE` if later).

## One-time setup (go-live)

1. **Shopify custom app** (owner does this in Shopify admin):
   Settings → Apps and sales channels → Develop apps → Create an app
   (name: `ERP one-of-one markdown`) → Configure Admin API scopes →
   tick `read_products` and `write_products` → Save → Install app →
   reveal the Admin API access token.
2. **Set the secret** on prod (owner pastes the token; never store it in git):
   ```bash
   supabase secrets set SHOPIFY_ADMIN_TOKEN=shpat_... --project-ref pnqujtugddxusllkikje
   ```
   Optional on the same command: `OOO_CLOCK_NOT_BEFORE=2026-10-22` to start
   every existing piece's clock fresh on go-live day instead of back-dating to
   its listing date (see "Clock choice" below).
3. **Apply the migration** and **deploy the function** (needs a fresh
   `SUPABASE_ACCESS_TOKEN` PAT):
   ```bash
   supabase db push --project-ref pnqujtugddxusllkikje
   supabase functions deploy one-of-one-markdown --use-api --project-ref pnqujtugddxusllkikje
   ```
4. **Dry run** (no writes, no email) with the service-role JWT:
   ```bash
   curl -s -X POST https://pnqujtugddxusllkikje.supabase.co/functions/v1/one-of-one-markdown \
     -H "Authorization: Bearer <service-role-jwt>" -H "Content-Type: application/json" \
     -d '{"dry_run":true}'
   ```
   Check `plans[]`: `action`, `newPrice`, `weeks`, `notify`.
5. **Schedule** (SQL on prod, once):
   ```sql
   SELECT cron.schedule('one-of-one-markdown-daily', '30 10 * * *',
                        $cron$SELECT public.fire_one_of_one_markdown()$cron$);
   ```

## Clock choice

With no `OOO_CLOCK_NOT_BEFORE`, the first live run back-dates every piece to
its listing date, so a piece listed six weeks ago drops $60 at once. With
`OOO_CLOCK_NOT_BEFORE=<go-live date>`, every existing piece starts at week 0
on go-live and takes its first $10 step a week later. Pieces listed after
go-live are unaffected either way (their listing date is later).

## Testing the alert email

`{"test_to":"you@example.com"}` runs the job for real (prices move) but sends
any floor alert only to that address and does not mark `floor_notified_at`,
so the real alert still fires on the next scheduled run.
