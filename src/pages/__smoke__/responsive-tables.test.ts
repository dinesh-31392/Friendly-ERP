import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * A phone must not be shown a table with its columns deleted.
 *
 * THE DEFECT THIS PINS
 *
 * Every data table in this app already sat inside an `overflow-x-auto` wrapper,
 * and every one also carried `className="w-full"` — which pins the table to the
 * wrapper's width, so the scroller could never engage. To make the columns fit
 * a 375px screen they were instead marked `hidden md:table-cell`, and at that
 * width they were not narrow, they were gone: the wrapper was overflow-x
 * visible, so nothing scrolled them back into reach.
 *
 * Measured on a 375px viewport before the fix: the Accounts ledger lost Debits
 * and Credits, Land lost the asking price, BD lost the deal value, Procurement
 * lost the vendor's phone number. The single number each page exists for,
 * unreachable on the device most of these users actually hold.
 *
 * The fix is one line per table — a min-width, so the wrapper that was always
 * there starts working. Verified in a real browser: at 375px the Accounts table
 * is 680px inside a 341px wrapper and scrolls within its own box, while the
 * PAGE overflow stays at zero; at desktop it fills its 898px container with no
 * scrollbar at all.
 *
 * WHY THIS IS A SOURCE-LEVEL TEST
 *
 * jsdom does no layout — every width it reports is zero — so a rendering test
 * cannot tell a scrolling table from a crushed one. The property that actually
 * regressed is textual and is checked as such: no page may hide a table column
 * below a breakpoint, and any table wide enough to need it must declare a
 * min-width so its wrapper can scroll.
 *
 * Leads is exempt and says so below: it switches to a card layout on phones
 * rather than showing a table at all, so its desktop-only columns are fine.
 */

const PAGES_DIR = path.resolve(__dirname, '..');

/** Pages that answer narrow screens with a different layout, not a table. */
const CARD_LAYOUT_PAGES = new Set(['Leads.tsx']);

/** Every `<table …>` opening tag in a source file. */
const TABLE_TAG = (src: string): string[] => src.match(/<table[^>]*>/g) ?? [];

function pageSources(): { name: string; src: string }[] {
  return fs.readdirSync(PAGES_DIR)
    .filter(f => f.endsWith('.tsx'))
    .map(name => ({ name, src: fs.readFileSync(path.join(PAGES_DIR, name), 'utf8') }));
}

describe('data tables stay usable on a phone', () => {
  it('no page hides table columns below a breakpoint', () => {
    const offenders = pageSources()
      .filter(p => !CARD_LAYOUT_PAGES.has(p.name))
      .map(p => ({
        name: p.name,
        hidden: (p.src.match(/hidden (?:sm|md|lg):table-cell/g) ?? []).length,
      }))
      .filter(p => p.hidden > 0);

    // Before the fix this listed seven pages and 32 columns.
    expect(offenders, `these pages delete columns on small screens instead of letting the table scroll: ${
      offenders.map(o => `${o.name} (${o.hidden})`).join(', ')}`).toEqual([]);
  });

  it('a table that needs to scroll declares a min-width so its wrapper can', () => {
    // The positive control. Were the rule above satisfied by deleting every
    // table in the app, this would fail — it insists the widened tables exist.
    //
    // Matched on the <table> TAG, not anywhere in the file. The first version of
    // this test looked for min-w-[…] in the source at large, which any unrelated
    // element satisfied — so removing the min-width from the ledger table left
    // it green. Falsifying it is what exposed that; a check that cannot fail is
    // worth less than no check, because it is trusted.
    const widened = pageSources()
      .filter(p => TABLE_TAG(p.src).some(tag => /min-w-\[\d+px\]/.test(tag)))
      .map(p => p.name);

    expect(widened.length).toBeGreaterThan(0);
    for (const name of ['Accounts.tsx', 'Land.tsx', 'BD.tsx', 'Procurement.tsx']) {
      expect(widened, `${name} carries a wide data table and must declare a min-width`).toContain(name);
    }
  });

  it('every widened table still fills its container on desktop', () => {
    // min-width alone would leave a 680px table in a 1200px column. The pair
    // `w-full min-w-[…]` is what makes it fill the space on a laptop and scroll
    // on a phone, so the two must always travel together.
    for (const { name, src } of pageSources()) {
      const widened = src.match(/<table className="[^"]*min-w-\[\d+px\][^"]*"/g) ?? [];
      for (const tag of widened) {
        expect(tag, `${name}: a min-width table must also be w-full, or it will not fill a desktop column`)
          .toMatch(/\bw-full\b/);
      }
    }
  });
});
