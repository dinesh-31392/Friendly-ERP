/**
 * PWA install + service-worker registration.
 *
 * Covers the three install paths, which behave very differently:
 *  - Android / desktop Chrome+Edge: fire `beforeinstallprompt`; we capture it
 *    and replay it when the user clicks Install.
 *  - iOS / iPadOS Safari: NO install event exists at all. The only route is the
 *    user tapping Share → Add to Home Screen, so we detect iOS and show
 *    instructions instead of a button that could never work.
 *  - Firefox / others: no install support; we show nothing rather than a
 *    dead button.
 */

/** Chromium-only event; not in lib.dom yet. */
export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

let deferredPrompt: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(l => l());

/** Subscribe to install-availability changes. Returns an unsubscribe fn. */
export function onInstallStateChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Already installed? Then never offer to install again.
 * - display-mode: standalone covers Android + desktop.
 * - navigator.standalone is the iOS-only legacy flag (still the only signal
 *   Safari gives us).
 */
export function isInstalled(): boolean {
  if (typeof window === 'undefined') return false;
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches
    || window.matchMedia?.('(display-mode: minimal-ui)').matches;
  const iosStandalone = (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
  return Boolean(standalone || iosStandalone);
}

/**
 * iOS/iPadOS detection. iPadOS reports itself as "Macintosh", so the UA alone
 * is not enough — a Mac with a touchscreen doesn't exist, so touch points on a
 * "Mac" means iPad.
 */
export function isIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  const iphoneOrIpad = /iPad|iPhone|iPod/.test(ua);
  const ipadOsAsMac = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
  return iphoneOrIpad || ipadOsAsMac;
}

/** On iOS only Safari can install; Chrome/Firefox on iOS cannot. */
export function isIosSafari(): boolean {
  if (!isIos()) return false;
  const ua = navigator.userAgent;
  return !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
}

/** True when clicking Install would actually do something. */
export function canPromptInstall(): boolean {
  return deferredPrompt !== null;
}

/**
 * Show the browser's install dialog. Returns the user's choice, or 'unavailable'
 * when no prompt was captured. The event is single-use — Chrome will re-fire it
 * later if the user dismisses, so we clear it either way.
 */
export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  if (!deferredPrompt) return 'unavailable';
  const evt = deferredPrompt;
  deferredPrompt = null;
  notify();
  await evt.prompt();
  const { outcome } = await evt.userChoice;
  return outcome;
}

/**
 * Wire up install capture + register the service worker.
 * Safe to call once at startup; a no-op where unsupported.
 */
export function initPwa(): void {
  if (typeof window === 'undefined') return;

  window.addEventListener('beforeinstallprompt', (e) => {
    // Suppress Chrome's default mini-infobar so our own button is the single
    // entry point.
    e.preventDefault();
    deferredPrompt = e as BeforeInstallPromptEvent;
    notify();
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    notify();
  });

  // Service workers need a secure context: HTTPS, or localhost for development.
  // On a plain-IP http:// deployment this silently does nothing and the app
  // stays installable-but-not-offline — see DEPLOY.md.
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((err) => {
        console.warn('[pwa] service worker registration failed:', err?.message ?? err);
      });
    });
  }
}
