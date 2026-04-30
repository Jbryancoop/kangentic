import type { Stroke } from './useDrawingOverlay';
import type { WebviewElement } from './webview-types';

// Spike: composites the webview's captured frame with the user's annotation
// strokes (drawn in CSS pixels relative to the overlay) into a single PNG.
// Returns base64 stripped of the data: prefix, ready to send to the main IPC
// handler that writes it to disk.

interface CompositeOptions {
  webview: WebviewElement;
  strokes: Stroke[];
  overlayWidth: number;
  overlayHeight: number;
  strokeColor?: string;
  strokeWidth?: number;
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Failed to decode webview capture data URL'));
    image.src = dataUrl;
  });
}

export async function compositeCapture({
  webview,
  strokes,
  overlayWidth,
  overlayHeight,
  strokeColor = '#ff3b3b',
  strokeWidth = 3,
}: CompositeOptions): Promise<string> {
  const nativeImage = await webview.capturePage();
  const dataUrl = nativeImage.toDataURL();
  const size = nativeImage.getSize();

  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not get 2d canvas context');

  const image = await loadImage(dataUrl);
  ctx.drawImage(image, 0, 0, size.width, size.height);

  if (strokes.length > 0 && overlayWidth > 0 && overlayHeight > 0) {
    const scaleX = size.width / overlayWidth;
    const scaleY = size.height / overlayHeight;
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = strokeWidth * Math.max(scaleX, scaleY);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const stroke of strokes) {
      if (stroke.length === 0) continue;
      ctx.beginPath();
      stroke.forEach((point, index) => {
        const x = point.x * scaleX;
        const y = point.y * scaleY;
        if (index === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }
  }

  const fullDataUrl = canvas.toDataURL('image/png');
  return fullDataUrl.replace(/^data:image\/png;base64,/, '');
}
