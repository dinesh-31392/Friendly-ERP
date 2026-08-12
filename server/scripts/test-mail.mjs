/**
 * Prove the mail configuration works before anyone depends on it.
 *
 *   node scripts/test-mail.mjs you@example.com
 *
 * Worth running because SMTP failures at sign-in time are the worst kind: the
 * password was correct, a code was "sent", and the admin is simply locked out
 * with a 503. Better to find out here.
 */
import 'dotenv/config';
import nodemailer from 'nodemailer';

const to = process.argv[2];
if (!to) {
  console.error('Usage: node scripts/test-mail.mjs <recipient@example.com>');
  process.exit(1);
}

const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM, MAIL_TRANSPORT } = process.env;

if (MAIL_TRANSPORT === 'console') {
  console.log('MAIL_TRANSPORT=console — codes are printed to the log, not emailed.');
  console.log('Unset it to test real delivery.');
  process.exit(0);
}

const missing = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS'].filter(k => !process.env[k]);
if (missing.length) {
  console.error(`Not configured. Missing: ${missing.join(', ')}`);
  process.exit(1);
}

const port = Number(SMTP_PORT ?? 587);
console.log(`host   ${SMTP_HOST}:${port}  (${port === 465 ? 'implicit TLS' : 'STARTTLS'})`);
console.log(`user   ${SMTP_USER}`);
console.log(`from   ${SMTP_FROM || SMTP_USER}`);
console.log(`pass   ${'•'.repeat(Math.min(String(SMTP_PASS).length, 20))} (${String(SMTP_PASS).length} chars)`);

// Gmail app passwords are 16 characters. Google displays them in four groups of
// four, and pasting the display form is the single most common mistake — the
// spaces are not part of the password.
if (/gmail|googlemail/i.test(String(SMTP_HOST)) && /\s/.test(String(SMTP_PASS))) {
  console.warn('\n!! SMTP_PASS contains spaces. Google shows app passwords as "abcd efgh ijkl mnop"');
  console.warn('   for readability — remove the spaces: abcdefghijklmnop');
}

const t = nodemailer.createTransport({
  host: SMTP_HOST, port, secure: port === 465,
  auth: { user: SMTP_USER, pass: SMTP_PASS },
  connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 15_000,
});

try {
  process.stdout.write('\nverifying credentials … ');
  await t.verify();
  console.log('ok');
} catch (err) {
  console.log('FAILED');
  explain(err);
  process.exit(1);
}

try {
  process.stdout.write(`sending to ${to} … `);
  const info = await t.sendMail({
    from: SMTP_FROM || SMTP_USER,
    to,
    subject: '123456 is your Friendly ERP sign-in code',
    text: 'This is a test of the Friendly ERP mail configuration. If you received it, sign-in codes will arrive.',
  });
  console.log('ok');
  console.log(`\nmessage id  ${info.messageId}`);
  if (info.rejected?.length) console.log(`rejected    ${info.rejected.join(', ')}`);
  console.log('\nCheck the inbox AND the spam folder. A code that lands in spam is');
  console.log('a locked-out admin, so if it is filtered, fix that before go-live.');
} catch (err) {
  console.log('FAILED');
  explain(err);
  process.exit(1);
}

/** SMTP errors are terse and the cause is usually one of a few known things. */
function explain(err) {
  const msg = String(err?.message ?? err);
  console.error(`\n${msg}\n`);

  if (/invalid login|username and password not accepted|535/i.test(msg)) {
    console.error('Authentication was rejected. Usually one of:');
    console.error('  • Using the Google account password instead of an App Password.');
    console.error('    Gmail has not accepted account passwords for SMTP since 2022.');
    console.error('  • 2-Step Verification is off — App Passwords cannot exist without it.');
    console.error('    Turn it on at myaccount.google.com/security, then create the');
    console.error('    password at myaccount.google.com/apppasswords');
    console.error('  • The app password was pasted with its display spaces.');
    console.error('  • Microsoft 365: SMTP AUTH is disabled for that mailbox. It is off by');
    console.error('    default on many tenants and only an admin can enable it.');
  } else if (/ETIMEDOUT|ECONNREFUSED|ENOTFOUND/i.test(msg)) {
    console.error('Could not reach the server. Check the host and port, and whether the');
    console.error('VPS provider blocks outbound 587/465 — some block SMTP by default to');
    console.error('limit spam, and will open it on request.');
  } else if (/self.signed|certificate/i.test(msg)) {
    console.error('TLS problem. Port 465 is implicit TLS; 587 is STARTTLS. Swapping them');
    console.error('produces exactly this.');
  } else if (/5\.7\.\d+|not allowed to send as/i.test(msg)) {
    console.error('The server refused the From address. It must be one the account is');
    console.error('allowed to send as — for Gmail, the account address itself or a');
    console.error('verified alias.');
  }
}
