import {GoogleAuth, type JWTInput} from "google-auth-library";
import {PLAY_SCOPE, PLAY_SERVICE_ACCOUNT_SECRET} from "./subscription";

const API = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications";

export type PlayErrorCode =
  | "invalid-token"
  | "not-found"
  | "failed-precondition"
  | "unavailable"
  | "internal";

export class PlayApiError extends Error {
  readonly status: number;
  readonly code: PlayErrorCode;

  constructor(status: number, code: PlayErrorCode) {
    super(`play api ${status}`);
    this.name = "PlayApiError";
    this.status = status;
    this.code = code;
  }
}

export interface PlayLineItem {
  productId: string;
  expiryTimeMs: number;
}

export interface PlaySubscription {
  subscriptionState: string;
  acknowledgementState: string;
  latestOrderId?: string;
  linkedPurchaseToken?: string;
  testPurchase: boolean;
  lineItems: PlayLineItem[];
}

export interface VoidedPurchase {
  purchaseToken: string;
  orderId?: string;
}

export interface PlayClient {
  getSubscription(packageName: string, purchaseToken: string): Promise<PlaySubscription>;
  acknowledge(packageName: string, productId: string, purchaseToken: string): Promise<void>;
  listVoided(packageName: string, startTimeMillis: number): Promise<VoidedPurchase[]>;
}

export interface PlayClientDeps {
  fetchImpl?: typeof fetch;
  accessToken?: () => Promise<string>;
}

function mapStatus(status: number): PlayApiError {
  if (status === 400) return new PlayApiError(status, "invalid-token");
  if (status === 404) return new PlayApiError(status, "not-found");
  if (status === 401 || status === 403) return new PlayApiError(status, "failed-precondition");
  if (status === 408 || status === 429 || status >= 500) {
    return new PlayApiError(status, "unavailable");
  }
  return new PlayApiError(status, "internal");
}

async function defaultAccessToken(): Promise<string> {
  const raw = process.env[PLAY_SERVICE_ACCOUNT_SECRET];
  let auth: GoogleAuth;
  if (raw && raw.trim().length > 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new PlayApiError(401, "failed-precondition");
    }
    if (!parsed || typeof parsed !== "object") throw new PlayApiError(401, "failed-precondition");
    const record = parsed as {client_email?: unknown; private_key?: unknown};
    if (typeof record.client_email !== "string" || typeof record.private_key !== "string") {
      throw new PlayApiError(401, "failed-precondition");
    }
    const credentials: JWTInput = {
      client_email: record.client_email,
      private_key: record.private_key,
    };
    auth = new GoogleAuth({credentials, scopes: [PLAY_SCOPE]});
  } else {
    auth = new GoogleAuth({scopes: [PLAY_SCOPE]});
  }
  const token = await auth.getAccessToken();
  if (!token) throw new PlayApiError(401, "failed-precondition");
  return token;
}

function parseSubscription(body: string): PlaySubscription {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new PlayApiError(200, "internal");
  }
  if (!parsed || typeof parsed !== "object") throw new PlayApiError(200, "internal");
  const raw = parsed as {
    subscriptionState?: unknown;
    acknowledgementState?: unknown;
    latestOrderId?: unknown;
    linkedPurchaseToken?: unknown;
    testPurchase?: unknown;
    lineItems?: unknown;
  };
  if (typeof raw.subscriptionState !== "string") throw new PlayApiError(200, "internal");
  const lineItems: PlayLineItem[] = [];
  if (Array.isArray(raw.lineItems)) {
    for (const item of raw.lineItems) {
      if (!item || typeof item !== "object") continue;
      const row = item as {productId?: unknown; expiryTime?: unknown};
      if (typeof row.productId !== "string" || typeof row.expiryTime !== "string") continue;
      const expiryTimeMs = Date.parse(row.expiryTime);
      if (Number.isNaN(expiryTimeMs)) continue;
      lineItems.push({productId: row.productId, expiryTimeMs});
    }
  }
  const subscription: PlaySubscription = {
    subscriptionState: raw.subscriptionState,
    acknowledgementState: typeof raw.acknowledgementState === "string" ?
      raw.acknowledgementState :
      "ACKNOWLEDGEMENT_STATE_UNSPECIFIED",
    testPurchase: raw.testPurchase != null && typeof raw.testPurchase === "object",
    lineItems,
  };
  if (typeof raw.latestOrderId === "string" && raw.latestOrderId.length > 0) {
    subscription.latestOrderId = raw.latestOrderId;
  }
  if (typeof raw.linkedPurchaseToken === "string" && raw.linkedPurchaseToken.length > 0) {
    subscription.linkedPurchaseToken = raw.linkedPurchaseToken;
  }
  return subscription;
}

// Android Publisher client. The purchase token is a path parameter because
// that is how subscriptionsv2.get is addressed. Callers must not log the URL.
export function createPlayClient(deps: PlayClientDeps = {}): PlayClient {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const accessToken = deps.accessToken ?? defaultAccessToken;

  async function call(url: string, method: "GET" | "POST", acknowledge = false): Promise<string> {
    const token = await accessToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    };
    if (method === "POST") headers["Content-Type"] = "application/json";
    const res = await fetchImpl(url, {
      method,
      headers,
      body: method === "POST" ? "{}" : undefined,
    });
    const body = await res.text();
    if (!res.ok) {
      if (acknowledge && res.status === 400 && /already/i.test(body)) return "";
      throw mapStatus(res.status);
    }
    return body;
  }

  return {
    async getSubscription(packageName: string, purchaseToken: string): Promise<PlaySubscription> {
      const url = `${API}/${encodeURIComponent(packageName)}` +
        `/purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`;
      return parseSubscription(await call(url, "GET"));
    },

    async acknowledge(packageName: string, productId: string, purchaseToken: string): Promise<void> {
      const url = `${API}/${encodeURIComponent(packageName)}` +
        `/purchases/subscriptions/${encodeURIComponent(productId)}` +
        `/tokens/${encodeURIComponent(purchaseToken)}:acknowledge`;
      await call(url, "POST", true);
    },

    async listVoided(packageName: string, startTimeMillis: number): Promise<VoidedPurchase[]> {
      const all: VoidedPurchase[] = [];
      let pageToken: string | undefined;
      for (let page = 0; page < 10; page++) {
        const url = new URL(`${API}/${encodeURIComponent(packageName)}/purchases/voidedpurchases`);
        url.searchParams.set("type", "1");
        url.searchParams.set("startTime", String(startTimeMillis));
        url.searchParams.set("maxResults", "1000");
        if (pageToken) url.searchParams.set("token", pageToken);
        const body = await call(url.toString(), "GET");
        let parsed: unknown;
        try {
          parsed = body ? JSON.parse(body) : {};
        } catch {
          throw new PlayApiError(200, "internal");
        }
        const raw = (parsed ?? {}) as {
          voidedPurchases?: unknown;
          tokenPagination?: {nextPageToken?: unknown};
        };
        if (Array.isArray(raw.voidedPurchases)) {
          for (const item of raw.voidedPurchases) {
            if (!item || typeof item !== "object") continue;
            const row = item as {purchaseToken?: unknown; orderId?: unknown};
            if (typeof row.purchaseToken !== "string" || row.purchaseToken.length === 0) continue;
            const entry: VoidedPurchase = {purchaseToken: row.purchaseToken};
            if (typeof row.orderId === "string") entry.orderId = row.orderId;
            all.push(entry);
          }
        }
        const next = raw.tokenPagination?.nextPageToken;
        if (typeof next !== "string" || next.length === 0) return all;
        pageToken = next;
      }
      throw new PlayApiError(500, "unavailable");
    },
  };
}
