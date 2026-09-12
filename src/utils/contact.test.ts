import { describe, it, expect } from 'vitest';
import { telHref, mailtoHref, whatsappHref, maskPhone } from './contact';

describe('maskPhone', () => {
  it('hides the last four digits', () => {
    expect(maskPhone('9820000006')).toBe('982000XXXX');
  });

  it('keeps a formatted number readable', () => {
    // Masks DIGITS, not characters, so separators survive and the number keeps
    // the shape a person recognises.
    expect(maskPhone('+91 98200 00006')).toBe('+91 98200 0XXXX');
  });

  it('masks what there is when the number is short', () => {
    expect(maskPhone('123')).toBe('XXX');
  });

  it('leaves an empty value empty rather than printing XXXX', () => {
    // A lead with no phone must read as absent, not as a hidden number.
    expect(maskPhone('')).toBe('');
  });

  it('does not touch the number the links carry', () => {
    // The mask is a display control. Click-to-call has to keep working from
    // the list, so the href is deliberately unmasked — asserted here so nobody
    // "fixes" the inconsistency and breaks dialling.
    const phone = '9820000006';
    expect(telHref(phone)).toBe('tel:9820000006');
    expect(whatsappHref(phone)).toContain('9820000006');
  });
});

describe('mailtoHref', () => {
  it('encodes the recipient so extra headers cannot be injected', () => {
    // A lead's address can arrive from the public microsite. Left raw,
    // `a@b.com?cc=attacker@x.com` would smuggle a cc into the draft.
    const href = mailtoHref('a@b.com?cc=attacker@x.com');
    expect(href.startsWith('mailto:')).toBe(true);
    expect(href).not.toContain('?cc=');
    expect(href).toContain('%3F');
  });

  it('puts a subject and body in the query, not the address', () => {
    const href = mailtoHref('buyer@example.com', 'Your booking', 'Hello there');
    expect(href).toMatch(/^mailto:buyer%40example\.com\?/);
    expect(href).toContain('subject=Your+booking');
  });

  it('trims stray whitespace around the address', () => {
    expect(mailtoHref('  buyer@example.com ')).toBe('mailto:buyer%40example.com');
  });
});

describe('telHref', () => {
  it('strips formatting but keeps a leading +', () => {
    expect(telHref('+91 98200-00006')).toBe('tel:+919820000006');
  });
});
