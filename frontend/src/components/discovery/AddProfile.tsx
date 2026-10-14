// Add an artist's profile by hand when Find artist missed it. Only a real profile link of the chosen platform is accepted
// (checked while typing and again on the server), so no other link (and no malware link) can be saved.
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { MANUAL_PLATFORMS, manualProfileProblem } from '@domain/discovery/normalize';
import { useApp } from '../../lib/app';
import { Button, Field, Modal, Notice, Select } from '../ui';
import { PlatformBadge, handleOf } from './bits';

export interface VerifiedLite { profileId: string | null; platform: string; username: string | null; url: string }

export function AddProfileButton({ caseId, name, verified, size = 'md', variant = 'secondary' }: { caseId: string; name: string; verified: VerifiedLite[]; size?: 'sm' | 'md'; variant?: 'primary' | 'secondary' | 'ghost' }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size={size} variant={variant} icon={<Plus size={15} />} onClick={() => setOpen(true)}>Add profile by hand</Button>
      {open && <AddProfileModal caseId={caseId} name={name} verified={verified} onClose={() => setOpen(false)} />}
    </>
  );
}

function AddProfileModal({ caseId, name, verified, onClose }: { caseId: string; name: string; verified: VerifiedLite[]; onClose: () => void }) {
  const { run } = useApp();
  const [platform, setPlatform] = useState('');
  const [url, setUrl] = useState('');
  const [note, setNote] = useState('');
  const [replace, setReplace] = useState(false);
  const [busy, setBusy] = useState(false);
  const example = MANUAL_PLATFORMS.find(p => p.platform === platform)?.example;
  const check = platform && url.trim() ? manualProfileProblem(platform, url) : null;
  const ok = !!check && !check.problem;
  const old = verified.find(v => v.platform === platform && v.profileId && v.url !== check?.norm?.url);
  const go = async () => {
    setBusy(true);
    const res = await run('addProfileByHand', { caseId, platform, url: url.trim(), note, replaceProfileId: replace && old ? old.profileId : undefined });
    setBusy(false);
    if (res) onClose();
  };
  return (
    <Modal open onClose={onClose} title={`Add a profile of ${name} by hand`}
      description="For a profile Find artist did not find. Pick the platform, then paste the link to the artist’s profile on it. Only links of that platform are accepted."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!ok} loading={busy} onClick={go}>Add and verify</Button></>}>
      <div className="space-y-4">
        <Field label="1. Platform" required>
          <Select value={platform} onChange={v => { setPlatform(v); setReplace(false); }} placeholder="Choose the platform…" ariaLabel="Platform"
            options={MANUAL_PLATFORMS.map(p => ({ value: p.platform, text: p.platform, label: <span className="inline-flex items-center gap-2"><PlatformBadge platform={p.platform} size="sm" />{p.platform}</span> }))} />
        </Field>
        <Field label="2. Link to the profile" required help={example ? <>For example <span className="mono break-all">{example}</span></> : 'Pick the platform first.'}>
          <input className="field mono" value={url} onChange={e => setUrl(e.target.value)} placeholder={example ?? 'https://…'} disabled={!platform} inputMode="url" autoComplete="off" spellCheck={false} autoFocus={!!platform} />
        </Field>
        {check && (check.problem
          ? <Notice tone="red" title="This link can’t be added">{check.problem}</Notice>
          : <Notice tone="green" title={`Looks right: ${platform} ${handleOf(platform, check.norm?.username) ?? ''}`}><span className="mono break-all">{check.norm?.url}</span></Notice>)}
        {ok && old && (
          <label className="flex cursor-pointer items-start gap-2 rounded-md border border-line p-3 text-sm text-ink-2">
            <input type="checkbox" className="mt-1" checked={replace} onChange={e => setReplace(e.target.checked)} />
            <span>Replace the verified {platform} <b className="text-ink">{handleOf(platform, old.username) ?? old.url}</b>: it was the wrong profile. It stays in history as replaced.</span>
          </label>
        )}
        <Field label="Note (optional)" help="Where you found it. Kept in the timeline.">
          <input className="field" value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. Google: “Singer Shaan instagram”, first result" />
        </Field>
      </div>
    </Modal>
  );
}
