import { useId } from 'react';
import { useUIStore } from '@/store/uiStore';
import { themeArtwork } from '@/theme';

interface ThemeArtworkProps {
  basePath: string;
  className: string;
}

export function ThemeArtwork({ basePath, className }: ThemeArtworkProps) {
  const themeId = useUIStore((state) => state.preferences.theme);
  const artwork = themeArtwork(themeId);
  const id = useId().replaceAll(':', '');
  if (artwork === 'prism') {
    const glassId = `${id}-prism-glass`;
    const glowId = `${id}-prism-glow`;
    return (
      <svg className={className} viewBox="0 0 512 512" aria-hidden="true" focusable="false" data-theme-artwork="prism">
        <defs>
          <linearGradient id={glassId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#ffffff" stopOpacity=".06" />
            <stop offset=".5" stopColor="#9fe9ff" stopOpacity=".18" />
            <stop offset="1" stopColor="#ffffff" stopOpacity=".03" />
          </linearGradient>
          <filter id={glowId} filterUnits="userSpaceOnUse" x="0" y="0" width="512" height="512">
            <feGaussianBlur stdDeviation="4" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>
        <rect width="512" height="512" fill="#000000" />
        <path d="M256 116 372 344H140Z" fill={`url(#${glassId})`} stroke="#e9fbff" strokeWidth="5" strokeLinejoin="round" filter={`url(#${glowId})`} />
        <line x1="20" y1="255" x2="286" y2="255" stroke="#ffffff" strokeWidth="6" strokeLinecap="round" filter={`url(#${glowId})`} />
        <g fill="none" strokeWidth="7" strokeLinecap="round" filter={`url(#${glowId})`}>
          <path d="M290 252 492 185" stroke="#ff3b4d" />
          <path d="M290 254 492 215" stroke="#ff8a32" />
          <path d="M290 256 492 245" stroke="#ffe04a" />
          <path d="M290 258 492 275" stroke="#52e36e" />
          <path d="M290 260 492 305" stroke="#32d9ff" />
          <path d="M290 262 492 335" stroke="#4e7dff" />
          <path d="M290 264 492 365" stroke="#b55cff" />
        </g>
      </svg>
    );
  }
  const assetBase = basePath.endsWith('/') ? basePath : `${basePath}/`;
  return (
    <img
      className={className}
      src={`${assetBase}brand/cursem-official.png`}
      alt=""
      aria-hidden="true"
      data-theme-artwork="official"
    />
  );
}
