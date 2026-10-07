// The workspace the app starts with: no people and no data. People join by signing up (the first account is the System
// Owner); artists, songs and credits only come from uploaded export files.
import { ENGINE_USER } from './discovery/pipeline';
import { Model } from './model';
import type { User } from './types';

/** The discovery engine writes its own history entries under this user. */
export const SYSTEM_USERS: User[] = [{ id: ENGINE_USER, name: 'Discovery engine', role: 'Automation' }];

/** An empty workspace. `people` keeps the signed-up users when the workspace is reset. */
export function emptyModel(people: User[] = []): Model {
  const m = new Model();
  for (const u of SYSTEM_USERS) m.insert('users', u);
  for (const u of people) if (!m.get('users', u.id)) m.insert('users', u);
  m.setMeta('workspace', 'empty');
  m.setMeta('artistIdFormat', 'A6');   // permanent Artist IDs A000001, A000002 …
  m.setMeta('upgrade:v2', 'done');
  m.setMeta('upgrade:roles-v2.3', 'done');
  return m;
}
