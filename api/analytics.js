// api/analytics.js
//
// Serverless proxy for the Vercel Web Analytics API.
// Your VERCEL_TOKEN never reaches the browser — this runs on Vercel's servers.
//
// Required environment variables (set in Vercel → Project → Settings → Environment Variables):
//   VERCEL_TOKEN        Account token, created at vercel.com/account/tokens
//   VERCEL_PROJECT_ID   Project → Settings → General → Project ID
//   VERCEL_TEAM_ID      Only if the project sits under a team (optional for personal accounts)
//   ADMIN_API_SECRET    Any long random string; the admin page must send it back
//
// Usage from the admin page:
//   fetch('/api/analytics?days=14', { headers: { 'x-admin-secret': ADMIN_SECRET } })

const API = 'https://api.vercel.com/v1/query/web-analytics'

function daysAgo(n) {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - n)
  return d.toISOString().slice(0, 10)
}

async function query(path, params) {
  const url = new URL(`${API}/${path}`)
  url.searchParams.set('projectId', process.env.VERCEL_PROJECT_ID)
  if (process.env.VERCEL_TEAM_ID) url.searchParams.set('teamId', process.env.VERCEL_TEAM_ID)
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v)
  }

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.VERCEL_TOKEN}` },
  })

  if (!res.ok) {
    const detail = await res.text()
    throw new Error(`Vercel API ${res.status} on ${path}: ${detail.slice(0, 300)}`)
  }
  return res.json()
}

// Any query that fails returns null rather than breaking the whole dashboard.
async function safe(label, fn) {
  try {
    return await fn()
  } catch (err) {
    console.error(`[analytics] ${label} failed:`, err.message)
    return null
  }
}

export default async function handler(req, res) {
  // --- gate: keep this endpoint from being world-readable ---
  const secret = process.env.ADMIN_API_SECRET
  if (secret && req.headers['x-admin-secret'] !== secret) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const missing = ['VERCEL_TOKEN', 'VERCEL_PROJECT_ID'].filter((k) => !process.env[k])
  if (missing.length) {
    return res.status(500).json({ error: `Missing environment variables: ${missing.join(', ')}` })
  }

  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 14, 1), 90)
  const since = daysAgo(days)
  const until = daysAgo(0)
  const range = { since, until }

  // Previous period of the same length, for "vs last period" comparisons
  const prevRange = { since: daysAgo(days * 2), until: since }

  const [totals, prevTotals, overTime, topPages, referrers, devices, countries, events] =
    await Promise.all([
      safe('totals', () => query('visits/count', range)),
      safe('prevTotals', () => query('visits/count', prevRange)),
      safe('overTime', () => query('visits/aggregate', { ...range, by: 'date' })),
      safe('topPages', () => query('visits/aggregate', { ...range, by: 'requestPath' })),
      safe('referrers', () => query('visits/aggregate', { ...range, by: 'referrer' })),
      safe('devices', () => query('visits/aggregate', { ...range, by: 'device' })),
      safe('countries', () => query('visits/aggregate', { ...range, by: 'country' })),
      safe('events', () => query('events/aggregate', { ...range, by: 'eventName' })),
    ])

  const pct = (now, before) => {
    if (!before || !now) return null
    return Math.round(((now - before) / before) * 100)
  }

  const visitors = totals?.data?.visitors ?? totals?.visitors ?? null
  const pageViews = totals?.data?.count ?? totals?.count ?? null
  const prevVisitors = prevTotals?.data?.visitors ?? prevTotals?.visitors ?? null
  const prevPageViews = prevTotals?.data?.count ?? prevTotals?.count ?? null

  const eventRows = events?.data ?? []
  const totalClicks = eventRows.reduce((sum, r) => sum + (r.count || 0), 0)

  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300')
  return res.status(200).json({
    range: { since, until, days },
    totals: {
      visitors,
      pageViews,
      clicks: totalClicks,
      visitorsChangePct: pct(visitors, prevVisitors),
      pageViewsChangePct: pct(pageViews, prevPageViews),
    },
    overTime: overTime?.data ?? [],
    topPages: topPages?.data ?? [],
    referrers: referrers?.data ?? [],
    devices: devices?.data ?? [],
    countries: countries?.data ?? [],
    events: eventRows,
    generatedAt: new Date().toISOString(),
  })
}
