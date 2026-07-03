// /api/upload.js
// Vercel Serverless Function — uploads an image (worker profile photo or
// employer company logo) to Supabase Storage and returns its public URL.
//
// Uses the SAME environment variables as /api/contact.js:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//
// ONE-TIME SETUP REQUIRED before this works:
//   1. In your Supabase project dashboard, go to Storage.
//   2. Create a new bucket named exactly: profile-photos
//   3. Set it to PUBLIC (so uploaded photos/logos can be displayed on the site
//      without extra auth). Since uploads only happen through this server-side
//      function (using the service role key), making the bucket public for
//      reads is safe — the public can view images, but only this backend can
//      write new ones.

const { createClient } = require('@supabase/supabase-js');

let supabase = null;
try {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set.');
  }
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
} catch (err) {
  console.error('Supabase client failed to initialize:', err);
}

const BUCKET = 'profile-photos';
const ALLOWED_FOLDERS = ['worker-photos', 'employer-logos'];
const MAX_BASE64_LENGTH = 7_000_000; // roughly ~5MB image, base64 is ~33% larger than raw bytes

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(500).json({ error: 'Server is misconfigured (storage connection). Please try again later.' });
  }

  try {
    const { imageBase64, fileName, folder } = req.body || {};

    if (!imageBase64 || typeof imageBase64 !== 'string') {
      return res.status(400).json({ error: 'No image provided.' });
    }
    if (imageBase64.length > MAX_BASE64_LENGTH) {
      return res.status(400).json({ error: 'Image is too large. Please use a photo under 5MB.' });
    }
    if (!ALLOWED_FOLDERS.includes(folder)) {
      return res.status(400).json({ error: 'Invalid upload type.' });
    }

    const match = imageBase64.match(/^data:(image\/(png|jpe?g|webp));base64,(.+)$/i);
    if (!match) {
      return res.status(400).json({ error: 'Only PNG, JPG, or WEBP images are supported.' });
    }
    const mimeType = match[1].toLowerCase();
    const ext = mimeType.split('/')[1].replace('jpeg', 'jpg');
    const buffer = Buffer.from(match[3], 'base64');

    const safeName = (typeof fileName === 'string' ? fileName : 'upload').replace(/[^a-zA-Z0-9-_]/g, '').slice(0, 40) || 'upload';
    const path = `${folder}/${safeName}-${Date.now()}.${ext}`;

    const { error: uploadError } = await supabase.storage
      .from(BUCKET)
      .upload(path, buffer, { contentType: mimeType, upsert: true });

    if (uploadError) {
      console.error('Supabase storage upload error:', uploadError);
      return res.status(500).json({ error: 'Upload failed. Please try again.' });
    }

    const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
    return res.status(200).json({ url: data.publicUrl });
  } catch (err) {
    console.error('Unexpected error in /api/upload:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
};
