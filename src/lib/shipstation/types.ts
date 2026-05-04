/**
 * Types mirroring the relevant slice of the ShipStation REST API.
 * Docs: https://www.shipstation.com/docs/api/
 *
 * Only fields we consume are included. When adding more, lean toward
 * `| null` rather than optional — ShipStation returns nulls explicitly.
 */

export interface ShipStationOrder {
  orderId: number;
  orderNumber: string;
  orderKey: string | null;
  orderDate: string;              // ISO 8601
  shipDate: string | null;
  orderStatus: "awaiting_payment" | "awaiting_shipment" | "shipped" | "on_hold" | "cancelled";
  customerEmail: string | null;
  customerUsername: string | null;
  orderTotal: number;             // dollars
  amountPaid: number;
  taxAmount: number;
  shippingAmount: number;
  internalNotes: string | null;
  customerNotes: string | null;
  gift: boolean;
  advancedOptions?: {
    storeId?: number;
    source?: string;
    customField1?: string | null;
  };
  items: ShipStationLineItem[];
}

export interface ShipStationLineItem {
  orderItemId: number;
  lineItemKey: string | null;
  sku: string;
  name: string;
  imageUrl: string | null;
  weight: { value: number; units: string } | null;
  quantity: number;
  unitPrice: number;
  taxAmount: number;
  shippingAmount: number;
  productId: number | null;
  fulfillmentSku: string | null;
  adjustment: boolean;
  upc: string | null;
}

export type ShipStationWebhookEventType =
  | "ORDER_NOTIFY"
  | "ITEM_ORDER_NOTIFY"
  | "SHIP_NOTIFY"
  | "ITEM_SHIP_NOTIFY";

export interface ShipStationWebhookPayload {
  resource_url: string;
  resource_type: ShipStationWebhookEventType;
}
