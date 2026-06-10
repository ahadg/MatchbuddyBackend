import { randomUUID } from 'node:crypto';

import { Router } from 'express';
import { z } from 'zod';

import { config } from '../config.js';
import { supabaseAdmin } from '../supabase.js';

const router = Router();

const sendOtpBodySchema = z.object({
  email: z.string().trim().email().max(320),
});

function getFromAddress() {
  const senderName = config.resendFromName.trim();
  const senderEmail = config.resendFromEmail.trim();

  return senderName ? `${senderName} <${senderEmail}>` : senderEmail;
}

function buildOtpEmail(email, otp) {
  const subject = 'Your MatchBuddy sign-in code';
  const safeEmail = email.replace(/[<>&"]/g, '');

  return {
    subject,
    text: [
      'MatchBuddy',
      '',
      `Your sign-in code for ${safeEmail} is: ${otp}`,
      '',
      'Enter this code in the app to continue. If you did not request it, you can ignore this email.',
    ].join('\n'),
    html: `
      <div style="margin:0;padding:32px 16px;background:#070816;font-family:Arial,Helvetica,sans-serif;color:#f5f7ff;">
        <div style="max-width:560px;margin:0 auto;background:#11152b;border:1px solid #2d3558;border-radius:28px;overflow:hidden;">
          <div style="padding:32px 32px 24px;background:#161b38;">
            <p style="margin:0 0 12px;color:#9ea7cb;font-size:12px;letter-spacing:0.28em;font-weight:700;">MATCHBUDDY</p>
            <h1 style="margin:0 0 12px;font-size:32px;line-height:1.1;color:#ffffff;">Use this sign-in code</h1>
            <p style="margin:0;color:#b6bdd8;font-size:16px;line-height:1.6;">Enter this six-digit code in MatchBuddy to sign in as ${safeEmail}.</p>
          </div>
          <div style="padding:28px 32px 32px;">
            <div style="margin-bottom:24px;border-radius:22px;border:1px solid #34406a;background:#171d3b;padding:24px;text-align:center;">
              <p style="margin:0 0 12px;color:#8d97bf;font-size:12px;letter-spacing:0.22em;font-weight:700;text-transform:uppercase;">Sign-in code</p>
              <p style="margin:0;color:#97ff62;font-size:40px;line-height:1;font-weight:700;letter-spacing:0.28em;">${otp}</p>
            </div>
            <p style="margin:0;color:#c9cfe6;font-size:15px;line-height:1.6;">If you did not request this code, you can safely ignore this email.</p>
          </div>
        </div>
      </div>
    `,
  };
}

async function sendResendEmail({ to, subject, text, html }) {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.resendApiKey}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': randomUUID(),
    },
    body: JSON.stringify({
      from: getFromAddress(),
      to: [to],
      subject,
      text,
      html,
    }),
  });

  const rawBody = await response.text();
  let payload = null;

  try {
    payload = rawBody ? JSON.parse(rawBody) : null;
  } catch {
    payload = rawBody;
  }

  if (!response.ok) {
    const details = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
    throw new Error(`Resend email request failed with ${response.status}.\n${details}`);
  }

  return payload;
}

router.post('/send-otp', async (req, res, next) => {
  const parsed = sendOtpBodySchema.safeParse(req.body ?? {});

  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid auth request.', details: parsed.error.flatten() });
  }

  const email = parsed.data.email.trim().toLowerCase();

  try {
    const { data, error } = await supabaseAdmin.auth.admin.generateLink({
      type: 'magiclink',
      email,
    });

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    const emailOtp = data?.properties?.email_otp;

    if (!emailOtp) {
      throw new Error('Supabase did not return an OTP for this email request.');
    }

    // if (!/^\d{6}$/.test(emailOtp)) {
    //   throw new Error('Supabase returned an OTP that was not 6 digits long.');
    // }

    const message = buildOtpEmail(email, emailOtp);
    await sendResendEmail({
      to: email,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });

    return res.status(202).json({
      data: {
        email,
        sent: true,
      },
    });
  } catch (error) {
    return next(error);
  }
});

export default router;
