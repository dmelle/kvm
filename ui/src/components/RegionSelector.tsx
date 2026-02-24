import { useCallback, useEffect, useRef, useState } from "react";

export interface SelectedRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface RegionSelectorProps {
  onRegionSelected: (rect: SelectedRegion) => void;
  onCancel: () => void;
  videoRef?: React.RefObject<HTMLVideoElement | null>;
}

interface DragState {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
}

/**
 * Computes the effective video display area within the video element,
 * accounting for object-contain pillarboxing/letterboxing.
 */
function getVideoDisplayMetrics(
  clientWidth: number,
  clientHeight: number,
  videoWidth: number,
  videoHeight: number,
) {
  const elementAspect = clientWidth / clientHeight;
  const streamAspect = videoWidth / videoHeight;

  let effectiveWidth = clientWidth;
  let effectiveHeight = clientHeight;
  let offsetX = 0;
  let offsetY = 0;

  if (elementAspect > streamAspect) {
    // Pillarboxing: black bars on left and right
    effectiveWidth = clientHeight * streamAspect;
    offsetX = (clientWidth - effectiveWidth) / 2;
  } else if (elementAspect < streamAspect) {
    // Letterboxing: black bars on top and bottom
    effectiveHeight = clientWidth / streamAspect;
    offsetY = (clientHeight - effectiveHeight) / 2;
  }

  return { effectiveWidth, effectiveHeight, offsetX, offsetY };
}

/**
 * Maps a screen-space coordinate (relative to the video element) to
 * a native video resolution coordinate, clamped within the effective
 * video display area.
 */
function screenToVideoCoord(
  screenX: number,
  screenY: number,
  clientWidth: number,
  clientHeight: number,
  videoWidth: number,
  videoHeight: number,
): { x: number; y: number } {
  const { effectiveWidth, effectiveHeight, offsetX, offsetY } = getVideoDisplayMetrics(
    clientWidth,
    clientHeight,
    videoWidth,
    videoHeight,
  );

  const clampedX = Math.min(Math.max(offsetX, screenX), offsetX + effectiveWidth);
  const clampedY = Math.min(Math.max(offsetY, screenY), offsetY + effectiveHeight);

  const relativeX = (clampedX - offsetX) / effectiveWidth;
  const relativeY = (clampedY - offsetY) / effectiveHeight;

  return {
    x: Math.round(relativeX * videoWidth),
    y: Math.round(relativeY * videoHeight),
  };
}

export default function RegionSelector({ onRegionSelected, onCancel, videoRef }: RegionSelectorProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);

  // Cancel on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
      }
    };
    document.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => document.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [onCancel]);

  const getOverlayOffset = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
  }, []);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.button !== 0) return; // left button only
      e.preventDefault();
      const pos = getOverlayOffset(e);
      setDrag({ startX: pos.x, startY: pos.y, currentX: pos.x, currentY: pos.y });
    },
    [getOverlayOffset],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!drag) return;
      e.preventDefault();
      const pos = getOverlayOffset(e);
      setDrag(prev => (prev ? { ...prev, currentX: pos.x, currentY: pos.y } : null));
    },
    [drag, getOverlayOffset],
  );

  const handleMouseUp = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!drag || e.button !== 0) return;
      e.preventDefault();

      const videoEl = videoRef?.current;
      const overlayEl = overlayRef.current;
      if (!videoEl || !overlayEl) {
        setDrag(null);
        return;
      }

      // Read fresh dimensions directly from the video element
      const videoRect = videoEl.getBoundingClientRect();
      const overlayRect = overlayEl.getBoundingClientRect();
      const cw = videoEl.clientWidth;
      const ch = videoEl.clientHeight;
      const vw = videoEl.videoWidth;
      const vh = videoEl.videoHeight;

      // Convert overlay-relative drag coords to video-content-box-relative coords.
      // drag.startX/Y are relative to the overlay's top-left.
      // We convert to viewport coords, then to video content box coords.
      // clientLeft/clientTop account for the video element's border.
      const startVidX = drag.startX + overlayRect.left - videoRect.left - videoEl.clientLeft;
      const startVidY = drag.startY + overlayRect.top - videoRect.top - videoEl.clientTop;
      const endVidX = e.clientX - videoRect.left - videoEl.clientLeft;
      const endVidY = e.clientY - videoRect.top - videoEl.clientTop;

      // Convert to native video coordinates (handles object-contain offsets)
      const start = screenToVideoCoord(startVidX, startVidY, cw, ch, vw, vh);
      const end = screenToVideoCoord(endVidX, endVidY, cw, ch, vw, vh);

      // Normalize to top-left origin
      const x = Math.min(start.x, end.x);
      const y = Math.min(start.y, end.y);
      const width = Math.abs(end.x - start.x);
      const height = Math.abs(end.y - start.y);

      // Require a minimum selection size (10px in video coords)
      if (width < 10 || height < 10) {
        setDrag(null);
        return;
      }

      console.debug("[OCR Region]", {
        overlaySize: { w: overlayRect.width, h: overlayRect.height },
        videoPos: { left: videoRect.left - overlayRect.left, top: videoRect.top - overlayRect.top },
        videoSize: { rect: `${videoRect.width}x${videoRect.height}`, client: `${cw}x${ch}`, native: `${vw}x${vh}` },
        border: { left: videoEl.clientLeft, top: videoEl.clientTop },
        dragInVideo: { startVidX, startVidY, endVidX, endVidY },
        nativeResult: { x, y, width, height },
      });

      setDrag(null);
      onRegionSelected({ x, y, width, height });
    },
    [drag, videoRef, onRegionSelected],
  );

  // Compute the visual selection rectangle in screen-space
  const selectionStyle = drag
    ? {
        left: Math.min(drag.startX, drag.currentX),
        top: Math.min(drag.startY, drag.currentY),
        width: Math.abs(drag.currentX - drag.startX),
        height: Math.abs(drag.currentY - drag.startY),
      }
    : null;

  return (
    <div
      ref={overlayRef}
      className="absolute inset-0 z-10 cursor-crosshair"
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
    >
      {/* Semi-transparent backdrop */}
      <div className="absolute inset-0 bg-black/10" />

      {/* Instruction text */}
      {!drag && (
        <div className="pointer-events-none absolute inset-x-0 top-4 flex justify-center">
          <div className="rounded-md bg-black/70 px-3 py-1.5 text-xs font-medium text-white">
            Draw a rectangle to select text. Press Escape to cancel.
          </div>
        </div>
      )}

      {/* Selection rectangle */}
      {selectionStyle && (
        <div
          className="absolute border-2 border-dashed border-blue-500 bg-blue-500/20"
          style={selectionStyle}
        />
      )}
    </div>
  );
}
