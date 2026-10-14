// Display preferences of this browser: the theme (light, dark or the system's) and the text size (five steps).
// Kept in localStorage (they belong to the screen, not the account) and applied before the first paint.
import { useSyncExternalStore } from 'react';

export type Theme = 'system' | 'light' | 'dark';
/** Five text sizes. 3 is the default; the size also grows with the screen (see styles.css). */
export const TEXT_SIZES = [
  { id: 1, label: 'Small', scale: 0.875 },
  { id: 2, label: 'Compact', scale: 0.9375 },
  { id: 3, label: 'Default', scale: 1 },
  { id: 4, label: 'Large', scale: 1.125 },
  { id: 5, label: 'Extra large', scale: 1.25 },
] as const;

const read = (key: string): string | null => { try { return localStorage.getItem(key); } catch { return null; } };
const write = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* private window: this visit only */ } };
const listeners = new Set<() => void>();
const changed = () => { for (const l of listeners) l(); };

const THEME_KEY = 'gamplify.theme';   // the key earlier versions used, so a saved choice is kept
export function getTheme(): Theme { const t = read(THEME_KEY); return t === 'light' || t === 'dark' ? t : 'system'; }
export function getTextSize(): number { const n = Number(read('af.textSize')); return n >= 1 && n <= 5 ? n : 3; }

function applyTheme(t: Theme) {
  const el = document.documentElement;
  if (t === 'system') delete el.dataset.theme; else el.dataset.theme = t;
}
function applyTextSize(n: number) {
  document.documentElement.style.setProperty('--text-scale', String(TEXT_SIZES[n - 1].scale));
}
export function setTheme(t: Theme) { write(THEME_KEY, t); applyTheme(t); changed(); }
export function setTextSize(n: number) { const v = Math.min(5, Math.max(1, Math.round(n))); write('af.textSize', String(v)); applyTextSize(v); changed(); }
/** Call once before rendering, so the page never flashes the wrong theme or size. */
export function applyPrefs() { applyTheme(getTheme()); applyTextSize(getTextSize()); }

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
/** The current preferences; components re-render when they change. */
export function usePrefs() {
  const theme = useSyncExternalStore(subscribe, getTheme, () => 'system' as Theme);
  const textSize = useSyncExternalStore(subscribe, getTextSize, () => 3);
  return { theme, textSize };
}
