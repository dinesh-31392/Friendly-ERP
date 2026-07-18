import { useEffect, useState } from 'react';
import { Download, X, Share, Plus, MonitorSmartphone, Smartphone, Monitor, Lock, CheckCircle2 } from 'lucide-react';
import {
  canPromptInstall, promptInstall, isInstalled, isIos, isIosSafari, onInstallStateChange,
} from '../services/pwaService';
import toast from 'react-hot-toast';

type Platform = 'android' | 'ios' | 'desktop';

function detectPlatform(): Platform {
  if (isIos()) return 'ios';
  if (/Android/i.test(navigator.userAgent)) return 'android';
  return 'desktop';
}

/**
 * "Get the app" — installs Friendly CRM as a real app on phone, tablet, desktop.
 *
 * Two modes:
 *  - alwaysShow (login page): ALWAYS offered, so people can discover that the
 *    app is installable at all. If the browser handed us a native install
 *    prompt we fire it; otherwise we show per-platform instructions. An earlier
 *    version rendered nothing unless `beforeinstallprompt` had fired, which
 *    meant the option was invisible in every browser that never fires it
 *    (Safari, Firefox, embedded webviews) — a button nobody can see is not a
 *    feature.
 *  - compact (app header): only appears when a real prompt is available, to
 *    keep the toolbar quiet for people already using it in a browser.
 *
 * Hidden in both modes once the app is actually installed.
 */
export default function InstallAppButton({
  compact = false,
  alwaysShow = false,
}: { compact?: boolean; alwaysShow?: boolean }) {
  const [canPrompt, setCanPrompt] = useState(canPromptInstall());
  const [installed, setInstalled] = useState(isInstalled());
  const [showHelp, setShowHelp] = useState(false);

  useEffect(() => {
    const sync = () => { setCanPrompt(canPromptInstall()); setInstalled(isInstalled()); };
    const unsub = onInstallStateChange(sync);
    const mq = window.matchMedia('(display-mode: standalone)');
    mq.addEventListener?.('change', sync);
    return () => { unsub(); mq.removeEventListener?.('change', sync); };
  }, []);

  // Already running as an installed app — nothing to offer.
  if (installed) return null;
  if (!alwaysShow && !canPrompt && !isIosSafari()) return null;

  const handleClick = async () => {
    if (canPrompt) {
      const outcome = await promptInstall();
      if (outcome === 'accepted') toast.success('Installing Friendly CRM…');
      return;
    }
    // No native prompt available (iOS always, Firefox, or Chrome hasn't offered
    // it yet) — tell the user how to do it by hand instead of doing nothing.
    setShowHelp(true);
  };

  const platform = detectPlatform();
  const secure = typeof window !== 'undefined' && window.isSecureContext;

  const STEPS: Record<Platform, { icon: typeof Smartphone; title: string; steps: React.ReactNode[] }> = {
    android: {
      icon: Smartphone, title: 'Android phone or tablet',
      steps: [
        <>Open this page in <span className="font-semibold">Chrome</span></>,
        <>Tap the <span className="font-semibold">⋮</span> menu (top-right)</>,
        <>Choose <span className="font-semibold">Install app</span> or <span className="font-semibold">Add to Home screen</span></>,
      ],
    },
    ios: {
      icon: Smartphone, title: 'iPhone or iPad',
      steps: [
        <>Open this page in <span className="font-semibold">Safari</span> (Chrome on iOS cannot install)</>,
        <>Tap <Share className="h-3.5 w-3.5 inline text-indigo-500" /> <span className="font-semibold">Share</span> in the toolbar</>,
        <>Choose <Plus className="h-3.5 w-3.5 inline text-indigo-500" /> <span className="font-semibold">Add to Home Screen</span></>,
      ],
    },
    desktop: {
      icon: Monitor, title: 'Windows, macOS or Linux',
      steps: [
        <>Use <span className="font-semibold">Chrome</span> or <span className="font-semibold">Edge</span></>,
        <>Click the <span className="font-semibold">install icon</span> in the address bar (a screen with a ⬇), or ⋮ → <span className="font-semibold">Install</span></>,
        <>Friendly CRM opens in its own window, like any desktop app</>,
      ],
    },
  };
  const order: Platform[] = [platform, ...(['android', 'ios', 'desktop'] as Platform[]).filter(p => p !== platform)];

  return (
    <>
      <button
        onClick={handleClick}
        title="Install Friendly CRM as an app"
        className={compact
          ? 'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold bg-indigo-50 text-indigo-700 hover:bg-indigo-100 transition-colors'
          : 'flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold bg-white border border-zinc-200 text-zinc-700 hover:bg-zinc-50 hover:border-zinc-300 shadow-sm transition-colors'}
      >
        <Download className={compact ? 'h-3.5 w-3.5' : 'h-4 w-4 text-indigo-500'} />
        {compact ? 'Install app' : 'Get the app'}
      </button>

      {showHelp && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/50 backdrop-blur-sm p-4 overflow-y-auto"
          onClick={() => setShowHelp(false)}
          role="dialog" aria-modal="true" aria-label="Install Friendly CRM"
        >
          <div className="w-full max-w-md bg-white rounded-2xl shadow-xl border border-zinc-200 p-6 my-8" onClick={e => e.stopPropagation()}>
            <div className="flex items-start justify-between mb-1">
              <div className="flex items-center gap-2.5">
                <div className="h-9 w-9 rounded-xl bg-indigo-50 flex items-center justify-center">
                  <MonitorSmartphone className="h-4 w-4 text-indigo-500" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-zinc-900">Install Friendly CRM</h3>
                  <p className="text-[11px] text-zinc-500">Works on phone, tablet and desktop — no app store needed.</p>
                </div>
              </div>
              <button onClick={() => setShowHelp(false)} aria-label="Close" className="text-zinc-400 hover:text-zinc-600">
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* An insecure origin is the single most common reason install is
                unavailable, and the browser gives no visible clue — say so. */}
            {!secure && (
              <div className="mt-4 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3">
                <Lock className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
                <p className="text-[11px] text-amber-800">
                  This site is served over <span className="font-semibold">http</span>. Browsers only allow installing over <span className="font-semibold">https</span>, so the option is unavailable here. It will work once the site has an SSL certificate.
                </p>
              </div>
            )}

            <div className="mt-4 space-y-3">
              {order.map((p, i) => {
                const s = STEPS[p];
                const isCurrent = i === 0;
                return (
                  <div key={p} className={`rounded-xl border p-3 ${isCurrent ? 'border-indigo-200 bg-indigo-50/40' : 'border-zinc-200'}`}>
                    <p className="text-xs font-bold text-zinc-800 flex items-center gap-1.5 mb-2">
                      <s.icon className={`h-3.5 w-3.5 ${isCurrent ? 'text-indigo-500' : 'text-zinc-400'}`} />
                      {s.title}
                      {isCurrent && <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded-full bg-indigo-100 text-indigo-700">YOU'RE HERE</span>}
                    </p>
                    <ol className="space-y-1.5">
                      {s.steps.map((step, n) => (
                        <li key={n} className="flex items-start gap-2">
                          <span className="h-4 w-4 shrink-0 mt-0.5 rounded-full bg-zinc-100 text-zinc-600 text-[9px] font-bold flex items-center justify-center">{n + 1}</span>
                          <span className="text-[11px] text-zinc-600 leading-relaxed">{step}</span>
                        </li>
                      ))}
                    </ol>
                  </div>
                );
              })}
            </div>

            <div className="mt-4 flex items-start gap-2 rounded-xl bg-zinc-50 p-3">
              <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0 mt-0.5" />
              <p className="text-[11px] text-zinc-600">
                Once installed it opens full-screen from your home screen or desktop, and <span className="font-semibold">keeps working offline</span>.
              </p>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
