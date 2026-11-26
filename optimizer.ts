/**
 * Otimizador de Assets Adaptativo (TypeScript)
 * Uso da Network Information API para decisão dinâmica de carregamento de mídia.
 */

export type EffectiveConnectionType = 'slow-2g' | '2g' | '3g' | '4g';

export interface NetworkInformation {
  effectiveType?: EffectiveConnectionType;
  downlink?: number;
  rtt?: number;
  saveData?: boolean;
  addEventListener?: (type: string, listener: () => void) => void;
}

export function getAdaptiveAssetPath(baseName: string): string {
  const connection: NetworkInformation | undefined =
    (navigator as any).connection ||
    (navigator as any).mozConnection ||
    (navigator as any).webkitConnection;

  const effectiveType = connection ? connection.effectiveType : '4g';

  if (effectiveType === '2g' || effectiveType === 'slow-2g') {
    return `assets/${baseName}-2g.jpg`;
  } else if (effectiveType === '3g') {
    return `assets/${baseName}-3g.jpg`;
  }

  return `assets/${baseName}-4g.jpg`;
}
