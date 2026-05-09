import { useToastStore } from '../../stores/toast-store';
import { isImageMediaType, resolveMediaType } from './attachment-utils';

/**
 * Anthropic vision API budget:
 *   - 5MB hard cap per image (base64-encoded source bytes)
 *   - 8000x8000 absolute pixel cap, 2000x2000 when sending >20 images
 *   - Auto-downscales to ~1568px long edge, so larger uploads waste bandwidth
 *
 * We target a 1.5MB blob so the base64 payload (~2MB) fits with comfortable
 * headroom under the 5MB cap, and we resize to 1568px long edge to match
 * the API's own downscale and avoid sending pixels that get discarded.
 */
export const LONG_EDGE_TARGET = 1568;
export const MIN_COMPRESS_BYTES = 500 * 1024;
export const TARGET_BYTES = 1.5 * 1024 * 1024;
export const QUALITY_LADDER = [0.85, 0.75, 0.6] as const;

export interface CompressResult {
  file: File;
  compressed: boolean;
}

export interface CompressImageOptions {
  longEdge: number;
  quality: number;
}

const SKIP_RECOMPRESS_MEDIA_TYPES = new Set(['image/gif', 'image/svg+xml']);

function renameToWebp(originalName: string): string {
  const dotIndex = originalName.lastIndexOf('.');
  const stem = dotIndex >= 0 ? originalName.slice(0, dotIndex) : originalName;
  return `${stem}.webp`;
}

/**
 * Pure pipeline used by both the public helper and the calibration harness.
 * Takes an explicit long-edge target and quality so callers can sweep params.
 */
export async function compressImage(input: File, options: CompressImageOptions): Promise<Blob> {
  const bitmap = await createImageBitmap(input);
  try {
    const longEdge = Math.max(bitmap.width, bitmap.height);
    const scale = Math.min(1, options.longEdge / longEdge);
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('OffscreenCanvas 2d context unavailable');
    ctx.drawImage(bitmap, 0, 0, width, height);
    return await canvas.convertToBlob({ type: 'image/webp', quality: options.quality });
  } finally {
    bitmap.close();
  }
}

/**
 * Compress a clipboard-pasted image to fit Anthropic's vision API budget.
 *
 * Skip rules: not an image, GIF/SVG (lossy re-encode would damage them), under
 * 500KB (already small), or PNG that already fits the long-edge target (preserves
 * alpha for icons/UI screenshots without an explicit alpha probe).
 *
 * Pipeline: createImageBitmap -> resize to LONG_EDGE_TARGET on the long edge ->
 * OffscreenCanvas -> WebP at quality 0.85, falling back to 0.75 then 0.6 if the
 * result still exceeds TARGET_BYTES.
 *
 * Failure handling: any thrown error toasts a single warning and returns the
 * original file. Pastes never silently disappear.
 *
 * Drag/drop should NOT call this - only clipboard pastes go through compression.
 *
 * Note: the returned File has a `.webp` extension and `image/webp` media type
 * when compressed; callers should regenerate any filename derived from media type.
 */
export async function compressClipboardImage(input: File): Promise<CompressResult> {
  const mediaType = resolveMediaType(input);
  if (!isImageMediaType(mediaType)) return { file: input, compressed: false };
  if (SKIP_RECOMPRESS_MEDIA_TYPES.has(mediaType)) return { file: input, compressed: false };
  if (input.size < MIN_COMPRESS_BYTES) return { file: input, compressed: false };

  try {
    const bitmap = await createImageBitmap(input);
    try {
      const longEdge = Math.max(bitmap.width, bitmap.height);
      const scale = Math.min(1, LONG_EDGE_TARGET / longEdge);
      if (scale === 1 && mediaType === 'image/png') {
        return { file: input, compressed: false };
      }
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('OffscreenCanvas 2d context unavailable');
      ctx.drawImage(bitmap, 0, 0, width, height);

      let blob: Blob | null = null;
      for (const quality of QUALITY_LADDER) {
        blob = await canvas.convertToBlob({ type: 'image/webp', quality });
        if (blob.size <= TARGET_BYTES) break;
      }
      if (!blob) throw new Error('convertToBlob returned no data');

      if (blob.size > TARGET_BYTES) {
        useToastStore.getState().addToast({
          message: 'Image still large after compression - sending at reduced quality.',
          variant: 'warning',
        });
      }

      const filename = renameToWebp(input.name || 'image.webp');
      const file = new File([blob], filename, { type: 'image/webp', lastModified: Date.now() });
      return { file, compressed: true };
    } finally {
      bitmap.close();
    }
  } catch (error) {
    console.error('[image-compress] Failed to compress pasted image:', error);
    useToastStore.getState().addToast({
      message: 'Could not compress image - using original.',
      variant: 'warning',
    });
    return { file: input, compressed: false };
  }
}
