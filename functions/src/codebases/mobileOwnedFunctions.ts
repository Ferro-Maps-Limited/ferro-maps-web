/**
 * Cloud Functions names owned by the iOS `mobile` codebase
 * (ferromaps-ios-mvp-staging). The web `default` codebase must never export
 * these names.
 *
 * Both codebases deploy to the same project and region (europe-west2).
 * firebase-tools matches an existing function to a codebase by resource
 * name, not by codebase label, so a web deploy that exports one of these
 * names silently replaces the iOS function (for onSubscriptionRequest, the
 * Apple Gold writer). test/mobileOwnedFunctions.test.ts fails if the built
 * web index exports any of them.
 *
 * Add a name here whenever the mobile codebase ships a new function.
 */
export const MOBILE_OWNED_FUNCTION_NAMES = [
  "onSubscriptionRequest",
  "refreshEntitlements",
  "sendUpdateNotification",
  "sendPromotionNotification",
  "notifyOnStateChange",
  "markActedNotifications",
  "sendWeeklySummary",
  "sendDailyDigest",
  "sendReEngagement",
  "remindSavedHotspots",
  "stampHotspotWindow",
  "backfillHotspotWindows",
  "assessHotspots",
  "onContributionCreated",
  "onUserActive",
  "onContributionRequest",
  "onDriverLocationWritten",
  "refreshDriverDensity",
  "onDeviceSessionRequest",
  "onAccountDeletionRequest",
  "enrichDisruptions",
  "sweepRequestDocuments",
  "onSurgePurchaseRequest",
  "onWorkingDayOpen",
] as const;

// onHotspotUnlockRequest is also exported by the iOS mobile codebase
// (ferromaps-ios-mvp-staging PR 177). This repo already exports that name
// for the web hotspot writer. It is intentionally not in the list above:
// adding it would fail the guard on the existing export. Do not deploy both
// copies. Do not add another function with that name.
