import {GoogleAuth} from "google-auth-library";

export const DRIVE_READONLY_SCOPE = "https://www.googleapis.com/auth/drive.readonly";

/* Binary download. The file is an .xlsx, not a native Google Sheet. */
export function driveMediaUrl(fileId: string): string {
  return "https://www.googleapis.com/drive/v3/files/" +
    encodeURIComponent(fileId) +
    "?alt=media&supportsAllDrives=true";
}

export async function downloadDriveFile(fileId: string): Promise<Buffer> {
  const auth = new GoogleAuth({scopes: [DRIVE_READONLY_SCOPE]});
  const client = await auth.getClient();
  const response = await client.request<ArrayBuffer>({
    url: driveMediaUrl(fileId),
    method: "GET",
    responseType: "arraybuffer",
  });
  return asBuffer(response.data);
}

export function asBuffer(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }
  const err = new Error("drive-body-not-binary");
  err.name = "drive-body-not-binary";
  throw err;
}
