// "What's new": a one-time summary of the changes in this version, shown once per browser after an update.
// Clicking the version in the footer opens it again.
import { Check, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import { CHANGES, VERSION } from '../lib/version';
import { Button, Modal } from './ui';

const KEY = 'artistfinder.whatsNew';      // last version seen ('off' = never show)
const EVENT = 'artistfinder:whatsnew';
export const showWhatsNew = () => window.dispatchEvent(new Event(EVENT));

export function WhatsNew() {
  const [open, setOpen] = useState(false);
  const changes = CHANGES[VERSION] ?? [];
  useEffect(() => {
    try { const seen = localStorage.getItem(KEY); if (changes.length && seen !== VERSION && seen !== 'off') setOpen(true); } catch { /* storage blocked: skip */ }
    const show = () => setOpen(true);
    window.addEventListener(EVENT, show);
    return () => window.removeEventListener(EVENT, show);
  }, [changes.length]);
  const close = () => { setOpen(false); try { if (localStorage.getItem(KEY) !== 'off') localStorage.setItem(KEY, VERSION); } catch { /* per-browser convenience only */ } };
  return (
    <Modal open={open} onClose={close} width={620} title={<span className="flex items-center gap-2"><Sparkles size={18} className="text-accent-text" />What’s new</span>} description={`Version ${VERSION}`}
      footer={<Button variant="primary" onClick={close}>Got it</Button>}>
      <ul className="space-y-2.5 text-sm text-ink-2">
        {changes.map(c => <li key={c} className="flex gap-2.5"><Check size={16} className="mt-0.5 shrink-0 text-[var(--t-green)]" /><span>{c}</span></li>)}
      </ul>
    </Modal>
  );
}
