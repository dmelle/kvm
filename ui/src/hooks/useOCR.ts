import { useCallback, useRef } from "react";
import { createWorker, Worker } from "tesseract.js";

import notifications from "@/notifications";
import { SelectedRegion } from "@components/RegionSelector";

/**
 * Light pre-processing: only invert if the background is dark (terminal text).
 * Tesseract handles its own binarization internally — aggressive external
 * thresholding destroys detail on WebRTC-compressed frames.
 */
function preprocessForOCR(canvas: HTMLCanvasElement): HTMLCanvasElement {
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;

  // Measure average brightness to detect dark backgrounds
  let totalBrightness = 0;
  for (let i = 0; i < data.length; i += 4) {
    totalBrightness += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  const avgBrightness = totalBrightness / (data.length / 4);

  // If dark background (terminal, dark-mode UI), invert so Tesseract sees
  // dark text on light background — which it handles much better
  if (avgBrightness < 128) {
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 255 - data[i];
      data[i + 1] = 255 - data[i + 1];
      data[i + 2] = 255 - data[i + 2];
    }
    ctx.putImageData(imageData, 0, 0);
  }

  return canvas;
}

/**
 * Captures a region from the video element onto a canvas,
 * upscaling 2x if the region is small (improves OCR on small text).
 */
function captureRegion(
  videoElement: HTMLVideoElement,
  rect: SelectedRegion,
): HTMLCanvasElement {
  // Upscale small regions for better OCR accuracy
  const scale = Math.min(rect.width, rect.height) < 200 ? 2 : 1;

  const canvas = document.createElement("canvas");
  canvas.width = rect.width * scale;
  canvas.height = rect.height * scale;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Failed to get canvas 2d context");

  // Use better interpolation for upscaling
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  ctx.drawImage(
    videoElement,
    rect.x,
    rect.y,
    rect.width,
    rect.height,
    0,
    0,
    canvas.width,
    canvas.height,
  );

  return canvas;
}

export function useOCR() {
  const workerRef = useRef<Worker | null>(null);
  const initializingRef = useRef(false);

  const getWorker = useCallback(async (): Promise<Worker> => {
    if (workerRef.current) return workerRef.current;

    if (initializingRef.current) {
      // Wait for initialization to complete
      while (initializingRef.current) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      if (workerRef.current) return workerRef.current;
    }

    initializingRef.current = true;
    try {
      const worker = await createWorker("eng");
      workerRef.current = worker;
      return worker;
    } finally {
      initializingRef.current = false;
    }
  }, []);

  const recognizeRegion = useCallback(
    async (videoElement: HTMLVideoElement, rect: SelectedRegion): Promise<string> => {
      notifications.success("Running OCR...");

      // 1. Capture region to canvas
      const canvas = captureRegion(videoElement, rect);

      // Debug: log the captured image so we can verify what Tesseract sees
      console.debug("[OCR] Captured region:", rect);
      console.debug("[OCR] Canvas size:", canvas.width, "x", canvas.height);
      console.debug("[OCR] Captured image:", canvas.toDataURL("image/png").slice(0, 100) + "...");

      // 2. Light pre-processing (invert dark backgrounds only)
      preprocessForOCR(canvas);

      // 3. Get or initialize Tesseract worker
      const worker = await getWorker();

      // 4. Run OCR
      const {
        data: { text, confidence },
      } = await worker.recognize(canvas);

      console.debug("[OCR] Raw result:", JSON.stringify(text));
      console.debug("[OCR] Confidence:", confidence);

      const trimmed = text.trim();

      if (!trimmed) {
        notifications.error("No text detected in selected region.");
        return "";
      }

      // 5. Copy to clipboard
      try {
        await navigator.clipboard.writeText(trimmed);
      } catch {
        // Fallback for insecure contexts
        const textarea = document.createElement("textarea");
        textarea.value = trimmed;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
      }

      const preview = trimmed.length > 60 ? trimmed.slice(0, 60) + "..." : trimmed;
      notifications.success(`Copied: ${preview}`);
      return trimmed;
    },
    [getWorker],
  );

  return { recognizeRegion };
}
