import {DVLA_VES_URL, VehicleLookupError} from "./contract";

// The registration is sent only in the JSON body. It is never put on the URL.
export async function enquireVehicle(
  fetchImpl: typeof fetch,
  apiKey: string,
  registration: string,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchImpl(DVLA_VES_URL, {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify({registrationNumber: registration}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    // Timeout, DNS, and connection failures are the same outcome.
    // The thrown error can echo the request, so it is not kept.
    throw new VehicleLookupError("upstream_error");
  }

  if (response.status === 200) return readVehicleBody(response);
  await discardBody(response);
  throw errorForDvlaStatus(response.status);
}

export function errorForDvlaStatus(status: number): VehicleLookupError {
  if (status === 400) return new VehicleLookupError("invalid");
  if (status === 404) return new VehicleLookupError("not_found");
  if (status === 429) return new VehicleLookupError("rate_limited");
  return new VehicleLookupError("upstream_error");
}

async function readVehicleBody(response: Response): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new VehicleLookupError("upstream_error");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new VehicleLookupError("upstream_error");
  }
  return parsed as Record<string, unknown>;
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The status code is the only part of an error response we keep.
  }
}
