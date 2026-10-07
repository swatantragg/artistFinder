// The two status families look different on purpose (v2 §44): identity is a solid badge, Goongoonalo an outlined one.
import { Music2 } from 'lucide-react';
import { ARTIST_STATUS_INFO, GOONGOONALO_INFO, type ArtistStatus, type GoongoonaloStatus } from '@domain/constants';
import { Badge, cx } from './ui';

export function IdentityBadge({ status, className }: { status: string; className?: string }) {
  const info = ARTIST_STATUS_INFO[status as ArtistStatus];
  if (!info) return <Badge className={className}>{status}</Badge>;
  return <Badge tone={info.tone} dot title={info.meaning} className={cx('font-semibold uppercase tracking-wide', className)}>{info.label}</Badge>;
}
export function GoongoonaloBadge({ status, className, compact }: { status: string; className?: string; compact?: boolean }) {
  const info = GOONGOONALO_INFO[status as GoongoonaloStatus];
  const tone = info?.tone ?? 'neutral';
  return (
    <span title={info?.meaning} className={cx(`tone-${tone}`, 'inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-[1px] text-xs font-medium', tone === 'neutral' ? 'border-line-strong text-ink-2' : 'tone-text border-current', className)}>
      <Music2 size={11} className="shrink-0" />{compact ? info?.label : <>{info?.label ?? status}</>}
    </span>
  );
}
export function KindBadge({ kind }: { kind: string }) {
  if (kind !== 'Collaborator') return null;
  return <Badge tone="neutral" title="Only credited as composer, lyricist, producer … (not as a lead or performing artist)">Collaborator</Badge>;
}
