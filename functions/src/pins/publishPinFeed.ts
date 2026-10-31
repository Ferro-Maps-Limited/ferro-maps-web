import {onSchedule} from "firebase-functions/v2/scheduler";
import * as logger from "firebase-functions/logger";
import {getFirestore} from "firebase-admin/firestore";
import {publishPins} from "./publishPins";

/** Daily, same cadence as the parking window refresh. Also rolls static windows. */
export const publishPinFeed = onSchedule({
  schedule: "every 24 hours",
  region: "europe-west2",
  timeoutSeconds: 300,
  memory: "512MiB",
  maxInstances: 1,
}, async () => {
  const result = await publishPins(getFirestore(), new Date(), logger);
  logger.info("publishPinFeed", {
    written: result.written,
    tilesOver500: result.tilesOver500,
    rawOver: result.rawOver,
  });
});
