import { useCallback, useEffect, useRef, useState } from 'react';

// Spike: free-draw annotation overlay. Strokes are stored in CSS px relative
// to the canvas's bounding rect; the capture compositor scales them up to the
// native PNG dimensions when blitting.

export interface DrawPoint {
  x: number;
  y: number;
}

export type Stroke = DrawPoint[];

interface UseDrawingOverlayOptions {
  enabled: boolean;
  color?: string;
  lineWidth?: number;
}

export function useDrawingOverlay({
  enabled,
  color = '#ff3b3b',
  lineWidth = 3,
}: UseDrawingOverlayOptions) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const drawingRef = useRef(false);
  const currentStrokeRef = useRef<Stroke>([]);

  const sizeCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    canvas.width = Math.floor(rect.width);
    canvas.height = Math.floor(rect.height);
  }, []);

  useEffect(() => {
    sizeCanvas();
    const observer = new ResizeObserver(() => sizeCanvas());
    if (canvasRef.current) observer.observe(canvasRef.current);
    return () => observer.disconnect();
  }, [sizeCanvas]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const stroke of strokes) {
      if (stroke.length === 0) continue;
      ctx.beginPath();
      stroke.forEach((point, index) => {
        if (index === 0) ctx.moveTo(point.x, point.y);
        else ctx.lineTo(point.x, point.y);
      });
      ctx.stroke();
    }
  }, [strokes, color, lineWidth]);

  const pointFromEvent = useCallback((event: React.PointerEvent<HTMLCanvasElement>): DrawPoint | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }, []);

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!enabled) return;
    const point = pointFromEvent(event);
    if (!point) return;
    drawingRef.current = true;
    currentStrokeRef.current = [point];
    canvasRef.current?.setPointerCapture(event.pointerId);
    setStrokes((previous) => [...previous, [point]]);
  }, [enabled, pointFromEvent]);

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!enabled || !drawingRef.current) return;
    const point = pointFromEvent(event);
    if (!point) return;
    currentStrokeRef.current = [...currentStrokeRef.current, point];
    setStrokes((previous) => {
      const next = previous.slice();
      next[next.length - 1] = currentStrokeRef.current;
      return next;
    });
  }, [enabled, pointFromEvent]);

  const onPointerUp = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    canvasRef.current?.releasePointerCapture(event.pointerId);
    currentStrokeRef.current = [];
  }, []);

  const clear = useCallback(() => setStrokes([]), []);
  const undo = useCallback(() => setStrokes((previous) => previous.slice(0, -1)), []);

  return {
    canvasRef,
    strokes,
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp, onPointerLeave: onPointerUp },
    clear,
    undo,
  };
}
