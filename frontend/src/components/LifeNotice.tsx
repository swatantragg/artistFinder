// "Is the artist alive?" on the artist page. When public records show a date of death, Find artist stops before searching
// and a person decides: continue anyway (e.g. to reach the family or the estate) or remove the artist (the next artist by
// songs takes the free place in the top 250). The decision is kept in the timeline; a removed artist can be restored.
import { AlertTriangle, ExternalLink, Flower2 } from 'lucide-react';
import { useState } from 'react';
import { diedText } from '@domain/life';
import type { LifeCheck } from '@domain/types';
import { useApp } from '../lib/app';
import { fmtDate } from '../lib/format';
import { Button, Field, Modal, Notice } from './ui';

export function LifeNotice({ caseId, name, life, searched }: { caseId: string; name: string; life: LifeCheck | null | undefined; searched?: boolean }) {
  const { run } = useApp();
  const [busy, setBusy] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  if (!life || life.status !== 'Deceased' || life.decision === 'Removed') return null;
  const died = diedText(life);
  const source = life.source && (
    <a href={life.source} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium text-accent-text underline">Check the source<ExternalLink size={12} /></a>
  );
  if (life.decision === 'Proceed') {
    return (
      <Notice tone="neutral" icon={<Flower2 size={18} />} title={`${name} has passed away (${died})`}>
        Continuing anyway (decided {fmtDate(life.decidedAt)}): messages go to the family, the estate or the artist’s team. {source}
      </Notice>
    );
  }
  const decide = async (decision: 'continue' | 'remove', note = '') => {
    setBusy(decision);
    const res = await run('decideLife', { caseId, decision, note });
    setBusy(null);
    if (res) setRemoving(false);
  };
  return (
    <>
      <Notice tone="orange" icon={<AlertTriangle size={18} />} title={`${name} is no more: passed away (${died})`}
        action={<span className="flex flex-wrap gap-2">
          <Button size="sm" variant="danger" onClick={() => setRemoving(true)}>Remove artist</Button>
          <Button size="sm" loading={busy === 'continue'} disabled={!!busy} onClick={() => decide('continue')}>Continue anyway</Button>
        </span>}>
        <span className="block">Public records show a date of death{life.label ? ` for ${life.label}` : ''}{life.description ? ` (${life.description})` : ''}. {searched ? 'The search ran before this check existed; what it found is kept.' : 'Find artist stopped before searching, so no search quota was used.'}</span>
        <span className="mt-1 block"><b>Continue anyway</b> to reach the family, the estate or the team; or <b>Remove artist</b>: the next artist by songs takes the free place in the top 250.</span>
        {life.others > 0 && <span className="mt-1 block font-medium">Another musician has the same name: open the source and check it is the same person.</span>}
        <span className="mt-1 block">{source}</span>
      </Notice>
      {removing && <RemoveModal name={name} died={died} busy={busy === 'remove'} onClose={() => setRemoving(false)} onRemove={note => decide('remove', note)} />}
    </>
  );
}

function RemoveModal({ name, died, busy, onClose, onRemove }: { name: string; died: string; busy: boolean; onClose: () => void; onRemove: (note: string) => void }) {
  const [note, setNote] = useState('');
  return (
    <Modal open onClose={onClose} title={`Remove ${name}?`}
      description={`Kept with the reason “Passed away (${died})” and every earlier step; nothing is deleted. The next artist by songs moves into the top 250. Restore any time from Artists → Rejected.`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="danger" loading={busy} onClick={() => onRemove(note)}>Yes, remove {name}</Button></>}>
      <Field label="Note (optional)" help="Kept in the timeline with the reason.">
        <input className="field" value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. Confirmed on the family’s page" autoFocus />
      </Field>
    </Modal>
  );
}
