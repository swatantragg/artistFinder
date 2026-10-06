// Test fixtures: an engine on the fictional fixture workspace with the fictional web as its search providers, so the tests
// run offline (no database, no API keys, no quota). The app itself never uses these.
import { Engine, type EngineOptions, type Store } from '../../src/domain/engine';
import type { Model } from '../../src/domain/model';
import { InternalCatalogueProvider, type ProviderSet } from '../../src/domain/discovery/providers';
import { seedFixtures } from './seed';
import { fixtureProviders } from './web';

export const fixtureProviderSet = (getModel: () => Model, slow = false): ProviderSet => ({
  mode: 'live',
  providers: [new InternalCatalogueProvider(getModel), ...fixtureProviders(getModel, { slow })],
  notes: ['Test fixtures: a fictional web searched with the real pipeline.'],
});

/** Fast fixture engine for unit tests (no provider latency, no step pacing, no retry back-off). */
export const FAST: EngineOptions = { providers: g => fixtureProviderSet(g), seed: () => seedFixtures(), runner: { pace: () => 0, backoffMs: 0 } };

export function fixtureEngine(store: Store, opts: EngineOptions = {}): Engine {
  return new Engine(store, { ...FAST, ...opts });
}

/** Simulate a search provider outage on the fixture web (every fixture provider fails until switched off). */
export function setFixtureOutage(e: Engine, on: boolean) { e.m.setMeta('fixtures.outage', on ? 'on' : 'off'); }

export { seedFixtures };
