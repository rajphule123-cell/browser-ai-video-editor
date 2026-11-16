
import { apiUrl } from "@/lib/api";

export type MediaType = "image" | "video" | "audio";
export type CloudinaryResourceType = "image" | "video" | "raw";

export interface PresignedUploadConfig {
  fileName: string;
  contentType: string;
  cloudName: string;
  apiKey: string;
  timestamp: number;
  signature: string;
  folder: string;
  publicId: string;
  resourceType: CloudinaryResourceType;
}

export interface UploadResult {
  fileName: string;
  secureUrl: string;
  publicId: string;
  resourceType: CloudinaryResourceType;
  format?: string;
  bytes?: number;
  width?: number;
  height?: number;
  duration?: number;
}

export async function getPresignedConfig(
  fileName: string,
  mediaType: MediaType,
): Promise<PresignedUploadConfig> {
  let response: Response;

  try {
    response = await fetch(apiUrl("/api/uploads/presign"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileName, mediaType }),
    });
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error(
        `Cannot reach the upload backend at ${apiUrl("/")}. Start it with "npm run dev:backend" or "npm run dev".`,
      );
    }
    throw error;
  }

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(
      typeof data?.error === "string"
        ? data.error
        : "Failed to get Cloudinary upload configuration",
    );
  }

  const upload = data?.upload as PresignedUploadConfig | undefined;

  if (
    !upload?.cloudName ||
    !upload?.apiKey ||
    !upload?.timestamp ||
    !upload?.signature ||
    !upload?.folder ||
    !upload?.publicId ||
    !upload?.resourceType
  ) {
    throw new Error("Backend returned an invalid Cloudinary configuration");
  }

  return upload;
}

export async function uploadFileWithConfig(
  file: File,
  config: PresignedUploadConfig,
  onProgress?: (progress: number) => void,
): Promise<UploadResult> {
  return new Promise<UploadResult>((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    const formData = new FormData();
    formData.append("file", file);
    formData.append("api_key", config.apiKey);
    formData.append("timestamp", String(config.timestamp));
    formData.append("signature", config.signature);
    formData.append("folder", config.folder);
    formData.append("public_id", config.publicId);

    const endpoint =
      `https://api.cloudinary.com/v1_1/${encodeURIComponent(config.cloudName)}` +
      `/${config.resourceType}/upload`;

    xhr.open("POST", endpoint);
    xhr.timeout = 600_000;

    if (onProgress) {
      xhr.upload.addEventListener("progress", (event) => {
        if (event.lengthComputable) {
          onProgress(Math.round((event.loaded / event.total) * 100));
        }
      });
    }

    xhr.addEventListener("load", () => {
      let data: any;

      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        reject(new Error("Cloudinary returned an invalid response"));
        return;
      }

      if (xhr.status >= 200 && xhr.status < 300) {
        if (!data.secure_url || !data.public_id || !data.resource_type) {
          reject(new Error("Cloudinary response is missing asset details"));
          return;
        }

        resolve({
          fileName: config.fileName,
          secureUrl: data.secure_url,
          publicId: data.public_id,
          resourceType: data.resource_type,
          format: data.format,
          bytes: data.bytes,
          width: data.width,
          height: data.height,
          duration: data.duration,
        });
      } else {
        reject(
          new Error(
            data?.error?.message ||
              `Cloudinary upload failed with status ${xhr.status}`,
          ),
        );
      }
    });

    xhr.addEventListener("error", () => {
      reject(new Error("Network error during Cloudinary upload"));
    });

    xhr.addEventListener("abort", () => {
      reject(new Error("Upload aborted"));
    });

    xhr.addEventListener("timeout", () => {
      reject(new Error("Upload timed out after 10 minutes"));
    });

    xhr.send(formData);
  });
}

export const uploadFile = async (
  file: File,
  mediaType: MediaType,
  onProgress?: (progress: number) => void,
): Promise<UploadResult> => {
  const config = await getPresignedConfig(file.name, mediaType);
  return uploadFileWithConfig(file, config, onProgress);
};
