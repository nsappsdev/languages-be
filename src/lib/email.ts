import { Resend } from 'resend';
import { config } from '../config';

let resendClient: Resend | null = null;

function getClient(): Resend | null {
  if (!config.smtp.pass) {
    return null;
  }
  if (!resendClient) {
    resendClient = new Resend(config.smtp.pass);
  }
  return resendClient;
}

export async function sendVerificationEmail(to: string, name: string, token: string): Promise<void> {
  const verifyUrl = `${config.appBaseUrl}/api/auth/verify-email?token=${token}`;

  console.log(`[email] Verification URL for ${to}: ${verifyUrl}`);

  const client = getClient();
  if (!client) {
    console.warn('[email] SMTP_PASS not set — email not sent');
    return;
  }

  const { error } = await client.emails.send({
    from: config.smtp.from,
    to,
    subject: 'Verify your lezoo.app account',
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
        <h2 style="color:#0e7490;margin-bottom:8px">Verify your email</h2>
        <p style="color:#374151">Hi ${name},</p>
        <p style="color:#374151">Click the button below to verify your email address and activate your account.</p>
        <a href="${verifyUrl}"
           style="display:inline-block;margin:24px 0;padding:12px 24px;background:#0e7490;color:#fff;text-decoration:none;border-radius:8px;font-weight:600">
          Verify email
        </a>
        <p style="color:#6b7280;font-size:13px">This link expires in 24 hours. If you did not create an account, ignore this email.</p>
      </div>
    `,
  });

  if (error) {
    throw new Error(`Resend error: ${error.message}`);
  }
}
