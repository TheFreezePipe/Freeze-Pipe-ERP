// =============================================================
// Charley T video summary (Supabase Edge Function)
// =============================================================
// Watches Professor Charley T's YouTube channel (@CTtheDisrupter) for new
// long-form videos, pulls the transcript via Supadata, summarizes it with
// Claude (summary / tips / action items for the Freeze Pipe owners), and
// emails the result via Resend. Fired hourly by pg_cron
// (public.fire_youtube_summary).
//
// The feed used is the hidden "UULF" long-form-only playlist feed, which
// excludes Shorts and livestreams at the source.
//
// Double-send safety rests on two layers:
//   1. Claim-before-work: a video is claimed in the table (with its attempt
//      counted) before anything runs, so overlapping invocations can't both
//      process it, and a crashed run still consumed an attempt.
//   2. Resend Idempotency-Key (yt-summary/<video_id>): the summary payload
//      is durably stored BEFORE the first send attempt and reused verbatim
//      on retries, so within Resend's 24h idempotency window a retried send
//      of an already-delivered email returns the original response instead
//      of a duplicate. A 409 invalid_idempotent_request (payload drifted,
//      e.g. recipients changed between attempts) is treated as
//      already-sent, never re-sent.
//
// State machine (youtube_video_summaries.status):
//   (unseen)      -> processing    claimed (INSERT, attempts=1; PK conflict = lost race, skip)
//   seeded                         in the feed when the watcher launched; never emailed
//   pending_retry -> processing    re-claimed (conditional UPDATE, attempts+1; 0 rows = lost race)
//   processing    -> sending       summary durably stored + about to call Resend
//                                  (this write is VERIFIED; if it fails, no send happens)
//   sending       -> sent          Resend accepted (or idempotent replay)
//   any claim stale >2h            crashed run -> swept back to pending_retry
//                                  (safe: attempts already counted, sends idempotent)
//   processing/sending -> pending_retry   a step failed; retried with backoff
//   pending_retry -> gave_up       retry budget exhausted
//
// Retry budget: transcript-unavailable gives up after 24 attempts (captions
// are never coming); everything else after 40. Backoff: hourly for the
// first 6 attempts, then every 6h, then every 12h — the 12h ceiling is
// deliberately half of Resend's 24h idempotency window so retried sends
// always dedupe. Attempts are counted at claim time, so even a run that
// crashes mid-flight consumes budget.
//
// Body params (all optional):
//   { }                          -> normal hourly run
//   { "dry_run": true }          -> no DB writes, no emails; returns rendered
//                                   output for up to 1 candidate
//   { "video_id": "abc123",      -> force-process one specific video as a TEST:
//     "test_to": "x@y.com" }        emails only test_to, never touches the DB.
//                                   video_id requires test_to or dry_run (400
//                                   otherwise), and test_to requires video_id.
//
// Worst-case wall time: feed 15s + Supadata 60s + Claude 180s (maxRetries 0
// — the state machine owns retries) + Resend 30s ≈ 290s, under the ~400s
// edge-function limit with headroom for DB round-trips.
//
// Secrets used: SUPADATA_API_KEY, ANTHROPIC_API_KEY, RESEND_API_KEY
// (required); REPORT_FROM, YT_SUMMARY_TO, ANTHROPIC_MODEL (optional).
// Note: ANTHROPIC_MODEL must not be set to claude-fable-5 (needs
// refusal-fallback handling this function doesn't implement).
// =============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Anthropic from "https://esm.sh/@anthropic-ai/sdk@0.112.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const SUPADATA_API_KEY = Deno.env.get("SUPADATA_API_KEY") ?? "";
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const ANTHROPIC_MODEL = Deno.env.get("ANTHROPIC_MODEL") ?? "claude-opus-4-8";
const REPORT_FROM = Deno.env.get("REPORT_FROM") ?? "Freeze Pipe ERP <reports@freezepipeinventory.com>";

const CHANNEL_NAME = "Professor Charley T";
const CHANNEL_ID = "UC3kl2OhNRZ1rH_4bnd0Ap7g"; // youtube.com/@CTtheDisrupter
// UULF<id> = the channel's long-form uploads playlist (no Shorts/livestreams).
const FEED_URL = `https://www.youtube.com/feeds/videos.xml?playlist_id=UULF${CHANNEL_ID.slice(2)}`;

const RECIPIENTS = (Deno.env.get("YT_SUMMARY_TO") ?? "sean@thefreezepipe.com,mike@thefreezepipe.com")
  .split(",").map((s) => s.trim()).filter(Boolean);

const MAX_TRANSCRIPT_ATTEMPTS = 24;
const MAX_TOTAL_ATTEMPTS = 40;
const STALE_CLAIM_MS = 2 * 60 * 60 * 1000;
// One video per invocation; the hourly cadence absorbs bursts.
const PER_RUN_LIMIT = 1;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// ---- shared helpers (same shapes as daily-report) ----
const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

// XML entity decode; &amp; must be decoded LAST or "&amp;lt;" double-decodes.
const unxml = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&amp;/g, "&");

function jwtRole(authHeader: string | null): string | null {
  const token = (authHeader ?? "").replace(/^Bearer\s+/i, "");
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    return (JSON.parse(atob(b64)) as { role?: string }).role ?? null;
  } catch {
    return null;
  }
}

// Error taxonomy — drives the state machine's failure transitions.
class RetriableError extends Error {}
class TranscriptUnavailableError extends RetriableError {}
class AlreadySentError extends Error {}

// ---- feed ----
interface VideoRef { videoId: string; title: string; publishedAt: string | null; }

async function fetchFeed(): Promise<VideoRef[]> {
  const resp = await fetch(FEED_URL, {
    headers: { "Accept": "application/atom+xml" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`feed fetch failed: HTTP ${resp.status}`);
  const xml = await resp.text();
  const entries: VideoRef[] = [];
  for (const block of xml.split("<entry>").slice(1)) {
    const videoId = block.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1];
    const title = block.match(/<title>([^<]*)<\/title>/)?.[1];
    const publishedAt = block.match(/<published>([^<]+)<\/published>/)?.[1] ?? null;
    if (videoId) entries.push({ videoId, title: unxml(title ?? "(untitled)"), publishedAt });
  }
  // This channel always has uploads; 0 entries means the parse broke (layout
  // change, consent interstitial). Erroring keeps the seed gate from
  // misfiring and the run harmlessly retries next hour.
  if (!entries.length) throw new Error("feed parsed to 0 entries — treating as fetch failure");
  return entries;
}

// Title lookup for force-processing a video that's no longer in the feed.
async function fetchOembedTitle(videoId: string): Promise<string | null> {
  try {
    const resp = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}&format=json`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!resp.ok) return null;
    return ((await resp.json()) as { title?: string }).title ?? null;
  } catch {
    return null;
  }
}

// ---- transcript (Supadata) ----
async function fetchTranscript(videoId: string): Promise<string> {
  const resp = await fetch(
    `https://api.supadata.ai/v1/youtube/transcript?videoId=${encodeURIComponent(videoId)}&text=true`,
    { headers: { "x-api-key": SUPADATA_API_KEY }, signal: AbortSignal.timeout(60_000) },
  );
  // 206 = no transcript yet. Fresh uploads take a while to get auto-captions,
  // so this retries; a video with captions disabled gives up at 24 attempts.
  if (resp.status === 206) throw new TranscriptUnavailableError("transcript not yet available (Supadata 206)");
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new RetriableError(`Supadata HTTP ${resp.status}: ${body.slice(0, 300)}`);
  }
  const data = (await resp.json()) as { content?: unknown };
  const text = typeof data.content === "string"
    ? data.content
    : Array.isArray(data.content)
      ? (data.content as { text?: string }[]).map((c) => c.text ?? "").join(" ")
      : "";
  if (!text.trim()) throw new TranscriptUnavailableError("Supadata returned an empty transcript");
  return text;
}

// ---- summary (Claude) ----
interface Summary { summary: string; tips: string[]; action_items: string[]; }

const SUMMARY_SCHEMA = {
  type: "object",
  properties: {
    summary: {
      type: "string",
      description: "2-4 short paragraphs (separated by blank lines) covering what the video argues and any key numbers or claims.",
    },
    tips: {
      type: "array",
      items: { type: "string" },
      description: "Each concrete tip or recommendation Charley gives, as a standalone sentence. Empty if none.",
    },
    action_items: {
      type: "array",
      items: { type: "string" },
      description: "Specific things The Freeze Pipe team should consider doing based on this video — imperative voice, most impactful first. Empty if none.",
    },
  },
  required: ["summary", "tips", "action_items"],
  additionalProperties: false,
} as const;

const anthropic = new Anthropic({
  apiKey: ANTHROPIC_API_KEY || "unset",
  maxRetries: 0, // the state machine owns retries; keeps wall time bounded
  timeout: 180_000, // ms — a 90-min transcript summarization can run long
});

async function summarize(title: string, transcript: string): Promise<Summary> {
  // ~350k chars ≈ 90k tokens — far above any real video, well inside context.
  const clipped = transcript.length > 350_000 ? transcript.slice(0, 350_000) : transcript;
  let resp: Anthropic.Message;
  try {
    resp = await anthropic.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: 8000,
      system:
        "You summarize new YouTube videos from Professor Charley T (Charley Tichenor, Disrupter School) — a Meta/Facebook ads expert — " +
        "for Sean and Mike, the owners of The Freeze Pipe, an e-commerce brand selling freezable glass bongs and pipes. " +
        "They run their own Meta ads and follow Charley's methodology. They read this in email; be concrete and skimmable, no fluff. " +
        "Note: as a smoking-products brand they face ad-policy restrictions, so flag when a tactic may not apply to restricted verticals.",
      messages: [{
        role: "user",
        content: `Video title: ${title}\n\nFull transcript (auto-captions, may have transcription errors):\n\n${clipped}`,
      }],
      output_config: { format: { type: "json_schema", schema: SUMMARY_SCHEMA } },
    });
  } catch (e) {
    throw new RetriableError(`Claude API: ${String(e).slice(0, 300)}`);
  }
  if (resp.stop_reason === "max_tokens") throw new RetriableError("Claude output truncated (max_tokens)");
  if (resp.stop_reason === "refusal") throw new RetriableError("Claude refused the request");
  const text = resp.content.find((b) => b.type === "text")?.text ?? "";
  try {
    // Structured outputs guarantee schema-valid JSON on a normal stop.
    return JSON.parse(text) as Summary;
  } catch {
    throw new RetriableError(`Claude returned unparseable output: ${text.slice(0, 200)}`);
  }
}

// ---- email ----
const FONT = "'Lato',-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
const SERIF = "'Minion Pro','Minion Pro Bold','Adobe Garamond Pro',Georgia,'Times New Roman',serif";
const INK = "#0C0C0C", CARD = "#161616", BORD = "#2A2A2A";
const WHITE = "#FFFFFF", SEC = "#C9C9C9", TER = "#8C8C8C";
const BLUE = "#28A4F8", GREEN = "#36C88D";
const EYEBROW = `font-family:${FONT};font-size:12px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:${BLUE};`;

function renderList(label: string, items: string[], marker: string, markerColor: string): string {
  if (!items.length) return "";
  const rows = items.map((it) => `
    <tr>
      <td style="font-family:${FONT};font-size:14px;color:${markerColor};font-weight:700;padding:5px 10px 5px 0;vertical-align:top;">${marker}</td>
      <td style="font-family:${FONT};font-size:14px;color:${SEC};line-height:1.55;padding:5px 0;">${esc(it)}</td>
    </tr>`).join("");
  return `
    <div style="${EYEBROW}margin:28px 0 10px;">${label}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>`;
}

function renderHtml(v: VideoRef, s: Summary): string {
  const watchUrl = `https://www.youtube.com/watch?v=${v.videoId}`;
  const when = v.publishedAt
    ? new Date(v.publishedAt).toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "long", month: "long", day: "numeric" })
    : "";
  const paragraphs = s.summary.split(/\n{2,}/).map((p) =>
    `<p style="font-family:${FONT};font-size:14px;color:${SEC};line-height:1.6;margin:0 0 12px;">${esc(p.trim())}</p>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link href="https://fonts.googleapis.com/css2?family=Lato:wght@400;700;900&display=swap" rel="stylesheet"></head>
<body style="margin:0;padding:0;background:${INK};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${INK};">
  <tr><td align="center" style="padding:24px 12px;">
    <table role="presentation" width="640" cellpadding="0" cellspacing="0" style="width:640px;max-width:640px;background:${CARD};border:1px solid ${BORD};border-radius:10px;">
      <tr><td style="padding:26px 28px 30px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-bottom:1px solid ${BORD};">
          <tr><td style="padding-bottom:16px;">
            <div style="${EYEBROW}">Charley T &middot; New Video</div>
            <div style="font-family:${SERIF};font-size:24px;font-weight:700;color:${WHITE};line-height:1.3;margin-top:8px;">${esc(v.title)}</div>
            <div style="font-family:${FONT};font-size:13px;color:${TER};margin-top:6px;">${esc(when)}${when ? " &middot; " : ""}<a href="${watchUrl}" style="color:${BLUE};text-decoration:none;">Watch on YouTube</a></div>
          </td></tr>
        </table>
        <div style="${EYEBROW}margin:24px 0 10px;">Summary</div>
        ${paragraphs}
        ${renderList("Tips from the video", s.tips, "&bull;", BLUE)}
        ${renderList("Action items for Freeze Pipe", s.action_items, "&#8594;", GREEN)}
        <div style="border-top:1px solid ${BORD};margin-top:28px;padding-top:14px;font-family:${FONT};font-size:12px;color:${TER};">
          Automated summary of <a href="${watchUrl}" style="color:${BLUE};text-decoration:none;">this video</a> from ${esc(CHANNEL_NAME)}'s channel. Generated by the Freeze Pipe ERP.
        </div>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

async function sendEmail(to: string[], subject: string, html: string, idempotencyKey: string): Promise<string | null> {
  let resp: Response;
  try {
    resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({ from: REPORT_FROM, to, subject, html }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    // Network failure / timeout: delivery unknown, but the idempotency key
    // makes a retry safe — a duplicate POST replays the original response.
    throw new RetriableError(`Resend call failed: ${String(e).slice(0, 200)}`);
  }
  const result = await resp.json().catch(() => ({} as { id?: string; name?: string }));
  // Same key, different payload: an email for this video already went out
  // (payload drifted, e.g. recipients changed between attempts). Never resend.
  if (resp.status === 409 && (result as { name?: string }).name === "invalid_idempotent_request") {
    throw new AlreadySentError("Resend idempotency conflict — treating as already sent");
  }
  if (!resp.ok) throw new RetriableError(`Resend HTTP ${resp.status}: ${JSON.stringify(result).slice(0, 300)}`);
  return (result as { id?: string }).id ?? null;
}

// ---- main ----
Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  if (jwtRole(req.headers.get("Authorization")) !== "service_role") {
    return json({ error: "forbidden - service role required" }, 403);
  }

  let opts: { dry_run?: boolean; test_to?: string | string[]; video_id?: string } = {};
  try { opts = await req.json(); } catch { /* empty body ok */ }

  if (opts.test_to && !opts.video_id) {
    return json({ ok: false, error: "test_to requires video_id — a test invocation must target one specific video" }, 400);
  }
  if (opts.video_id && !opts.test_to && !opts.dry_run) {
    return json({ ok: false, error: "video_id is a test/preview mode — pair it with test_to or dry_run" }, 400);
  }

  const missing = [
    !SUPADATA_API_KEY && "SUPADATA_API_KEY",
    !ANTHROPIC_API_KEY && "ANTHROPIC_API_KEY",
    !RESEND_API_KEY && !opts.dry_run && "RESEND_API_KEY",
  ].filter(Boolean);
  if (missing.length) return json({ ok: false, error: `missing secrets: ${missing.join(", ")}` }, 500);

  // ---- forced test mode: never touches the database ----
  if (opts.video_id) {
    try {
      const feed = await fetchFeed().catch(() => [] as VideoRef[]);
      const v: VideoRef = feed.find((f) => f.videoId === opts.video_id) ?? {
        videoId: opts.video_id,
        title: (await fetchOembedTitle(opts.video_id)) ?? "(YouTube video)",
        publishedAt: null,
      };
      const transcript = await fetchTranscript(v.videoId);
      const summary = await summarize(v.title, transcript);
      const html = renderHtml(v, summary);
      const subject = `Charley T: ${v.title}`;
      if (opts.dry_run) return json({ ok: true, mode: "test-dry-run", subject, summary, html });
      const to = Array.isArray(opts.test_to) ? opts.test_to! : [opts.test_to!];
      // Unique key per test invocation: tests never collide with the real
      // send's key, and re-running a test actually re-sends (the payload is
      // regenerated each time, so a stable key would 409 on the second run).
      const resendId = await sendEmail(to, subject, html, `yt-summary-test/${v.videoId}/${Date.now()}`);
      return json({ ok: true, mode: "test-send", sent_to: to, resend_id: resendId, subject });
    } catch (e) {
      return json({ ok: false, mode: "test", error: String(e).slice(0, 400) }, 500);
    }
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const nowIso = () => new Date().toISOString();

  let feed: VideoRef[] = [];
  try {
    feed = await fetchFeed();
  } catch (e) {
    // Transient feed failures are fine — the next hourly run recovers.
    return json({ ok: false, stage: "feed", error: String(e).slice(0, 300) }, 502);
  }

  const swept: Record<string, number> = {};
  if (!opts.dry_run) {
    // Recover claims from crashed runs. Safe to retry in both states: the
    // attempt was counted at claim time, and any send that may have gone out
    // is shielded by the per-video idempotency key.
    const staleCutoff = new Date(Date.now() - STALE_CLAIM_MS).toISOString();
    const { data: stale } = await admin.from("youtube_video_summaries")
      .update({ status: "pending_retry", error: "recovered: previous run crashed mid-processing" })
      .in("status", ["processing", "sending"]).lt("last_attempt_at", staleCutoff).select("video_id");
    swept.recovered = stale?.length ?? 0;
  }

  // First run: seed the whole current feed so the backlog is never emailed.
  const { count, error: cntErr } = await admin
    .from("youtube_video_summaries").select("*", { count: "exact", head: true });
  if (cntErr) return json({ ok: false, stage: "count", error: cntErr.message }, 500);
  let seeded = 0;
  if ((count ?? 0) === 0) {
    if (opts.dry_run) {
      return json({ ok: true, dry_run: true, would_seed: feed.length, note: "first real run will seed these without emailing" });
    }
    const rows = feed.map((v) => ({
      video_id: v.videoId,
      title: v.title,
      video_url: `https://www.youtube.com/watch?v=${v.videoId}`,
      published_at: v.publishedAt,
      status: "seeded",
    }));
    const { error } = await admin.from("youtube_video_summaries")
      .upsert(rows, { onConflict: "video_id", ignoreDuplicates: true });
    if (error) return json({ ok: false, stage: "seed", error: error.message }, 500);
    seeded = rows.length;
    return json({ ok: true, seeded, note: "bootstrap complete — future uploads will be summarized" });
  }

  // Candidates: unseen feed videos first (the feature's whole point), then
  // backoff-eligible retries — including ones that have dropped out of the
  // 15-entry feed window, which are recovered from the table itself.
  const feedIds = feed.map((v) => v.videoId);
  const { data: known, error: knownErr } = await admin
    .from("youtube_video_summaries").select("video_id").in("video_id", feedIds);
  if (knownErr) return json({ ok: false, stage: "known", error: knownErr.message }, 500);
  const knownIds = new Set((known ?? []).map((r) => r.video_id));
  const fresh = feed
    .filter((v) => !knownIds.has(v.videoId))
    .sort((a, b) => (a.publishedAt ?? "").localeCompare(b.publishedAt ?? ""));

  const { data: retryRows, error: retryErr } = await admin
    .from("youtube_video_summaries")
    .select("video_id, title, published_at, attempts, last_attempt_at, summary, transcript_chars")
    .eq("status", "pending_retry")
    .order("last_attempt_at", { ascending: true });
  if (retryErr) return json({ ok: false, stage: "retries", error: retryErr.message }, 500);

  const backoffReady = (attempts: number, lastAttempt: string | null): boolean => {
    if (!lastAttempt) return true;
    // Max tier is 12h, deliberately HALF of Resend's 24h idempotency-key
    // TTL: a retried send always lands inside the dedupe window, so a
    // delivered-but-unrecorded email can never be sent twice.
    const hours = attempts < 6 ? 1 : attempts < 12 ? 6 : 12;
    // 5-minute slack so hourly cron jitter doesn't skip a whole cycle.
    return Date.now() - Date.parse(lastAttempt) >= hours * 3_600_000 - 300_000;
  };
  const retries = (retryRows ?? [])
    .filter((r) => backoffReady(r.attempts, r.last_attempt_at))
    .map((r) => ({
      ref: { videoId: r.video_id, title: r.title, publishedAt: r.published_at } as VideoRef,
      attempts: r.attempts,
      priorSummary: (r.summary ?? null) as Summary | null,
      priorChars: (r.transcript_chars ?? null) as number | null,
    }));

  type Candidate = {
    ref: VideoRef; attempts: number; isNew: boolean;
    priorSummary?: Summary | null; priorChars?: number | null;
  };
  const candidates: Candidate[] = [
    ...fresh.map((ref) => ({ ref, attempts: 0, isNew: true })),
    ...retries.map((r) => ({ ...r, isNew: false })),
  ].slice(0, PER_RUN_LIMIT);

  const processed: Record<string, unknown>[] = [];
  for (const c of candidates) {
    const v = c.ref;
    const attempts = c.attempts + 1;
    const base = {
      video_id: v.videoId,
      title: v.title,
      video_url: `https://www.youtube.com/watch?v=${v.videoId}`,
      published_at: v.publishedAt,
    };

    // Claim the video (counting the attempt) before doing any work, so
    // overlapping runs can never both process it and a crashed run still
    // consumes retry budget.
    if (!opts.dry_run) {
      if (c.isNew) {
        const { error } = await admin.from("youtube_video_summaries")
          .insert({ ...base, status: "processing", attempts, last_attempt_at: nowIso() });
        if (error) {
          // 23505 = another run claimed it first; anything else is reported.
          if (error.code !== "23505") processed.push({ video_id: v.videoId, claim_error: error.message });
          continue;
        }
      } else {
        const { data, error } = await admin.from("youtube_video_summaries")
          .update({ status: "processing", attempts, last_attempt_at: nowIso() })
          .eq("video_id", v.videoId).eq("status", "pending_retry").select("video_id");
        if (error || !data?.length) continue; // lost the race or transient error — next run retries
      }
    }

    const failTo = async (status: string, error: string) => {
      if (!opts.dry_run) {
        await admin.from("youtube_video_summaries")
          .update({ status, error: error.slice(0, 500), last_attempt_at: nowIso() })
          .eq("video_id", v.videoId);
      }
      processed.push({ video_id: v.videoId, sent: false, status, error: error.slice(0, 300) });
    };

    try {
      // Reuse a previously-stored summary (from a failed send attempt) so
      // retried sends are byte-identical — required for idempotent dedupe —
      // and don't burn another Supadata credit / Claude call.
      let summary = c.priorSummary ?? null;
      let transcriptChars = c.priorChars ?? null;
      if (!summary) {
        const transcript = await fetchTranscript(v.videoId);
        transcriptChars = transcript.length;
        summary = await summarize(v.title, transcript);
      }
      const html = renderHtml(v, summary);
      const subject = `Charley T: ${v.title}`;

      if (opts.dry_run) {
        processed.push({ video_id: v.videoId, dry_run: true, subject, recipients: RECIPIENTS, summary, html });
        continue;
      }

      // Durably store the payload and mark the send window BEFORE calling
      // Resend. This write is verified: if it didn't land, we don't send —
      // the never-double-email guarantee depends on this marker existing.
      const { data: marked, error: markErr } = await admin.from("youtube_video_summaries")
        .update({ status: "sending", summary, transcript_chars: transcriptChars, last_attempt_at: nowIso() })
        .eq("video_id", v.videoId).select("video_id");
      if (markErr || !marked?.length) {
        await failTo("pending_retry", `could not record 'sending' marker: ${markErr?.message ?? "0 rows matched"}`);
        continue;
      }

      const resendId = await sendEmail(RECIPIENTS, subject, html, `yt-summary/${v.videoId}`);

      const { error: recErr } = await admin.from("youtube_video_summaries").update({
        status: "sent",
        email_to: RECIPIENTS,
        resend_id: resendId,
        error: null,
        processed_at: nowIso(),
        last_attempt_at: nowIso(),
      }).eq("video_id", v.videoId);
      // If this bookkeeping write fails the row stays 'sending'; the stale
      // sweep retries it later and the idempotency key absorbs the re-send.
      processed.push({ video_id: v.videoId, sent: true, resend_id: resendId, ...(recErr ? { record_error: recErr.message } : {}) });
    } catch (e) {
      if (e instanceof AlreadySentError) {
        if (!opts.dry_run) {
          await admin.from("youtube_video_summaries").update({
            status: "sent", email_to: RECIPIENTS, error: String(e).slice(0, 500),
            processed_at: nowIso(), last_attempt_at: nowIso(),
          }).eq("video_id", v.videoId);
        }
        processed.push({ video_id: v.videoId, sent: true, note: "idempotency conflict — original send already delivered" });
      } else if (e instanceof TranscriptUnavailableError) {
        await failTo(attempts >= MAX_TRANSCRIPT_ATTEMPTS ? "gave_up" : "pending_retry", String(e));
      } else {
        await failTo(attempts >= MAX_TOTAL_ATTEMPTS ? "gave_up" : "pending_retry", String(e));
      }
    }
  }

  return json({
    ok: true,
    feed_size: feed.length,
    new_videos: fresh.length,
    retries_eligible: retries.length,
    ...swept,
    processed,
  });
});
