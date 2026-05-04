/**
 * ShipStation REST API client — used for backfills, reconciliation UI,
 * and unresolved-SKU queue management from the admin side of the app.
 *
 * Real integration note: the browser NEVER calls this directly in
 * production. API credentials are kept server-side (Supabase secrets,
 * Edge Function env). The browser hits a Supabase RPC or Edge Function
 * that in turn calls this module. Exposing the API key from a browser
 * bundle would be a compliance failure — treat this like a database
 * password.
 *
 * This module is therefore designed to be called from:
 *   - Supabase Edge Functions (Deno)
 *   - Node.js scripts (backfills, one-off ops)
 *   - A thin server-side proxy if you ever introduce one
 *
 * In demo mode, there is no live ShipStation access; the unresolved-SKU
 * queue etc. shows mock data until real credentials are wired.
 */

import type { ShipStationOrder } from "./types";

export interface ShipStationClientConfig {
  apiKey: string;
  apiSecret: string;
  baseUrl?: string;
  /** Max retries for transient 5xx/429 responses. Default 4. */
  maxRetries?: number;
}

export class ShipStationClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;
  private readonly maxRetries: number;

  constructor(cfg: ShipStationClientConfig) {
    if (!cfg.apiKey || !cfg.apiSecret) {
      throw new Error("ShipStationClient requires apiKey and apiSecret");
    }
    this.baseUrl = cfg.baseUrl ?? "https://ssapi.shipstation.com";
    this.authHeader = "Basic " + btoa(`${cfg.apiKey}:${cfg.apiSecret}`);
    this.maxRetries = cfg.maxRetries ?? 4;
  }

  /** Fetch orders in a date range (inclusive). Pages through all results. */
  async listOrders(params: {
    modifyDateStart: Date;
    modifyDateEnd: Date;
    orderStatus?: ShipStationOrder["orderStatus"];
    pageSize?: number;
  }): Promise<ShipStationOrder[]> {
    const pageSize = params.pageSize ?? 100;
    const out: ShipStationOrder[] = [];
    let page = 1;
    let totalPages = 1;

    do {
      const url = new URL(`${this.baseUrl}/orders`);
      url.searchParams.set("modifyDateStart", params.modifyDateStart.toISOString());
      url.searchParams.set("modifyDateEnd", params.modifyDateEnd.toISOString());
      url.searchParams.set("pageSize", String(pageSize));
      url.searchParams.set("page", String(page));
      if (params.orderStatus) url.searchParams.set("orderStatus", params.orderStatus);

      const body = await this.get<{ orders: ShipStationOrder[]; pages: number }>(url.toString());
      out.push(...body.orders);
      totalPages = body.pages;
      page++;
    } while (page <= totalPages);

    return out;
  }

  /** Get a single order by ShipStation orderId. */
  async getOrder(orderId: number): Promise<ShipStationOrder> {
    return this.get<ShipStationOrder>(`${this.baseUrl}/orders/${orderId}`);
  }

  /** Fetch a webhook's resource_url directly — used by the webhook receiver. */
  async fetchResource(resourceUrl: string): Promise<ShipStationOrder[]> {
    const body = await this.get<{ orders?: ShipStationOrder[] } | ShipStationOrder>(resourceUrl);
    if (Array.isArray((body as { orders?: ShipStationOrder[] }).orders)) {
      return (body as { orders: ShipStationOrder[] }).orders;
    }
    return [body as ShipStationOrder];
  }

  // ---------------------------------------------------------------------------
  // Internal: GET with retry / backoff
  // ---------------------------------------------------------------------------
  private async get<T>(url: string): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const res = await fetch(url, { headers: { Authorization: this.authHeader } });
        if (res.status === 429) {
          // Respect Retry-After when present
          const retryAfter = res.headers.get("retry-after");
          const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 500 * Math.pow(2, attempt);
          await sleep(waitMs);
          continue;
        }
        if (res.status >= 500) {
          await sleep(500 * Math.pow(2, attempt));
          continue;
        }
        if (!res.ok) {
          throw new ShipStationApiError(res.status, await res.text());
        }
        return await res.json() as T;
      } catch (err) {
        lastErr = err;
        if (err instanceof ShipStationApiError && err.status < 500) throw err; // don't retry 4xx
        await sleep(500 * Math.pow(2, attempt));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error("ShipStation request exhausted retries");
  }
}

export class ShipStationApiError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string) {
    super(`ShipStation API ${status}: ${body.slice(0, 200)}`);
    this.status = status;
    this.body = body;
    this.name = "ShipStationApiError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
