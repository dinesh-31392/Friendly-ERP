import nodemailer, { type Transporter } from 'nodemailer';

/**
 * The product name in outbound mail.
 *
 * The SPA reads this from src/config/brand.ts; the server cannot import
 * across that boundary, so it takes the same override env var and falls
 * back to the same default. A re-brand sets BRAND_NAME here and
 * VITE_BRAND_NAME there.
 */
const BRAND_NAME = process.env.BRAND_NAME || 'Friendly ERP';

/**
 * Outbound email. Currently one message type: the login code.
 *
 * SMTP rather than a provider SDK, because that keeps the choice in the .env
 * instead of the code — Microsoft 365, Resend, Postmark and Brevo all speak
 * it, and switching provider after a deliverability problem should not be a
 * redeploy.
 */

let cached: Transporter | null = null;
let warned = false;

/**
 * MAIL_TRANSPORT=console prints the message to the log instead of sending it.
 *
 * For bringing a server up before SMTP credentials exist, and for tests. It
 * announces itself on every send precisely because a deployment that ends up in
 * this mode by accident would be printing live sign-in codes into its logs —
 * that has to be impossible to miss rather than a quiet default.
 */
const CONSOLE_MODE = process.env.MAIL_TRANSPORT === 'console';

export function mailConfigured(): boolean {
  return CONSOLE_MODE || !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function transport(): Transporter | null {
  if (CONSOLE_MODE) {
    cached ??= nodemailer.createTransport({ jsonTransport: true });
    return cached;
  }
  if (!mailConfigured()) {
    if (!warned) {
      console.warn('[mail] SMTP is not configured — login codes cannot be delivered');
      warned = true;
    }
    return null;
  }
  if (cached) return cached;

  const port = Number(process.env.SMTP_PORT ?? 587);
  cached = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    // 465 is implicit TLS; 587 starts plaintext and upgrades via STARTTLS.
    // Getting this backwards produces a connection that hangs rather than a
    // clear error, which is a miserable thing to debug at 2am.
    secure: port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    // A login code is worthless in two minutes. Fail fast and tell the user to
    // retry rather than holding their request open.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });
  return cached;
}

/** Verify SMTP at boot, so a broken config surfaces before someone is locked out. */
export async function verifyMailer(log?: { info: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void }): Promise<boolean> {
  if (CONSOLE_MODE) {
    log?.error({}, 'MAIL_TRANSPORT=console — sign-in codes will be LOGGED, not emailed');
    return true;
  }
  const t = transport();
  if (!t) return false;
  try {
    await t.verify();
    log?.info({ host: process.env.SMTP_HOST }, 'smtp ready');
    return true;
  } catch (err) {
    // Not fatal: the rest of the ERP works without mail. But it is logged loudly,
    // because with MFA on, no mail means no platform admin can sign in.
    log?.error({ err: String(err) }, 'smtp verification FAILED — login codes will not be delivered');
    return false;
  }
}

export async function sendLoginCode(to: string, name: string, code: string, minutes: number): Promise<void> {
  const t = transport();
  if (!t) throw new Error('Email is not configured on this server');

  const from = process.env.SMTP_FROM || process.env.SMTP_USER!;
  const first = (name || '').split(' ')[0] || 'there';

  if (CONSOLE_MODE) {
    console.warn(`[mail] MAIL_TRANSPORT=console — NOT SENDING. Sign-in code for ${to}: ${code}`);
    console.warn('[mail] This prints live codes to the log. Never run a real deployment this way.');
  }

  await t.sendMail({
    from,
    to,
    subject: `${code} is your ${BRAND_NAME} sign-in code`,
    // The code is in the subject as well as the body: on a phone the
    // notification preview is often all someone needs to see.
    text:
      `Hi ${first},\n\n` +
      `Your sign-in code is ${code}. It expires in ${minutes} minutes and can be used once.\n\n` +
      `If you did not try to sign in, someone has your password. Change it now.\n`,
    html:
      `<p>Hi ${escapeHtml(first)},</p>` +
      `<p style="font-size:15px">Your sign-in code is</p>` +
      `<p style="font-family:ui-monospace,SFMono-Regular,Consolas,monospace;` +
      `font-size:30px;font-weight:700;letter-spacing:.22em;margin:14px 0">${code}</p>` +
      `<p style="color:#555;font-size:13px">Expires in ${minutes} minutes. It can be used once.</p>` +
      `<p style="color:#a3271f;font-size:13px">If you did not try to sign in, someone has your ` +
      `password — change it now.</p>`,
  });
}

/** The name is user-controlled and lands in an HTML body. */
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}
