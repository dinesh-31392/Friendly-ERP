import { describe, it, expect } from 'vitest';
import { explainLeadScore, leadScoreBand } from './index';

/**
 * The lead score decides who a salesperson calls next, so the property that
 * matters is not any single number — it is that the score RISES through the
 * funnel. It did not: stage points were keyed on the default pipeline
 * (`visit_scheduled`) while the provisioning endpoint creates `site_visit`, so
 * those leads fell through to a flat fallback and scored BELOW a merely
 * qualified lead. A lead that had already been to site ranked worse than one
 * that had not.
 *
 * These tests are written against the pipeline a real workspace has, not the
 * constant the SPA ships, because that gap is the bug.
 */

// What tenantRoutes.ts actually provisions.
const PROVISIONED = ['new', 'contacted', 'qualified', 'site_visit', 'negotiation', 'booked', 'lost']
  .map(id => ({ id }));
// What the SPA's own default constant says.
const SPA_DEFAULT = ['new', 'contacted', 'qualified', 'visit_scheduled', 'negotiation', 'booked', 'lost']
  .map(id => ({ id }));

/** Same lead in every respect except where it sits in the funnel. */
const at = (stage: string) => ({
  stage: stage as never,
  priority: 'warm' as const,
  budget: 6_800_000,
  // Fixed offset rather than a literal date: recency points must not drift
  // with the calendar and turn this into a test that fails next week.
  lastContact: new Date(Date.now() - 3 * 86400000).toISOString(),
  source: 'Walk-in',
});

describe('explainLeadScore', () => {
  it('rises monotonically through the provisioned pipeline', () => {
    const open = ['new', 'contacted', 'qualified', 'site_visit', 'negotiation'];
    const scores = open.map(s => explainLeadScore(at(s), PROVISIONED).score);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i], `${open[i]} (${scores[i]}) must outrank ${open[i - 1]} (${scores[i - 1]})`)
        .toBeGreaterThan(scores[i - 1]);
    }
  });

  it('ranks a site visit above a qualification — the inversion this had', () => {
    const qualified = explainLeadScore(at('qualified'), PROVISIONED).score;
    const visited = explainLeadScore(at('site_visit'), PROVISIONED).score;
    expect(visited).toBeGreaterThan(qualified);
  });

  it('scores the two pipelines equivalently at the same funnel position', () => {
    // The stage is spelled differently; it means the same thing, so it must
    // score the same. Anything else makes the number depend on which code path
    // created the workspace.
    expect(explainLeadScore(at('site_visit'), PROVISIONED).score)
      .toBe(explainLeadScore(at('visit_scheduled'), SPA_DEFAULT).score);
  });

  it('still scores a stage no pipeline was supplied for', () => {
    // The old flat fallback. Not wrong on its own — wrong only when a real
    // pipeline was available and went unused.
    const s = explainLeadScore(at('some_custom_stage')).score;
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThanOrEqual(100);
  });

  it('advises confirming the visit, not booking one, for a lead already at site', () => {
    // The advice checked one exact spelling, so a provisioned workspace was
    // told to "book a site visit" for leads that had already had one.
    const { nextBestAction } = explainLeadScore(at('site_visit'), PROVISIONED);
    expect(nextBestAction).toMatch(/confirm the site visit/i);
  });

  it('never exceeds 100', () => {
    const maxed = {
      stage: 'negotiation' as never, priority: 'hot' as const, budget: 50_000_000,
      lastContact: new Date().toISOString(), source: 'Referral',
    };
    expect(explainLeadScore(maxed, PROVISIONED).score).toBeLessThanOrEqual(100);
  });

  it('gives a lost lead no stage credit', () => {
    const lost = explainLeadScore(at('lost'), PROVISIONED);
    expect(lost.factors.find(f => f.label === 'Pipeline stage')?.points).toBe(0);
  });
});

describe('leadScoreBand', () => {
  it('bands at the documented thresholds', () => {
    expect(leadScoreBand(70).label).toBe('Hot');
    expect(leadScoreBand(69).label).toBe('Warm');
    expect(leadScoreBand(45).label).toBe('Warm');
    expect(leadScoreBand(44).label).toBe('Cold');
    expect(leadScoreBand(0).label).toBe('Cold');
  });
});
