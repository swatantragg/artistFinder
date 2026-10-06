// The workspace the app starts with: the prototype's users (role switch, no passwords) and no data. Artists, songs and
// credits only come from uploaded export files.
import { ENGINE_USER } from './discovery/pipeline';
import { Model } from './model';
import type { User } from './types';

export const USERS: User[] = [
  { id: 'u-swatantra', name: 'Swatantra', role: 'System Owner' },
  { id: 'u-meenal', name: 'Meenal', role: 'G Amplify Lead' },
  { id: 'u-vikram', name: 'Vikram', role: 'Operator' },
  { id: 'u-tara', name: 'Tara', role: 'Operator' },
  { id: 'u-dev', name: 'Dev', role: 'Claim Reviewer' },
  { id: 'u-kabir', name: 'Kabir', role: 'Admin' },
  { id: ENGINE_USER, name: 'Discovery engine', role: 'Automation' },
];
export const DEFAULT_USER = 'u-swatantra';

export function emptyModel(): Model {
  const m = new Model();
  for (const u of USERS) m.insert('users', u);
  m.setMeta('workspace', 'empty');
  m.setMeta('artistIdFormat', 'A6');   // permanent Artist IDs A000001, A000002 …
  m.setMeta('upgrade:v2', 'done');
  return m;
}
