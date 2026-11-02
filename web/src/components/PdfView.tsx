import { useEffect, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
// Bundle the worker locally (air-gap: no CDN).
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

export function PdfView({ url, pageNo, zoom, onPages }: { url: string; pageNo: number; zoom: number; onPages: (n: number) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const docRef = useRef<any>(null);
  const [err, setErr] = useState('');
  const renderTaskRef = useRef<any>(null);

  useEffect(() => {
    let cancelled = false;
    setErr('');
    const task = pdfjsLib.getDocument({ url });
    task.promise.then((doc: any) => {
      if (cancelled) return;
      docRef.current = doc;
      onPages(doc.numPages);
    }).catch((e: any) => !cancelled && setErr('Unable to render PDF: ' + e.message));
    return () => { cancelled = true; };
  }, [url]);

  useEffect(() => {
    let cancelled = false;
    const render = async () => {
      const doc = docRef.current;
      if (!doc || !canvasRef.current) return;
      try {
        const page = await doc.getPage(Math.min(pageNo, doc.numPages));
        if (cancelled) return;
        const viewport = page.getViewport({ scale: zoom * 1.4 });
        const canvas = canvasRef.current;
        const ctx = canvas.getContext('2d')!;
        canvas.width = viewport.width; canvas.height = viewport.height;
        if (renderTaskRef.current) { try { renderTaskRef.current.cancel(); } catch {} }
        renderTaskRef.current = page.render({ canvasContext: ctx, viewport });
        await renderTaskRef.current.promise;
      } catch (e: any) { if (e?.name !== 'RenderingCancelledException') setErr('Render error'); }
    };
    render();
    return () => { cancelled = true; };
  }, [pageNo, zoom, url]);

  if (err) return <div className="text-rose-600 p-8 text-center">{err}</div>;
  return <canvas ref={canvasRef} className="mx-auto shadow-panel rounded bg-white" />;
}
