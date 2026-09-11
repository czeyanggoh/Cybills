import { useCallback, useEffect, useRef, useState } from 'react';
import { Minus, Plus, RotateCw, Maximize2 } from 'lucide-react';
import { cn } from '@/lib/utils';

// A receipt image that zooms by itself.
//
// The small print is the point of a receipt — the GST registration number under
// the address, the handwritten "6.17" beside "GST %" — and the only way to read
// it was the BROWSER's zoom, which blows up the whole page with it and sends the
// form off the side of the screen. So the image has its own zoom, inside its own
// frame, and nothing else on the page moves:
//
//   Ctrl/⌘ + wheel (and a trackpad pinch, which arrives as the same event)
//     zooms around the pointer — caught here, so it never reaches the browser;
//   the plain wheel is left alone, so the page still scrolls past the image;
//   drag pans once zoomed in; double-click toggles close-up / fit;
//   the buttons do the same for anyone without a wheel, and rotate a photo
//   that was taken sideways.
const MIN = 1;
const MAX = 8;
const STEP = 1.25;
const clampScale = (s) => Math.min(MAX, Math.max(MIN, s));

export default function ZoomableImage({ src, alt = '', className = '' }) {
  const frameRef = useRef(null);
  const [frame, setFrame] = useState({ w: 0, h: 0 });
  // The bitmap's own size, remembered WITH the src it belongs to: a cached
  // image can report its size before the reset below has even run, so a reset
  // that cleared it would throw away the only measurement it will ever send.
  const [measured, setMeasured] = useState({ src: '', w: 0, h: 0 });
  const natural = measured.src === src ? measured : { w: 0, h: 0 };
  const imgRef = useRef(null);
  // An image already in the cache can finish before React is listening for it.
  useEffect(() => {
    const img = imgRef.current;
    if (img?.complete && img.naturalWidth) setMeasured({ src, w: img.naturalWidth, h: img.naturalHeight });
  }, [src]);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [rotation, setRotation] = useState(0);
  const drag = useRef(null);
  // Read by the wheel listener, which is attached once rather than on every
  // render (it has to be non-passive to stop the browser zooming the page).
  const view = useRef({ scale, offset });
  view.current = { scale, offset };

  // A different document is a fresh look at a different piece of paper.
  useEffect(() => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
    setRotation(0);
  }, [src]);

  useEffect(() => {
    const el = frameRef.current;
    if (!el) return undefined;
    const measure = () => setFrame({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Keep the image from being dragged off into empty space: it may be pushed
  // until its edge meets the frame's centre, never further.
  const clampOffset = useCallback(
    (o, s) => {
      const limX = (frame.w * s) / 2;
      const limY = (frame.h * s) / 2;
      return { x: Math.max(-limX, Math.min(limX, o.x)), y: Math.max(-limY, Math.min(limY, o.y)) };
    },
    [frame.w, frame.h]
  );

  // Zoom to `next`, holding still whatever is under `point` (frame-centred px).
  const zoomTo = useCallback(
    (next, point = { x: 0, y: 0 }) => {
      const { scale: s, offset: o } = view.current;
      const s2 = clampScale(next);
      if (s2 === s) return;
      const k = s2 / s;
      const o2 = s2 === 1 ? { x: 0, y: 0 } : clampOffset({ x: point.x - (point.x - o.x) * k, y: point.y - (point.y - o.y) * k }, s2);
      // Written through at once: a fast wheel delivers several events before
      // React renders, and each has to build on the one before it rather than
      // on the scale the last render happened to see.
      view.current = { scale: s2, offset: o2 };
      setScale(s2);
      setOffset(o2);
    },
    [clampOffset]
  );

  const pointIn = (e) => {
    const r = frameRef.current.getBoundingClientRect();
    return { x: e.clientX - r.left - r.width / 2, y: e.clientY - r.top - r.height / 2 };
  };

  useEffect(() => {
    const el = frameRef.current;
    if (!el) return undefined;
    const onWheel = (e) => {
      if (!e.ctrlKey && !e.metaKey) return; // an ordinary scroll is the page's
      e.preventDefault();
      // A pinch sends small fractional deltas, a mouse wheel ±100 a notch.
      const factor = Math.exp(-e.deltaY * (Math.abs(e.deltaY) < 50 ? 0.01 : 0.002));
      zoomTo(view.current.scale * factor, pointIn(e));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomTo]);

  const onPointerDown = (e) => {
    if (scale <= 1 || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, o: offset };
  };
  const onPointerMove = (e) => {
    const d = drag.current;
    if (!d) return;
    setOffset(clampOffset({ x: d.o.x + e.clientX - d.x, y: d.o.y + e.clientY - d.y }, scale));
  };
  const endDrag = () => { drag.current = null; };

  const onDoubleClick = (e) => {
    if (scale > 1) zoomTo(1);
    else zoomTo(2.5, pointIn(e));
  };

  // The bitmap fitted to the frame, turned the way it is being viewed: a photo
  // on its side swaps which of its edges has to fit the frame's width.
  const turned = rotation % 180 !== 0;
  const nw = turned ? natural.h : natural.w;
  const nh = turned ? natural.w : natural.h;
  const fit = nw && nh && frame.w && frame.h ? Math.min(frame.w / nw, frame.h / nh) : 0;
  const width = fit ? natural.w * fit : undefined;
  const height = fit ? natural.h * fit : undefined;

  const zoomed = scale > 1;
  const btn = 'inline-flex h-7 w-7 items-center justify-center rounded hover:bg-muted disabled:opacity-40 disabled:hover:bg-transparent';

  return (
    <div
      ref={frameRef}
      className={cn('relative select-none overflow-hidden bg-muted/30', zoomed ? 'cursor-grab active:cursor-grabbing' : 'cursor-zoom-in', className)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={onDoubleClick}
      style={{ touchAction: zoomed ? 'none' : 'auto' }}
    >
      <img
        ref={imgRef}
        src={src}
        alt={alt}
        draggable={false}
        onLoad={(e) => setMeasured({ src, w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
        className="absolute left-1/2 top-1/2 max-w-none"
        style={{
          width,
          height,
          // Until the bitmap's size is known, fall back to the ordinary fit so
          // nothing flashes at full size.
          ...(fit ? {} : { maxWidth: '100%', maxHeight: '100%' }),
          transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px)) scale(${scale}) rotate(${rotation}deg)`,
          transition: drag.current ? 'none' : 'transform 80ms ease-out',
        }}
      />
      <div
        className="absolute bottom-2 right-2 flex items-center gap-0.5 rounded-md border bg-background/95 p-0.5 text-foreground shadow-sm"
        onPointerDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <button type="button" className={btn} onClick={() => zoomTo(scale / STEP)} disabled={!zoomed} aria-label="Zoom out" title="Zoom out">
          <Minus className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          className="h-7 min-w-[3rem] rounded px-1 text-xs tabular-nums hover:bg-muted"
          onClick={() => zoomTo(1)}
          title="Fit to frame · Ctrl/⌘ + scroll to zoom, drag to move"
        >
          {Math.round(scale * 100)}%
        </button>
        <button type="button" className={btn} onClick={() => zoomTo(scale * STEP)} disabled={scale >= MAX} aria-label="Zoom in" title="Zoom in">
          <Plus className="h-3.5 w-3.5" />
        </button>
        <button type="button" className={btn} onClick={() => zoomTo(1)} disabled={!zoomed} aria-label="Fit to frame" title="Fit to frame">
          <Maximize2 className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          className={btn}
          onClick={() => { setRotation((r) => (r + 90) % 360); setScale(1); setOffset({ x: 0, y: 0 }); }}
          aria-label="Rotate"
          title="Rotate"
        >
          <RotateCw className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
