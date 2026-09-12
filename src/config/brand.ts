/**
 * The product's own name, in one place.
 *
 * WHY THIS EXISTS
 *
 * The name was written out by hand in eighteen files across the SPA and the
 * server, in eight different spellings — "Friendly ERP", "FriendlyERP",
 * "Friendly-ERP", "friendly-erp", "friendlycrm", "friendly-crm". Renaming the
 * product meant finding all of them, and missing one showed a stale name on a
 * sign-in page or an install prompt.
 *
 * Everything a person READS now comes from here.
 *
 * TWO DIFFERENT NAMES, DELIBERATELY NOT MERGED
 *
 * This is a white-label product, so there are two names on screen and they are
 * not interchangeable:
 *
 *   BRAND.name        the vendor's — "Powered by Friendly ERP", the sign-in
 *                     page, the install prompt, the terms link.
 *   tenant.name       the builder's own, shown inside their workspace and on
 *                     their portal and microsite.
 *
 * `BRAND.name` doubles as the fallback when a workspace has not set its own
 * (`tenant?.name || BRAND.name`). That is the same string but a different
 * meaning, and the call sites say which one they mean.
 *
 * WHAT THIS DOES **NOT** RENAME
 *
 * Four identifiers keep the historical `friendly-crm` spelling on purpose,
 * because they are wire or storage formats rather than words anyone reads.
 * Changing them is not a rename, it is a migration:
 *
 *   JWT issuer            `friendly-crm` — signed into every live token and
 *                         checked on every request. Changing it invalidates
 *                         every session at once and signs everybody out.
 *   localStorage prefix   `friendly_crm_` — changing it orphans the demo
 *                         workspace's data in every browser that has one.
 *   Database name         `friendly_crm` — a connection string, not a label.
 *   Health service id     `friendly-crm-api` — external monitors may match on
 *                         it.
 *
 * Each of those four carries a comment at its own site pointing back here.
 */

/**
 * Overridable at build time so a deployment can be re-branded without a code
 * change — `VITE_BRAND_NAME="Acme Cloud" npm run build`. Vite inlines these at
 * build, so there is no runtime cost and no request for them.
 */
export const BRAND = {
  /** The product name, as a person reads it. */
  name: import.meta.env.VITE_BRAND_NAME || 'Friendly ERP',

  /** Longer form, for a document title or an app store listing. */
  tagline: import.meta.env.VITE_BRAND_TAGLINE || 'Real Estate & Construction ERP',

  /**
   * Where tenant portals and microsites live: `<workspace>.friendlyerp.app`.
   * Kept here because it appears in four screens and a settings field, and a
   * deployment on its own domain has to change all of them together.
   */
  portalDomain: import.meta.env.VITE_PORTAL_DOMAIN || 'friendlyerp.app',
} as const;

/** "Friendly ERP — Real Estate & Construction ERP", for a title or listing. */
export const brandFullName = (): string => `${BRAND.name} — ${BRAND.tagline}`;

/**
 * A workspace's portal address: `acme.friendlyerp.app`.
 *
 * The slug is optional because a workspace on a free plan has not claimed one
 * — showing the bare domain is better than showing "undefined.friendlyerp.app".
 */
export const portalHost = (slug?: string | null): string =>
  slug ? `${slug}.${BRAND.portalDomain}` : BRAND.portalDomain;
