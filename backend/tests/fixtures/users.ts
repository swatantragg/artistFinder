// Fictional people for the tests (the app itself starts with none: people sign up).
import type { User } from '../../src/domain/types';

export const FIXTURE_USERS: User[] = [
  { id: 'u-swatantra', name: 'Swatantra', role: 'System Owner' },
  { id: 'u-meenal', name: 'Meenal', role: 'Admin' },
  { id: 'u-vikram', name: 'Vikram', role: 'User' },
  { id: 'u-tara', name: 'Tara', role: 'User' },
  { id: 'u-dev', name: 'Dev', role: 'Admin' },
  { id: 'u-kabir', name: 'Kabir', role: 'Admin' },
];
