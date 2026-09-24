import {onDocumentCreated} from "firebase-functions/v2/firestore";
import * as logger from "firebase-functions/logger";
import {getFirestore, FieldValue} from "firebase-admin/firestore";

/**
 * Publishing an app version or a promo banner from the console.
 *
 * config/* is `allow write: if false` for everyone, deliberately: a write here
 * fans a push notification out to every driver on the estate. That is not a
 * thing a browser should be able to do directly, and it is also not a thing
 * anyone should have to open the Firebase console to do carefully.
 *
 * So the console writes a request, and this applies it — the pattern already
 * used by accountActions and contributionRequests, for the same reason: on
 * this project callables cannot be invoked at all, because the organisation
 * enforces Domain Restricted Sharing and allUsers cannot be granted invoker.
 *
 * What fans out is decided by the mobile triggers, not here:
 *   appVersion    pushes when latestVersion changes
 *   activeBanner  pushes when it becomes active, or bannerId changes while active
 * So a text correction keeps its bannerId and stays quiet, and publishing a new
 * banner takes a new one. The console says which it is about to do.
 */

const MAX_TITLE = 80;
const MAX_BODY = 200;
const SEMVER = /^\d+\.\d+\.\d+$/;

interface AppVersionPayload {
  latestVersion?: unknown;
  updateMessage?: unknown;
  updateEnabled?: unknown;
}

interface BannerPayload {
  title?: unknown;
  body?: unknown;
  isActive?: unknown;
  /** True when this is a new banner, which is what makes it notify. */
  notify?: unknown;
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : null;
}

export const onConfigRequest = onDocumentCreated(
  {document: "configRequests/{requestId}", region: "europe-west2"},
  async (event) => {
    const snapshot = event.data;
    const request = snapshot?.data();
    if (!snapshot || !request) return;

    const db = getFirestore();
    const fail = async (error: string) => {
      logger.warn(`onConfigRequest ${event.params.requestId}: ${error}`);
      await snapshot.ref.update({status: "error", error, completedAt: FieldValue.serverTimestamp()});
    };

    try {
      if (request.type === "appVersion") {
        const payload = (request.payload ?? {}) as AppVersionPayload;
        const latestVersion = text(payload.latestVersion, 20);
        if (!latestVersion || !SEMVER.test(latestVersion)) {
          await fail("A version must look like 1.2.3.");
          return;
        }

        const update: Record<string, unknown> = {latestVersion};
        const message = text(payload.updateMessage, MAX_BODY);
        if (message) update.updateMessage = message;
        if (typeof payload.updateEnabled === "boolean") update.updateEnabled = payload.updateEnabled;

        await db.doc("config/appVersion").set(update, {merge: true});
        logger.info(`onConfigRequest: app version set to ${latestVersion} by ${request.requestedBy}`);
      } else if (request.type === "banner") {
        const payload = (request.payload ?? {}) as BannerPayload;
        const title = text(payload.title, MAX_TITLE);
        const body = text(payload.body, MAX_BODY);
        const isActive = payload.isActive === true;

        if (isActive && (!title || !body)) {
          await fail("A banner needs a title and a message before it can be shown.");
          return;
        }

        const update: Record<string, unknown> = {isActive};
        if (title) update.title = title;
        if (body) update.body = body;
        // A fresh id is what tells the mobile trigger this is a new banner
        // rather than a correction, so only ask for one deliberately.
        if (payload.notify === true) update.bannerId = `admin_${Date.now()}`;

        await db.doc("config/activeBanner").set(update, {merge: true});
        logger.info(
          `onConfigRequest: banner ${isActive ? "shown" : "hidden"} by ${request.requestedBy}` +
          `${payload.notify === true ? ", notifying drivers" : ""}`
        );
      } else {
        await fail(`Unknown request type: ${String(request.type)}`);
        return;
      }

      await snapshot.ref.update({status: "done", completedAt: FieldValue.serverTimestamp()});
    } catch (err) {
      await fail(err instanceof Error ? err.message : "Something went wrong.");
    }
  }
);
