import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';

type Detector = { detect: (source: HTMLVideoElement) => Promise<{ rawValue: string }[]> };
type DetectorClass = new (options?: { formats?: string[] }) => Detector;
const detectorClass = () => (globalThis as { BarcodeDetector?: DetectorClass }).BarcodeDetector;
/** The camera button exists only where the browser reads barcodes (BarcodeDetector) and can open the camera. */
export function cameraSupported(): boolean {
  return typeof detectorClass() === 'function' && typeof globalThis.navigator?.mediaDevices?.getUserMedia === 'function';
}

/** Reads one barcode with the device camera and closes. The video never leaves the browser. */
export default function BarcodeCamera({ onCode, onClose }: { onCode: (code: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null), [error, setError] = useState(''), done = useRef(false);
  const live = useRef({ onCode, onClose }); live.current = { onCode, onClose };
  useEffect(() => {
    const Barcode = detectorClass(); if (!Barcode || !cameraSupported()) { setError('A leitura pela câmera não está disponível neste navegador.'); return; }
    let stream: MediaStream | null = null, timer: ReturnType<typeof setTimeout> | undefined, stopped = false;
    const detector = new Barcode({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf'] });
    const scan = async () => {
      if (stopped || done.current || !video.current) return;
      try { const found = await detector.detect(video.current); const code = found.find(item => item.rawValue?.trim())?.rawValue.trim();
        if (code && !stopped && !done.current) { done.current = true; live.current.onCode(code); live.current.onClose(); return; } } catch { /* Next frame. */ }
      timer = setTimeout(() => void scan(), 300);
    };
    void navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false }).then(media => {
      stream = media; if (stopped) { media.getTracks().forEach(track => track.stop()); return; }
      if (video.current) { video.current.srcObject = media; void video.current.play().catch(() => {}); }
      void scan();
    }).catch(() => { if (!stopped) setError('Não foi possível abrir a câmera. Confira a permissão do navegador.'); });
    return () => { stopped = true; if (timer) clearTimeout(timer); stream?.getTracks().forEach(track => track.stop()); };
  }, []);
  return <div className="stock-camera" role="dialog" aria-modal="true" aria-label="Ler código pela câmera">
    <div className="stock-camera-box">
      <header><h2>Ler código pela câmera</h2><button type="button" className="icon-button" aria-label="Fechar" onClick={onClose}><Icon name="xmark" size={14} /></button></header>
      {error ? <p className="real-alert" role="alert">{error}</p> : <video ref={video} muted playsInline aria-label="Imagem da câmera" />}
      <p className="real-help">Aponte a câmera para o código de barras do produto.</p>
    </div>
  </div>;
}
