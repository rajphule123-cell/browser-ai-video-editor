
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { config as loadEnv } from "dotenv";
import express, { type Request, type Response } from "express";
import { getCloudinary } from "../src/lib/cloudinary";
import { transcribe } from "../src/lib/transcribe";

loadEnv({ path: resolve(process.cwd(), "backend/.env") });

const app = express();
const port = Number(process.env.BACKEND_PORT || 4000);

const allowedOrigins = (
  process.env.FRONTEND_ORIGIN || "http://localhost:3000,http://localhost:3001"
)
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (origin && !allowedOrigins.includes(origin)) {
    return res.status(403).json({ error: "Origin is not allowed" });
  }

  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }

  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

function getErrorMessage(data: unknown, fallback: string): string {
  if (typeof data === "object" && data !== null && "message" in data) {
    const message = data.message;
    if (typeof message === "string") {
      return message;
    }
  }

  return fallback;
}

async function proxyAudioSearch(
  req: Request,
  res: Response,
  endpoint: string,
  fallback: string,
): Promise<void> {
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });

    const data: unknown = await response.json().catch(() => ({}));

    if (!response.ok) {
      res.status(response.status).json({
        error: getErrorMessage(data, fallback),
      });
      return;
    }

    res.json(data);
  } catch (error) {
    console.error("Audio search API error:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
}

app.post("/api/audio/music", (req, res) => {
  void proxyAudioSearch(
    req,
    res,
    "https://api-editor.cloud-45c.workers.dev/api/musics/search",
    "Failed to fetch music",
  );
});

app.post("/api/audio/sfx", (req, res) => {
  void proxyAudioSearch(
    req,
    res,
    "https://api-editor.cloud-45c.workers.dev/api/sound-effects/search",
    "Failed to fetch sound effects",
  );
});

// Pexels stock media search
app.get("/api/pexels", async (req, res) => {
  const apiKey = process.env.PEXELS_API_KEY;

  if (!apiKey) {
    res.status(500).json({ error: "PEXELS_API_KEY is not configured" });
    return;
  }

  const type = typeof req.query.type === "string" ? req.query.type : "image";

  if (type !== "image" && type !== "video") {
    res.status(400).json({ error: "type must be image or video" });
    return;
  }

  const query = typeof req.query.query === "string" ? req.query.query : "";
  const page = typeof req.query.page === "string" ? req.query.page : "1";
  const perPage =
    typeof req.query.per_page === "string" ? req.query.per_page : "20";

  const path =
    type === "image"
      ? query
        ? "v1/search"
        : "v1/curated"
      : query
        ? "videos/search"
        : "videos/popular";

  const params = new URLSearchParams({ page, per_page: perPage });

  if (query) {
    params.set("query", query);
  }

  try {
    const response = await fetch(
      `https://api.pexels.com/${path}?${params}`,
      {
        headers: { Authorization: apiKey },
      },
    );

    const data: unknown = await response.json().catch(() => ({}));

    if (!response.ok) {
      res.status(response.status).json({
        error: getErrorMessage(data, "Failed to fetch from Pexels"),
      });
      return;
    }

    res.json(data);
  } catch (error) {
    console.error("Pexels API error:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Transcription
app.post("/api/transcribe", async (req, res) => {
  const { url, targetLanguage, language, model } = (req.body ?? {}) as {
    url?: unknown;
    targetLanguage?: unknown;
    language?: unknown;
    model?: unknown;
  };

  if (typeof url !== "string" || !url) {
    res.status(400).json({ message: "Audio URL is required" });
    return;
  }

  try {
    const result = await transcribe({
      url,
      language:
        typeof targetLanguage === "string"
          ? targetLanguage
          : typeof language === "string"
            ? language
            : undefined,
      model: typeof model === "string" ? model : "nova-3",
      smartFormat: true,
      paragraphs: true,
    });

    res.status(200).json(result);
  } catch (error) {
    console.error("Transcription error:", error);

    res.status(500).json({
      message:
        error instanceof Error
          ? error.message
          : "Internal server error",
    });
  }
});

// Cloudinary signed upload configuration
app.post("/api/uploads/presign", (req, res) => {
  const { fileName, mediaType, userId = "mockuser" } = (req.body ?? {}) as {
    fileName?: unknown;
    mediaType?: unknown;
    userId?: unknown;
  };

  if (typeof fileName !== "string" || !fileName.trim()) {
    res.status(400).json({ error: "fileName is required" });
    return;
  }

  if (
    mediaType !== "image" &&
    mediaType !== "video" &&
    mediaType !== "audio"
  ) {
    res.status(400).json({
      error: "mediaType must be image, video or audio",
    });
    return;
  }

  try {
    const cloudinary = getCloudinary();

    const cloudName = process.env.CLOUDINARY_CLOUD_NAME!;
    const apiKey = process.env.CLOUDINARY_API_KEY!;
    const apiSecret = process.env.CLOUDINARY_API_SECRET!;

    const safeUserId =
      typeof userId === "string"
        ? userId.replace(/[^a-zA-Z0-9._-]/g, "_")
        : "mockuser";

    const cleanName = fileName
      .trim()
      .replace(/[^a-zA-Z0-9._-]/g, "_");

    const folder = `video-editor/${safeUserId}`;
    const publicId = randomUUID();
    const timestamp = Math.floor(Date.now() / 1000);

    // Cloudinary stores audio using the video resource type.
    const resourceType = mediaType === "image" ? "image" : "video";

    const signatureParams = {
      timestamp,
      folder,
      public_id: publicId,
    };

    const signature = cloudinary.utils.api_sign_request(
      signatureParams,
      apiSecret,
    );

    res.json({
      success: true,
      upload: {
        fileName: cleanName,
        contentType: "application/octet-stream",
        cloudName,
        apiKey,
        timestamp,
        signature,
        folder,
        publicId,
        resourceType,
      },
    });
  } catch (error) {
    console.error("Error creating Cloudinary signature:", error);

    res.status(500).json({
      error:
        error instanceof Error
          ? error.message
          : "Failed to create Cloudinary upload configuration",
    });
  }
});

// Delete an asset from Cloudinary
app.delete("/api/uploads", async (req, res) => {
  const { publicId, resourceType } = (req.body ?? {}) as {
    publicId?: unknown;
    resourceType?: unknown;
  };

  if (typeof publicId !== "string" || !publicId.trim()) {
    res.status(400).json({ error: "publicId is required" });
    return;
  }

  if (
    resourceType !== "image" &&
    resourceType !== "video" &&
    resourceType !== "raw"
  ) {
    res.status(400).json({ error: "Invalid Cloudinary resourceType" });
    return;
  }

  try {
    const cloudinary = getCloudinary();

    const result = await cloudinary.uploader.destroy(publicId, {
      resource_type: resourceType,
      invalidate: true,
    });

    if (result.result !== "ok" && result.result !== "not found") {
      res.status(500).json({
        error: "Cloudinary could not delete the asset",
        details: result.result,
      });
      return;
    }

    res.json({
      success: true,
      result: result.result,
    });
  } catch (error) {
    console.error("Error deleting Cloudinary upload:", error);

    res.status(500).json({
      error:
        error instanceof Error
          ? error.message
          : "Failed to delete Cloudinary upload",
    });
  }
});

app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.listen(port, () => {
  console.log(`Backend API listening on http://localhost:${port}`);
});
