// /api/contact.js
// Vercel Serverless Function — handles the "Get in Touch" modal on beyondx-frontend.
// Same architecture as the beyondx-landingpage site: saves the lead to Supabase,
// then emails a notification via Resend.
//
// Required environment variables (set in Vercel Project Settings → Environment Variables
// for THIS project — beyondx-frontend — not just the landing page):
//   SUPABASE_URL              — your Supabase project URL
//   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key (server-side only, never expose to the browser)
//   RESEND_API_KEY            — your Resend API key
//   NOTIFY_EMAIL              — where notification emails get sent.
//     IMPORTANT: while using Resend's test sender (onboarding@resend.dev) with
//     no verified domain, this MUST be the exact email address your Resend
//     account was signed up with — Resend will silently fail to deliver to
//     any other address in sandbox mode. Once you verify a real domain, you
//     can change this to any address you want.
//
// You can point this at the SAME Supabase project and Resend account as the
// landing page (reuse the same env var values), or set up separate ones —
// either works, this file doesn't care which.

const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');

let supabase = null;
try {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set.');
  }
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
} catch (err) {
  console.error('Supabase client failed to initialize:', err);
}

let resend = null;
try {
  if (process.env.RESEND_API_KEY) {
    resend = new Resend(process.env.RESEND_API_KEY);
  } else {
    console.error('RESEND_API_KEY is not set — email notifications will be skipped.');
  }
} catch (err) {
  console.error('Resend client failed to initialize (non-fatal):', err);
}

const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL;
if (!NOTIFY_EMAIL) {
  console.error('NOTIFY_EMAIL environment variable is not set. Set it in Vercel → Settings → Environment Variables.');
}

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(500).json({ error: 'Server is misconfigured (database connection). Please try again later.' });
  }

  try {
    const { name, email, message } = req.body || {};

    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'A name is required.' });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'A valid email address is required.' });
    }

    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'Please include a message.' });
    }

    // 1. Save the lead to Supabase so nothing is lost even if the email fails.
    const { error: dbError } = await supabase
      .from('frontend_contact_leads')
      .insert([{ name, email, message, source: 'frontend_get_in_touch' }]);

    if (dbError) {
      console.error('Supabase insert error:', dbError);
      // Continue to try sending the email even if the DB write fails —
      // we'd rather you get notified than lose the lead entirely.
    }

    // 2. Send the notification email, if Resend is configured.
    if (resend && NOTIFY_EMAIL) {
      const safeName = name.replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const safeMessage = message.replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const { error: emailError } = await resend.emails.send({
        from: 'BeyondX Website <onboarding@resend.dev>', // test sender — swap for your own verified domain later
        to: [NOTIFY_EMAIL],
        reply_to: email,
        subject: 'New "Get in Touch" request — BeyondX',
        html: `
          <div style="font-family: sans-serif; max-width: 480px;">
            <h2 style="color:#1A4731;">New contact request</h2>
            <p>Someone just submitted the "Get in Touch" form on beyondx-frontend.</p>
            <p style="font-size:1.1rem;"><strong>Name:</strong> ${safeName}</p>
            <p style="font-size:1.1rem;"><strong>Email:</strong> ${email}</p>
            <p style="font-size:1rem; white-space:pre-wrap;"><strong>Message:</strong><br>${safeMessage}</p>
            <p style="color:#6B7280; font-size:0.85rem;">Reply directly to this email to respond to them.</p>
          </div>
        `,
      });

      if (emailError) {
        console.error('Resend send error:', emailError);
        return res.status(502).json({ error: 'Saved your request, but the notification email failed to send.' });
      }
    } else {
      console.error('Skipped email notification: resend client or NOTIFY_EMAIL missing.');
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Unexpected error in /api/contact:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
};
