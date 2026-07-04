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
//   NOTIFY_EMAIL              — where notification emails get sent. Once beyondxco.com
//     is verified in Resend (Domains → Add Domain → add the DNS records they give you),
//     you can list multiple recipients here separated by commas, e.g.
//     "person1@beyondxco.com,person2@gmail.com" — no code change needed.
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

// Supports one or more recipients, comma-separated, e.g.
// "a@beyondxco.com, b@gmail.com". Extra whitespace is trimmed automatically.
const NOTIFY_EMAILS = (process.env.NOTIFY_EMAIL || '')
  .split(',')
  .map(e => e.trim())
  .filter(Boolean);
if (NOTIFY_EMAILS.length === 0) {
  console.error('NOTIFY_EMAIL environment variable is not set. Set it in Vercel → Settings → Environment Variables.');
}

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
function isValidPhone(phone) {
  return typeof phone === 'string' && /^0[2357]\d{8}$/.test(phone);
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
    // `category` distinguishes what kind of submission this is, e.g.
    // 'get_in_touch' (public contact form), 'worker_support',
    // 'worker_report', 'employer_support', 'employer_report'.
    // `phone` is accepted as an alternative to `email` since workers on
    // this platform authenticate by phone number and don't have an email
    // on file — at least one of the two is required.
    const { name, email, phone, message, category } = req.body || {};
    const safeCategory = (typeof category === 'string' && category.trim()) ? category.trim() : 'get_in_touch';

    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'A name is required.' });
    }

    const hasValidEmail = isValidEmail(email);
    const hasValidPhone = isValidPhone(phone);
    if (!hasValidEmail && !hasValidPhone) {
      return res.status(400).json({ error: 'A valid email address or phone number is required.' });
    }

    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'Please include a message.' });
    }

    // 1. Save the lead to Supabase so nothing is lost even if the email fails.
    const { error: dbError } = await supabase
      .from('frontend_contact_leads')
      .insert([{
        name,
        email: hasValidEmail ? email : null,
        phone: hasValidPhone ? phone : null,
        message,
        source: safeCategory
      }]);

    if (dbError) {
      console.error('Supabase insert error:', dbError);
      // Continue to try sending the email even if the DB write fails —
      // we'd rather you get notified than lose the lead entirely.
    }

    // 2. Send the notification email, if Resend is configured.
    if (resend && NOTIFY_EMAILS.length > 0) {
      const safeName = name.replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const safeMessage = message.replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const categoryLabels = {
        get_in_touch: 'New "Get in Touch" request',
        worker_onboarding: '👋 New Worker Onboarding',
        employer_onboarding: '👋 New Employer Onboarding',
        worker_support: 'Worker support request',
        worker_report: '⚠️ Worker report — please review',
        employer_support: 'Employer support request',
        employer_report: '⚠️ Employer report — please review'
      };
      // NOTE: using Resend's shared test sender (onboarding@resend.dev), which
      // can only deliver to the single email address your Resend account is
      // registered under — sending to any other address (or multiple) will
      // fail until you verify your own domain in Resend. Once verified,
      // this can go back to an array with your real intended recipients.
      const subjectLine = `${categoryLabels[safeCategory] || 'New contact request'} — BeyondX`;
      const { error: emailError } = await resend.emails.send({
        from: 'BeyondX <notifications@beyondxco.com>', // requires beyondxco.com verified in Resend — see setup note above
        to: NOTIFY_EMAILS,
        reply_to: hasValidEmail ? email : undefined,
        subject: subjectLine,
        html: `
          <div style="font-family: sans-serif; max-width: 480px;">
            <h2 style="color:#1A4731;">${subjectLine}</h2>
            <p style="font-size:1.1rem;"><strong>Name:</strong> ${safeName}</p>
            ${hasValidEmail ? `<p style="font-size:1.1rem;"><strong>Email:</strong> ${email}</p>` : ''}
            ${hasValidPhone ? `<p style="font-size:1.1rem;"><strong>Phone:</strong> ${phone}</p>` : ''}
            <p style="font-size:1rem; white-space:pre-wrap;"><strong>Message:</strong><br>${safeMessage}</p>
            <p style="color:#6B7280; font-size:0.85rem;">${hasValidEmail ? 'Reply directly to this email to respond to them.' : 'No email on file — use the phone number above to follow up.'}</p>
          </div>
        `,
      });

      if (emailError) {
        console.error('Resend send error:', emailError);
        return res.status(502).json({ error: 'Saved your request, but the notification email failed to send.' });
      }
    } else {
      console.error('Skipped email notification: resend client not configured or no valid NOTIFY_EMAIL recipients.');
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Unexpected error in /api/contact:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
};
