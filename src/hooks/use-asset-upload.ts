
"use client";

import { useState, useCallback } from "react";
import { useAssetsStore, type ProjectFile } from "@/stores/assets-store";
import {
  getPresignedConfig,
  uploadFileWithConfig,
  type MediaType,
} from "@/lib/upload-utils";
import { generateThumbnail } from "@/lib/thumbnail-generator";
import { analyzeVideo } from "@/lib/video-analysis";

interface UploadResult {
  success: boolean;
  fileName: string;
  error?: string;
}

interface UseAssetUploadOptions {
  spaceId: string | null;
  onComplete?: () => void;
}

export function useAssetUpload({
  spaceId,
  onComplete,
}: UseAssetUploadOptions) {
  const [isUploading, setIsUploading] = useState(false);
  const { addFiles, updateFile } = useAssetsStore();

  const detectFileType = (file: File): MediaType => {
    const mime = file.type.toLowerCase();
    const ext = file.name.split(".").pop()?.toLowerCase() || "";

    if (
      mime.startsWith("audio/") ||
      ["mp3", "wav", "ogg", "flac", "aac", "m4a"].includes(ext)
    ) {
      return "audio";
    }

    if (
      mime.startsWith("video/") ||
      ["mp4", "webm", "mov", "avi", "mkv"].includes(ext)
    ) {
      return "video";
    }

    return "image";
  };

  const createTempFile = (
    file: File,
    targetSpaceId: string,
  ): ProjectFile => ({
    id: `temp_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    spaceId: targetSpaceId,
    name: file.name,
    type: detectFileType(file),
    src: "",
    duration: undefined,
    size: file.size,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    indexingStatus: null,
    uploadProgress: 0,
  });

  const saveAsset = (asset: ProjectFile, targetSpaceId: string) => {
    try {
      const localKey = `ov_assets_${targetSpaceId}`;
      const stored = localStorage.getItem(localKey);
      const existingAssets: ProjectFile[] = stored
        ? JSON.parse(stored)
        : [];

      const updatedAssets = existingAssets.some(
        (existing) => existing.id === asset.id,
      )
        ? existingAssets.map((existing) =>
            existing.id === asset.id
              ? { ...existing, ...asset }
              : existing,
          )
        : [asset, ...existingAssets];

      localStorage.setItem(localKey, JSON.stringify(updatedAssets));
    } catch (error) {
      console.error(`[Upload] Failed to save ${asset.name} locally:`, error);
    }
  };

  const processFile = async (
    file: File,
    tempId: string,
  ): Promise<UploadResult> => {
    const type = detectFileType(file);
    const targetSpaceId = spaceId || "guest";
    const assetId = crypto.randomUUID();

    try {
      const uploadConfig = await getPresignedConfig(file.name, type);

      const newAsset: ProjectFile = {
        id: assetId,
        spaceId: targetSpaceId,
        name: file.name,
        type,
        src: "",
        thumbnailSrc: null,
        size: file.size,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        indexingStatus: null,
        uploadProgress: 0,
      };

      updateFile(tempId, {
        id: assetId,
        src: "",
        thumbnailSrc: null,
        uploadProgress: 0,
        indexingStatus: null,
      });

      let uploadComplete = false;
      let metadataUpdates: Partial<ProjectFile> = {};

      const saveCompletedAsset = () => {
        if (uploadComplete) {
          saveAsset(
            {
              ...newAsset,
              ...metadataUpdates,
              uploadProgress: null,
            },
            targetSpaceId,
          );
        }
      };

      const metadataTasks = [
        type === "video" ? analyzeVideo(file) : Promise.resolve(undefined),
        type === "image" || type === "video"
          ? generateThumbnail(file)
          : Promise.resolve(null),
      ] as const;

      void Promise.allSettled(metadataTasks).then(
        async ([analysis, thumbnail]) => {
          const updates: Partial<ProjectFile> = {};

          if (analysis.status === "fulfilled" && analysis.value) {
            updates.duration = analysis.value.duration;
            updates.width = analysis.value.width;
            updates.height = analysis.value.height;
          } else if (analysis.status === "rejected") {
            console.warn(
              `[Upload] Could not analyze ${file.name}:`,
              analysis.reason,
            );
          }

          if (thumbnail.status === "fulfilled" && thumbnail.value) {
            try {
              const thumbnailFile = new File(
                [thumbnail.value],
                `thumb-${crypto.randomUUID()}.webp`,
                { type: "image/webp" },
              );

              const thumbnailConfig = await getPresignedConfig(
                thumbnailFile.name,
                "image",
              );

              const thumbnailResult = await uploadFileWithConfig(
                thumbnailFile,
                thumbnailConfig,
              );

              updates.thumbnailSrc = thumbnailResult.secureUrl;
            } catch (error) {
              console.warn(
                `[Upload] Could not create a thumbnail for ${file.name}:`,
                error,
              );
            }
          } else if (thumbnail.status === "rejected") {
            console.warn(
              `[Upload] Could not create a thumbnail for ${file.name}:`,
              thumbnail.reason,
            );
          }

          if (Object.keys(updates).length > 0) {
            metadataUpdates = { ...metadataUpdates, ...updates };
            updateFile(assetId, updates);
            saveCompletedAsset();
          }
        },
      );

      const uploaded = await uploadFileWithConfig(
        file,
        uploadConfig,
        (progress) => {
          updateFile(assetId, { uploadProgress: progress });
        },
      );

      newAsset.src = uploaded.secureUrl;
      newAsset.cloudinaryPublicId = uploaded.publicId;
      newAsset.cloudinaryResourceType = uploaded.resourceType;

      if (uploaded.duration !== undefined) {
        newAsset.duration = uploaded.duration;
      }

      if (uploaded.width !== undefined) {
        newAsset.width = uploaded.width;
      }

      if (uploaded.height !== undefined) {
        newAsset.height = uploaded.height;
      }

      uploadComplete = true;

      updateFile(assetId, {
        src: uploaded.secureUrl,
        cloudinaryPublicId: uploaded.publicId,
        cloudinaryResourceType: uploaded.resourceType,
        duration: uploaded.duration,
        width: uploaded.width,
        height: uploaded.height,
        uploadProgress: null,
        indexingStatus: null,
      });

      saveCompletedAsset();

      return { success: true, fileName: file.name };
    } catch (error) {
      console.error(`[Upload] Failed for ${file.name}:`, error);

      const errorMessage =
        error instanceof Error ? error.message : "Upload failed";

      updateFile(assetId, {
        uploadProgress: null,
        indexingStatus: "failed",
        indexingError: errorMessage,
      });

      return {
        success: false,
        fileName: file.name,
        error: errorMessage,
      };
    }
  };

  const uploadFiles = useCallback(
    async (files: FileList | null) => {
      const targetSpaceId = spaceId || "guest";
      if (!files?.length) return;

      setIsUploading(true);
      const fileArray = Array.from(files);

      const tempFiles = fileArray.map((file) =>
        createTempFile(file, targetSpaceId),
      );

      addFiles(tempFiles);

      try {
        return await Promise.all(
          fileArray.map((file, index) =>
            processFile(file, tempFiles[index].id),
          ),
        );
      } finally {
        setIsUploading(false);
        onComplete?.();
      }
    },
    [spaceId, addFiles, updateFile, onComplete],
  );

  return { uploadFiles, isUploading };
}
