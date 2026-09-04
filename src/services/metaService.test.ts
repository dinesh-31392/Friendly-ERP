import { describe, it, expect, beforeEach } from 'vitest';

/**
 * Stage keys are TENANT DATA, and two provisioning paths shipped two different
 * ones — seed.ts wrote `visit_scheduled`, the provisioning endpoint wrote
 * `site_visit`. Code that hardcoded either spelling silently did nothing for
 * workspaces created the other way: the Calendar's visit list came back empty,
 * and "schedule a visit" wrote a stage validate_lead_stage refuses.
 *
 * These tests run both pipelines through the same resolver, because a single
 * database really does hold both.
 */

// metaService reads localStorage and announces changes on `window`. Vitest's
// default environment is node, so stub both rather than pulling in a whole DOM
// for two APIs — the module under test is pure logic over a string store.
const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
} as Storage;
(globalThis as unknown as { window: { dispatchEvent: (e: Event) => boolean } }).window = {
  dispatchEvent: () => true,
};

const { getVisitStageId, getLeadStages, saveTenantMeta, getTenantMeta } =
  await import('./metaService');

const TENANT = 't1';
const pipeline = (ids: string[], labels?: string[]) =>
  ids.map((id, i) => ({ id, label: labels?.[i] ?? id, color: 'bg-zinc-500' }));

const setPipeline = (stages: ReturnType<typeof pipeline>) =>
  saveTenantMeta(TENANT, { ...getTenantMeta(TENANT), stages: stages as never });

beforeEach(() => store.clear());

describe('getVisitStageId', () => {
  it('finds the stage a provisioned workspace actually uses', () => {
    setPipeline(pipeline(['new', 'contacted', 'qualified', 'site_visit', 'negotiation', 'booked', 'lost']));
    expect(getVisitStageId(TENANT)).toBe('site_visit');
  });

  it('finds it under the other spelling too', () => {
    setPipeline(pipeline(['new', 'contacted', 'qualified', 'visit_scheduled', 'negotiation', 'booked', 'lost']));
    expect(getVisitStageId(TENANT)).toBe('visit_scheduled');
  });

  it('falls back to the label when the key says nothing about visits', () => {
    // A builder who renames stages gets slug keys from the label, but an
    // imported or hand-edited pipeline may not.
    setPipeline(pipeline(['new', 'stage_4', 'booked', 'lost'], ['New', 'Site Revisit', 'Booked', 'Lost']));
    expect(getVisitStageId(TENANT)).toBe('stage_4');
  });

  it('returns undefined when the pipeline genuinely has no visit stage', () => {
    // Callers must handle this rather than write a key the database refuses.
    setPipeline(pipeline(['new', 'contacted', 'booked', 'lost']));
    expect(getVisitStageId(TENANT)).toBeUndefined();
  });
});

describe('getLeadStages', () => {
  it('gives a usable default before any pipeline has been stored', () => {
    // A workspace with no cached meta must still render a board.
    const stages = getLeadStages(TENANT);
    expect(stages.length).toBeGreaterThan(2);
    expect(stages.map(s => s.id)).toContain('new');
  });

  it('re-adds a core stage that was saved away', () => {
    // new / booked / lost anchor entry and the two terminal outcomes; reports,
    // bookings and at-risk logic all assume they exist.
    setPipeline(pipeline(['contacted', 'qualified']));
    const ids = getLeadStages(TENANT).map(s => s.id);
    expect(ids).toContain('new');
    expect(ids).toContain('booked');
    expect(ids).toContain('lost');
  });
});
