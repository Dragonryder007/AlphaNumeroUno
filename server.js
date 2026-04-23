/**
 * Audit generation: Google Places + Claude.
 * Env: GOOGLE_PLACES_API_KEY, ANTHROPIC_API_KEY
 * Optional: ANTHROPIC_MODEL (default claude-sonnet-4-5-20250929), PORT (default 3000)
 * Optional: SMTP_* + RAZORPAY_* for POST /api/email-audit-pdf (paid PDF to customer).
 */
require('dotenv').config();

const crypto = require('crypto');
const path = require('path');
const express = require('express');
const nodemailer = require('nodemailer');
const Anthropic = require('@anthropic-ai/sdk');
const Razorpay = require('razorpay');

// Trim whitespace/quotes on load — a single stray space in .env causes
// "Authentication failed" from Razorpay with no obvious hint.
const _rzpKeyId = String(process.env.RAZORPAY_KEY_ID || '').trim().replace(/^['"]|['"]$/g, '');
const _rzpKeySecret = String(process.env.RAZORPAY_KEY_SECRET || '').trim().replace(/^['"]|['"]$/g, '');
process.env.RAZORPAY_KEY_ID = _rzpKeyId;
process.env.RAZORPAY_KEY_SECRET = _rzpKeySecret;

const razorpay = new Razorpay({
  key_id: _rzpKeyId,
  key_secret: _rzpKeySecret,
});

// Boot-time key sanity log (never prints the secret itself).
if (_rzpKeyId && _rzpKeySecret) {
  const mode = _rzpKeyId.startsWith('rzp_live_') ? 'LIVE' : (_rzpKeyId.startsWith('rzp_test_') ? 'TEST' : 'UNKNOWN');
  console.log(`[razorpay] key_id=${_rzpKeyId} mode=${mode} secret_len=${_rzpKeySecret.length}`);
} else {
  console.warn('[razorpay] WARNING: RAZORPAY_KEY_ID or RAZORPAY_KEY_SECRET is missing in .env');
}

// Normalize Google Places API key (trim whitespace and strip surrounding quotes)
const _googlePlacesKey = String(process.env.GOOGLE_PLACES_API_KEY || '').trim().replace(/^['"]|['"]$/g, '');
process.env.GOOGLE_PLACES_API_KEY = _googlePlacesKey;
if (_googlePlacesKey) {
  console.log(`[google places] GOOGLE_PLACES_API_KEY present length=${_googlePlacesKey.length}`);
} else {
  console.warn('[google places] WARNING: GOOGLE_PLACES_API_KEY is missing in .env');
}

// In-memory session store for audit form data (before payment)
// Key: email or phone, Value: form data
const auditFormSessions = new Map();

// Cleanup old sessions every 30 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of auditFormSessions.entries()) {
    if (now - value.timestamp > 30 * 60 * 1000) {
      auditFormSessions.delete(key);
    }
  }
}, 30 * 60 * 1000);


const PLACES_BASE = 'https://maps.googleapis.com/maps/api/place';

/** Maps form businessType → Google Places `type` for nearbysearch */
const BUSINESS_TYPE_TO_GOOGLE_TYPE = {
  dental: 'dentist',
  gym: 'gym',
  cafe: 'cafe',
  restaurant: 'restaurant',
  salon: 'beauty_salon',
  hotel: 'lodging',
  school: 'school',
  healthcare: 'doctor',
  other: 'establishment',
};

const CLAUDE_MODEL =
  process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5-20250929';
const ENABLE_FREE_FALLBACK =
  String(process.env.ENABLE_FREE_FALLBACK ?? 'true').trim().toLowerCase() !==
  'false';

const AVG_CUSTOMER_VALUE = {
  dental: 2500,
  gym: 1500,
  cafe: 800,
  restaurant: 1200,
  salon: 1000,
  hotel: 4000,
  school: 8000,
  healthcare: 2000,
  other: 1500,
};

const SYSTEM_PROMPT = `You are a senior digital marketing auditor for Indian SMBs in Bangalore.
You will receive real business data and must return ONLY a valid JSON object, no extra text, no markdown, no explanation.

Calculate scores based on these rules:
- Google score (0-10): 10 if 200+ reviews and 4.5+ rating, scale down proportionally
- Instagram score (0-10): 10 if 10000+ followers, scale down proportionally
- WhatsApp score (0-10): 10 if has WhatsApp Business, 2 if not
- Website score (0-10): 10 if has website, 0 if not
- Ads score (0-10): 10 if running ads, 0 if not
- Overall score: weighted average (Google 35%, Instagram 25%, WhatsApp 15%, Website 15%, Ads 10%)

Revenue loss calculation:
- Use average customer values for Bangalore: dental ₹2500, gym ₹1500, cafe ₹800, restaurant ₹1200, salon ₹1000, hotel ₹4000, school ₹8000, healthcare ₹2000, other ₹1500
- Monthly loss low = reviewGap × 0.05 × avgCustomerValue
- Monthly loss high = reviewGap × 0.15 × avgCustomerValue
- If no review gap, base loss on missing platforms × ₹10000

Return exactly this JSON structure:
{
  "score": number,
  "googleScore": number,
  "instagramScore": number,
  "whatsappScore": number,
  "websiteScore": number,
  "adsScore": number,
  "googleReviews": number,
  "googleRating": number,
  "competitorAvgReviews": number,
  "reviewGap": number,
  "listedOnGoogle": boolean,
  "monthlyLossLow": number,
  "monthlyLossHigh": number,
  "annualLoss": number,
  "competitors": [{"name": string, "reviews": number, "rating": number}],
  "topGaps": [string, string, string],
  "freeActions": [string, string, string],
  "roadmap": {
    "month1": string,
    "month2": string,
    "month3": string
  },
  "recommendedPackage": string,
  "summary": string
}`;

function normalizeGoogleType(businessType) {
  const s = String(businessType || '').toLowerCase();
  if (s.includes('dental')) return 'dentist';
  if (s.includes('gym') || s.includes('fitness')) return 'gym';
  if (s.includes('café') || s.includes('cafe') || s.includes('coffee')) return 'cafe';
  if (s.includes('restaurant')) return 'restaurant';
  if (s.includes('school') || s.includes('coaching')) return 'school';
  if (s.includes('salon') || s.includes('beauty')) return 'beauty_salon';
  if (s.includes('hotel') || s.includes('homestay')) return 'lodging';
  if (s.includes('healthcare') || s.includes('clinic')) return 'doctor';
  return 'establishment';
}

async function fetchSerperData(query) {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) return null;
  try {
    const res = await fetch("https://google.serper.dev/places", {
      method: 'POST',
      headers: {
        'X-API-KEY': apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ q: query })
    });
    const data = await res.json();
    if (!data.places) return null;

    const competitors = data.places.map(r => ({
      name: r.title,
      reviews: Number(r.ratingCount) || 0,
      rating: Number(r.rating) || 0,
      address: r.address || ''
    }));

    return {
      competitors: competitors.slice(0, 5),
      competitorAvgReviews: Math.round(competitors.reduce((a, b) => a + b.reviews, 0) / Math.max(1, competitors.length)) || 120
    };
  } catch (err) {
    console.error('Serper.dev research failed:', err.message);
    return null;
  }
}

async function placesJson(url) {
  const res = await fetch(url);
  const data = await res.json();
  return data;
}

/**
 * @returns {Promise<{
 *   googleReviews: number|null,
 *   googleRating: number|null,
 *   listedOnGoogle: boolean,
 *   placeId: string|null,
 *   name: string|null,
 *   lat: number|null,
 *   lng: number|null,
 *   competitors: {name: string, reviews: number, rating: number|null}[],
 *   competitorAvgReviews: number|null
 * }>}
 */
async function fetchGoogleData(businessName, city, businessType) {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  const empty = {
    googleReviews: null,
    googleRating: null,
    listedOnGoogle: false,
    placeId: null,
    name: null,
    lat: null,
    lng: null,
    competitors: [],
    competitorAvgReviews: null,
  };

  if (!key) {
    console.warn('fetchGoogleData: GOOGLE_PLACES_API_KEY is not set');
    return empty;
  }

  const query = [businessName, city].filter(Boolean).join(' ').trim();
  if (!query) {
    return empty;
  }

  try {
    const fields = [
      'place_id',
      'name',
      'rating',
      'user_ratings_total',
      'geometry',
      'business_status',
    ].join(',');

    const findUrl =
      `${PLACES_BASE}/findplacefromtext/json?` +
      new URLSearchParams({
        input: query,
        inputtype: 'textquery',
        fields,
        key,
      });

    const findData = await placesJson(findUrl);
    if (findData && findData.status && findData.status !== 'OK') {
      console.error(`[google places] findplace status=${findData.status} error_message=${findData.error_message || ''}`);
    }
    if (findData.status === 'REQUEST_DENIED' && findData.error_message?.includes('Billing')) {
      console.error('CRITICAL: Google Places API Billing is NOT enabled. Competitor and Google data will be missing.');
      console.error('Please visit: https://console.cloud.google.com/billing to enable billing.');
      return empty;
    }
    let candidate = (findData.status === 'OK' && findData.candidates?.length) ? findData.candidates[0] : null;

    let placeId = candidate?.place_id || null;
    let googleRating = candidate ? (typeof candidate.rating === 'number' ? candidate.rating : null) : null;
    let googleReviews = candidate ? (typeof candidate.user_ratings_total === 'number' ? candidate.user_ratings_total : null) : null;
    let lat = candidate?.geometry?.location?.lat ?? null;
    let lng = candidate?.geometry?.location?.lng ?? null;
    let placeName = candidate?.name || null;

    if (placeId && (googleRating == null || googleReviews == null)) {
      const detailFields = 'name,rating,user_ratings_total,geometry';
      const detailUrl =
        `${PLACES_BASE}/details/json?` +
        new URLSearchParams({
          place_id: placeId,
          fields: detailFields,
          key,
        });
      const detailData = await placesJson(detailUrl);
      if (detailData && detailData.status && detailData.status !== 'OK') {
        console.error(`[google places] details status=${detailData.status} error_message=${detailData.error_message || ''}`);
      }
      if (detailData.status === 'OK' && detailData.result) {
        const r = detailData.result;
        placeName = r.name || placeName;
        if (typeof r.rating === 'number') googleRating = r.rating;
        if (typeof r.user_ratings_total === 'number')
          googleReviews = r.user_ratings_total;
        if (lat == null) lat = r.geometry?.location?.lat;
        if (lng == null) lng = r.geometry?.location?.lng;
      }
    }

    const listedOnGoogle = Boolean(placeId);

    // If we can't find the business lat/lng, try to find the city center lat/lng
    if (lat == null || lng == null) {
      const cityUrl = `${PLACES_BASE}/findplacefromtext/json?` +
        new URLSearchParams({
          input: city || 'Bangalore',
          inputtype: 'textquery',
          fields: 'geometry',
          key,
        });
      const cityData = await placesJson(cityUrl);
      if (cityData.status === 'OK' && cityData.candidates?.length) {
        lat = cityData.candidates[0].geometry?.location?.lat;
        lng = cityData.candidates[0].geometry?.location?.lng;
      }
    }

    if (lat == null || lng == null) {
      return {
        googleReviews,
        googleRating,
        listedOnGoogle,
        placeId,
        name: placeName,
        lat,
        lng,
        competitors: [],
        competitorAvgReviews: null,
      };
    }

    const googleType = normalizeGoogleType(businessType);
    const nearbyUrl =
      `${PLACES_BASE}/nearbysearch/json?` +
      new URLSearchParams({
        location: `${lat},${lng}`,
        radius: '5000', // Smaller radius for "nearest" (5km)
        type: googleType,
        keyword: businessType, // Use the actual business type as a keyword for precision
        key,
      });

    const nearbyData = await placesJson(nearbyUrl);
    if (nearbyData && nearbyData.status && nearbyData.status !== 'OK') {
      console.error(`[google places] nearbysearch status=${nearbyData.status} error_message=${nearbyData.error_message || ''}`);
    }
    let results = nearbyData.results || [];

    // Remove the original place and any entries without a place_id
    results = results.filter((r) => r.place_id && r.place_id !== placeId);

    // Prefer competitors that match the requested Google `type` or contain the business keyword in their name.
    try {
      const businessKeyword = String(businessType || '').toLowerCase();
      const filtered = results.filter((r) => {
        try {
          const types = Array.isArray(r.types) ? r.types : [];
          const hasTypeMatch = types.includes(googleType);
          const nameMatch = r.name && r.name.toLowerCase().includes(businessKeyword) && businessKeyword.length > 2;
          return hasTypeMatch || nameMatch;
        } catch (e) {
          return false;
        }
      });
      if (filtered && filtered.length) {
        results = filtered;
      }
    } catch (e) {
      // ignore filtering errors and fall back to original results
    }

    results.sort((a, b) => {
      const ta = a.user_ratings_total ?? 0;
      const tb = b.user_ratings_total ?? 0;
      return tb - ta;
    });

    const top = results.slice(0, 3).map((r) => ({
      name: r.name || 'Unknown',
      reviews: typeof r.user_ratings_total === 'number' ? r.user_ratings_total : 0,
      rating: typeof r.rating === 'number' ? r.rating : null,
    }));

    let competitorAvgReviews = null;
    if (top.length) {
      const sum = top.reduce((s, c) => s + (c.reviews || 0), 0);
      competitorAvgReviews = Math.round(sum / top.length);
    }

    return {
      googleReviews,
      googleRating,
      listedOnGoogle,
      placeId,
      name: placeName,
      lat,
      lng,
      competitors: top,
      competitorAvgReviews,
    };
  } catch (err) {
    console.error('fetchGoogleData error:', err.message);
    return empty;
  }
}

function padCompetitors(competitors) {
  const out = [...competitors];
  while (out.length < 3) {
    out.push({ name: '—', reviews: 0, rating: null });
  }
  return out.slice(0, 3);
}

function buildUserMessage(formData, googleData) {
  const igFollowers = Number(formData.igFollowers) || 0;
  const hasWhatsapp = Boolean(formData.hasWhatsapp);
  const hasWebsite = Boolean(formData.hasWebsite);
  const runningAds = Boolean(formData.runningAds);

  const gReviews = googleData.googleReviews ?? 0;
  const gRating = googleData.googleRating ?? '—';
  const listed = googleData.listedOnGoogle;
  const compAvg = googleData.competitorAvgReviews ?? '—';

  const [c1, c2, c3] = padCompetitors(googleData.competitors || []);

  const fmt = (c) => {
    const r = c.rating != null ? `${c.rating}` : '—';
    return `${c.name} - ${c.reviews} reviews, ${r} stars`;
  };

  return `Business: ${formData.businessName}, ${formData.city}
Type: ${formData.businessType}
Google Reviews: ${gReviews}
Google Rating: ${gRating}
Listed on Google: ${listed}
Instagram Followers: ${igFollowers}
Has WhatsApp Business: ${hasWhatsapp}
Has Website: ${hasWebsite}
Running Ads: ${runningAds}
Competitor 1: ${fmt(c1)}
Competitor 2: ${fmt(c2)}
Competitor 3: ${fmt(c3)}
Competitor average reviews: ${compAvg}`;
}

function extractJsonFromText(text) {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fence ? fence[1].trim() : trimmed;
  return JSON.parse(raw);
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function localGenerateBasicAudit(formData, googleData) {
  const businessType = String(formData.businessType || 'other').toLowerCase();
  const avgValue = AVG_CUSTOMER_VALUE[businessType] || AVG_CUSTOMER_VALUE.other;

  const googleReviews = Number(googleData.googleReviews || 0);
  const googleRating = Number(googleData.googleRating || 0);
  const igFollowers = Number(formData.igFollowers || 0);
  const hasWhatsapp = Boolean(formData.hasWhatsapp);
  const hasWebsite = Boolean(formData.hasWebsite);
  const runningAds = Boolean(formData.runningAds);
  const competitorAvgReviews = Number(googleData.competitorAvgReviews || 0);

  const reviewGoalScore = clamp(googleReviews / 200, 0, 1);
  const ratingScore = clamp(googleRating / 4.5, 0, 1);
  const googleScore = round1(clamp((reviewGoalScore * 0.7 + ratingScore * 0.3) * 10, 0, 10));
  const instagramScore = round1(clamp((igFollowers / 10000) * 10, 0, 10));
  const whatsappScore = hasWhatsapp ? 10 : 2;
  const websiteScore = hasWebsite ? 10 : 0;
  const adsScore = runningAds ? 10 : 0;

  const score = round1(
    googleScore * 0.35 +
    instagramScore * 0.25 +
    whatsappScore * 0.15 +
    websiteScore * 0.15 +
    adsScore * 0.1
  );

  const reviewGap = Math.max(0, competitorAvgReviews - googleReviews);
  const monthlyLossLow = Math.round(reviewGap * 0.05 * avgValue);
  const monthlyLossHigh = Math.round(reviewGap * 0.15 * avgValue);
  const fallbackLossBase = (!reviewGap ? (4 - [hasWhatsapp, hasWebsite, runningAds, googleReviews > 0].filter(Boolean).length) * 10000 : 0);
  const finalLossLow = Math.max(monthlyLossLow, fallbackLossBase);
  const finalLossHigh = Math.max(monthlyLossHigh, fallbackLossBase);
  const annualLoss = Math.round(((finalLossLow + finalLossHigh) / 2) * 12);

  const competitors = padCompetitors(googleData.competitors || []);
  const topGaps = [
    googleReviews < competitorAvgReviews ? 'Google reviews are below nearby competitors' : 'Google profile needs ongoing optimization',
    igFollowers < 10000 ? 'Instagram audience is below growth benchmark' : 'Instagram content cadence can improve conversions',
    !hasWebsite ? 'No website to capture and convert traffic' : 'Website conversion funnel can be strengthened',
  ];

  const freeActions = [
    'Request 10 reviews/week from recent happy customers',
    'Post 3 short-form videos/week with local keywords',
    'Add WhatsApp CTA in all social bios and posts',
  ];

  let recommendedPackage = 'Social Business Essential';
  if (!hasWebsite && googleReviews < 30) recommendedPackage = 'Digital Launch Starter';
  if (runningAds && hasWebsite && googleReviews >= 100) recommendedPackage = 'Performance Pro';

  return {
    score,
    googleScore,
    instagramScore,
    whatsappScore,
    websiteScore,
    adsScore,
    googleReviews,
    googleRating: round1(googleRating),
    competitorAvgReviews,
    reviewGap,
    listedOnGoogle: Boolean(googleData.listedOnGoogle),
    monthlyLossLow: finalLossLow,
    monthlyLossHigh: finalLossHigh,
    annualLoss,
    competitors,
    topGaps,
    freeActions,
    roadmap: {
      month1: 'Fix core profiles and review acquisition process',
      month2: 'Scale content and local discovery channels',
      month3: 'Optimize conversion path and paid amplification',
    },
    recommendedPackage,
    summary:
      'Generated using local free fallback mode. Add ANTHROPIC_API_KEY for AI-enhanced narrative depth.',
  };
}

function localGeneratePremiumReport(D, googleData = null) {
  const missingPlatforms = [D.igNA || !D.ig, D.fbNA || !D.fb, D.gmbNA || !D.gmb, !D.website].filter(Boolean).length;
  const isNewBusiness = D.bizAge === 'New (under 1 year)';

  // Integrate Google data into calculations if available
  const gReviews = googleData?.googleReviews || 0;
  const gRating = googleData?.googleRating || 0;
  const compAvg = googleData?.competitorAvgReviews || 180;

  const baseScore = clamp(78 - (missingPlatforms * 12) - (isNewBusiness ? 8 : 0) - (gReviews < 50 ? 5 : 0), 22, 92);
  const monthlyLow = Math.max(18000, missingPlatforms * 14000 + (gReviews < compAvg ? 8000 : 0));
  const monthlyHigh = Math.max(38000, missingPlatforms * 28000 + (gReviews < compAvg ? 15000 : 0));

  const packageName =
    missingPlatforms >= 2 || isNewBusiness
      ? 'Digital Launch Starter'
      : Number(String(D.budget || '').replace(/[^\d]/g, '')) >= 25
        ? 'Performance Pro'
        : 'Social Business Essential';

  const gmbScore = D.gmbNA || !D.gmb ? 1 : clamp(Math.round((gReviews / 100) * 5 + (gRating / 5) * 5), 1, 10);

  return {
    overallScore: baseScore,
    scoreLabel: baseScore < 40 ? 'Critical' : baseScore < 55 ? 'Poor' : baseScore < 70 ? 'Average' : 'Good',
    scoreColor: baseScore < 40 ? '#FF5C5C' : baseScore < 55 ? '#FFAA33' : baseScore < 70 ? '#20c997' : '#19a97d',
    estimatedMonthlyLoss: `₹${monthlyLow.toLocaleString('en-IN')} - ₹${monthlyHigh.toLocaleString('en-IN')}`,
    keyGaps: [
      gReviews < compAvg ? `Google reviews (${gReviews}) are significantly below area average (${compAvg})` : 'Google Business listing needs further authority signals',
      D.igNA || !D.ig ? 'Instagram presence is missing or unlinked (critical trust gap)' : 'Instagram engagement structure is below industry average',
      D.context ? `Addressing specific concern: "${D.context.slice(0, 60)}..."` : 'Multi-channel enquiry capture is not yet systemized',
      'Brand authority signals are below local benchmark',
    ],
    executiveSummary: `Direct analysis of "${D.bizName}" in ${D.bizCity} reveals a digital presence score of ${baseScore}/100. Based on your goal of "${D.goal || 'growth'}", there is clear headroom for scaling ${D.bizType || 'business'} acquisition. ${gReviews < 20 ? 'The low review count is a significant bottleneck.' : 'There is an opportunity to optimize existing visibility for higher conversion.'}`,
    brandPositioning: {
      assessment: `Positioning for "${D.bizName}" exists but lacks consistency across ${D.bizCity} touchpoints.`,
      gap: `${D.ig ? 'Instagram @' + D.ig : 'Social media'} lacks deep engagement loops compared to top-tier ${D.bizType || 'competitors'}.`,
      impact: 'Reduces trust and lowers enquiry conversion in a competitive local market.',
    },
    missedOpportunities: [
      { area: 'Google Business', description: 'Local search trust signals under-optimized.', estimatedMonthlyLoss: `₹${Math.round(monthlyLow * 0.4).toLocaleString('en-IN')}`, urgency: gmbScore < 5 ? 'Critical' : 'High' },
      { area: 'Social Funnel', description: 'Content-to-enquiry funnel not systemized.', estimatedMonthlyLoss: `₹${Math.round(monthlyLow * 0.3).toLocaleString('en-IN')}`, urgency: 'High' },
      { area: 'Website/WhatsApp', description: 'Conversion path lacks clear CTA and tracking.', estimatedMonthlyLoss: `₹${Math.round(monthlyLow * 0.2).toLocaleString('en-IN')}`, urgency: 'Medium' },
    ],
    dataPoints: {
      igFollowers: D.igNA ? '0' : 'n/a',
      igPostsPerMonth: 'n/a',
      igEngagementRate: 'n/a',
      igReelsUsed: false,
      fbFollowers: D.fbNA ? '0' : 'n/a',
      fbLastPostDays: 'n/a',
      gmbReviews: gReviews || '0',
      gmbRating: gRating || 'n/a',
      gmbVerified: Boolean(googleData?.placeId),
      gmbPhotos: 'n/a',
      websiteHasWhatsApp: Boolean(D.website),
      adsRunning: false,
      whatsappFunnelSetup: false
    },
    benchmarks: {
      igFollowersAvg: '3000',
      igPostsPerMonthAvg: '12',
      igEngagementRateAvg: '2.5%',
      gmbReviewsAvg: String(compAvg),
      gmbRatingAvg: '4.4',
      monthlyEnquiriesAvg: '80-140',
      topCompetitorScore: 82
    },
    platforms: [
      { name: 'Instagram', emoji: '📸', score: D.igNA || !D.ig ? 2 : 6, color: '#FF5C5C', metrics: ['Profile consistency'], findings: ['Improve posting cadence and lead CTAs'], consultingInsight: 'Make content discovery-to-DM journey measurable.' },
      { name: 'Facebook', emoji: '📘', score: D.fbNA || !D.fb ? 2 : 5, color: '#FFAA33', metrics: ['Local trust touchpoint'], findings: ['Standardize offers and testimonials'], consultingInsight: 'Treat Facebook as social proof and remarketing base.' },
      { name: 'Google Business', emoji: '📍', score: gmbScore, color: gmbScore < 5 ? '#FF5C5C' : '#FFAA33', metrics: [`${gReviews} Reviews`, `${gRating} Rating`], findings: [gReviews < compAvg ? 'Build review velocity to match competitors' : 'Maintain review momentum'], consultingInsight: 'Google profile quality is a core local conversion driver.' },
      { name: 'Website', emoji: '🌐', score: D.website ? 6 : 0, color: D.website ? '#20c997' : '#FF5C5C', metrics: ['Conversion readiness'], findings: ['Strengthen CTA and tracking'], consultingInsight: 'Use website as conversion and trust infrastructure.' },
    ],
    competitors: (googleData?.competitors || []).length > 0
      ? [
        { name: `${D.bizName} (You)`, score: baseScore, isYou: true, reviews: String(gReviews), igFollowers: 'n/a', gmbRating: String(gRating), rank: 3, competitorInsight: 'Baseline from submitted business inputs.' },
        ...googleData.competitors.map((c, i) => ({
          name: c.name,
          score: clamp(80 + (3 - i) * 5, 60, 95),
          isYou: false,
          reviews: String(c.reviews),
          igFollowers: 'n/a',
          gmbRating: String(c.rating || 'n/a'),
          rank: i + 1,
          competitorInsight: 'Strong local presence and review momentum.'
        }))
      ]
      : [
        { name: `${D.bizName || 'Your Business'} (You)`, score: baseScore, isYou: true, reviews: 'n/a', igFollowers: 'n/a', gmbRating: 'n/a', rank: 3, competitorInsight: 'Baseline from submitted business inputs.' },
        { name: `Top ${D.bizType || 'Competitor'} · ${D.bizCity || 'Area'}`, score: Math.min(95, baseScore + 10), isYou: false, reviews: '220', igFollowers: '8,000', gmbRating: '4.5', rank: 1, competitorInsight: 'Consistent brand signals and review momentum.' },
        { name: `Market Leader · ${D.bizCity || 'Nearby'}`, score: Math.min(95, baseScore + 6), isYou: false, reviews: '180', igFollowers: '6,500', gmbRating: '4.4', rank: 2, competitorInsight: 'Balanced social presence and discoverability.' },
        { name: `Emerging Rival · ${D.bizCity || 'Local'}`, score: Math.max(20, baseScore - 4), isYou: false, reviews: '95', igFollowers: '2,500', gmbRating: '4.1', rank: 4, competitorInsight: 'Moderate execution with inconsistent funnel follow-through.' },
      ],
    opportunities: [
      { area: 'Review Engine', effort: 'Low', impact: 'High', roiLabel: 'Fast ROI', timeToSee: '2-4 weeks', action: 'Launch weekly review campaign with templates.' },
      { area: 'Content System', effort: 'Med', impact: 'High', roiLabel: 'Compounding', timeToSee: '4-8 weeks', action: 'Build monthly content calendar mapped to offers.' },
      { area: 'Conversion Funnel', effort: 'Med', impact: 'High', roiLabel: 'Revenue Lift', timeToSee: '2-6 weeks', action: 'Implement unified WhatsApp + landing CTA flow.' },
    ],
    freeActions: [
      { icon: '✅', title: 'Fix Profile Basics', desc: 'Update category, contact info, and service details on all channels.' },
      { icon: '✅', title: 'Collect Weekly Reviews', desc: 'Request reviews from recent customers every week.' },
      { icon: '✅', title: 'Single CTA Everywhere', desc: 'Route all bios/posts to one WhatsApp enquiry flow.' },
    ],
    strategicRecommendations: [
      { priority: 'P1', title: 'Establish platform consistency', rationale: 'Inconsistent signals reduce trust.', expectedOutcome: 'Higher profile conversion rates.', effort: 'Low' },
      { priority: 'P2', title: 'Build enquiry pipeline', rationale: 'Current demand capture is fragmented.', expectedOutcome: 'More predictable weekly leads.', effort: 'Medium' },
      { priority: 'P3', title: 'Add measured promotion', rationale: 'Organic alone slows growth.', expectedOutcome: 'Faster qualified enquiry velocity.', effort: 'Medium' },
    ],
    recommendation: {
      packageName,
      packageBadge: 'Recommended',
      price: packageName.includes('Digital') ? '₹40,000' : packageName.includes('Performance') ? '₹21,000/mo' : '₹22,000/mo',
      priceNumeric: packageName.includes('Digital') ? 40000 : packageName.includes('Performance') ? 21000 : 22000,
      discountedPrice: packageName.includes('Digital') ? '₹36,000 (10% off)' : packageName.includes('Performance') ? '₹18,900/mo (10% off)' : '₹19,800/mo (10% off)',
      discountedNumeric: packageName.includes('Digital') ? 36000 : packageName.includes('Performance') ? 18900 : 19800,
      discountSaving: packageName.includes('Digital') ? '₹4,000 saved' : packageName.includes('Performance') ? '₹2,100 saved' : '₹2,200 saved',
      why: 'Selected based on current presence gaps, growth urgency, and declared budget.',
      whyBullets: ['Closes high-impact visibility gaps', 'Improves enquiry conversion path', 'Creates measurable 90-day momentum'],
      features: ['Channel setup/optimization', 'Lead funnel templates', 'Performance tracking', 'Monthly action plan', 'Creative guidance', 'Execution support'],
      outcome90Days: 'Core channels and conversion workflow become operational with measurable lead improvements.',
      roiJustification: 'Estimated uplift from higher visibility and better lead capture offsets implementation costs.',
    },
    showHostinger: false,
    hostingerRec: 'business',
  };
}

async function generateAudit(formData, googleData) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    if (ENABLE_FREE_FALLBACK) {
      return localGenerateBasicAudit(formData, googleData);
    }
    throw new Error('ANTHROPIC_API_KEY is not configured');
  }

  const client = new Anthropic({ apiKey });
  const userMessage = buildUserMessage(formData, googleData);

  try {
    const msg = await client.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    });

    const text = msg.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');

    return extractJsonFromText(text);
  } catch (err) {
    if (ENABLE_FREE_FALLBACK) {
      console.warn('generateAudit: Anthropic failed, using free fallback:', err.message);
      return localGenerateBasicAudit(formData, googleData);
    }
    throw err;
  }
}

function normalizeBody(body) {
  return {
    businessName: body.businessName ?? body.bizName ?? '',
    businessType: body.businessType ?? body.bizType ?? 'other',
    city: body.city ?? '',
    area: body.area ?? '',
    igFollowers: body.igFollowers ?? 0,
    hasWhatsapp:
      body.hasWhatsapp === true ||
      body.hasWhatsapp === 'yes' ||
      body.hasWhatsapp === 'true',
    hasWebsite:
      body.hasWebsite === true ||
      body.hasWebsite === 'yes' ||
      body.hasWebsite === 'true',
    websiteUrl: body.websiteUrl ?? body.website ?? '',
    runningAds:
      body.runningAds === true ||
      body.runningAds === 'yes' ||
      body.runningAds === 'true',
    userName: body.userName ?? body.leadName ?? '',
    userWhatsapp: body.userWhatsapp ?? body.leadPhone ?? '',
  };
}

/** Full audit form object from ai-Audit.html (same shape as browser `D`). */
function normalizePremiumD(body) {
  const b = body || {};
  return {
    bizName: b.bizName ?? '',
    bizType: b.bizType ?? '',
    bizCity: b.bizCity ?? b.city ?? '',
    bizEmail: b.bizEmail ?? '',
    ig: b.ig ?? '',
    fb: b.fb ?? '',
    gmb: b.gmb ?? '',
    website: b.website ?? '',
    goal: b.goal ?? '',
    budget: b.budget ?? '',
    enquiries: b.enquiries ?? '',
    bizAge: b.bizAge ?? '',
    context: b.context ?? '',
    leadName: b.leadName ?? '',
    leadPhone: b.leadPhone ?? '',
    calltime: b.calltime ?? '',
    igNA: !!b.igNA,
    fbNA: !!b.fbNA,
    gmbNA: !!b.gmbNA,
    timeline: b.timeline ?? '',
  };
}

function mapDisplayBizTypeToGooglePlaces(display) {
  const s = String(display || '').toLowerCase();
  if (s.includes('dental')) return 'dental';
  if (s.includes('gym') || s.includes('fitness')) return 'gym';
  if (s.includes('café') || s.includes('cafe') || s.includes('coffee')) return 'cafe';
  if (s.includes('restaurant')) return 'restaurant';
  if (s.includes('school') || s.includes('coaching')) return 'school';
  if (s.includes('salon') || s.includes('beauty')) return 'salon';
  if (s.includes('hotel') || s.includes('homestay')) return 'hotel';
  if (s.includes('healthcare') || s.includes('clinic')) return 'healthcare';
  return 'other';
}

async function fetchGoogleDataForPremium(D) {
  const googleKey = process.env.GOOGLE_PLACES_API_KEY;
  const serperKey = process.env.SERPER_API_KEY;

  let googleData = null;
  if (googleKey) {
    try {
      googleData = await fetchGoogleData(
        D.bizName,
        D.bizCity || '',
        mapDisplayBizTypeToGooglePlaces(D.bizType),
      );
    } catch (e) {
      console.warn('Google Places fetch failed, trying Serper fallback...');
    }
  }

  // If googleData is missing (billing issue), use Serper for BOTH the business and competitors
  if (!googleData || !googleData.listedOnGoogle) {
    if (serperKey) {
      console.log(`[RESEARCH] Querying Serper.dev for subject: ${D.bizName} in ${D.bizCity}`);
      const subjectSearch = await fetchSerperData(`${D.bizName} ${D.bizCity}`);
      const me = subjectSearch?.competitors?.find(c =>
        c.name.toLowerCase().includes(D.bizName.toLowerCase()) || 
        D.bizName.toLowerCase().includes(c.name.toLowerCase())
      ) || subjectSearch?.competitors?.[0];

      const compQuery = `Top ${D.bizType || 'Business'} in ${D.bizCity || 'me'}`;
      console.log(`[RESEARCH] Querying Serper.dev for competitors: ${compQuery}`);
      const serperData = await fetchSerperData(compQuery);

      googleData = {
        googleReviews: me?.reviews || 0,
        googleRating: me?.rating || 0,
        listedOnGoogle: !!me,
        placeId: 'serper_fallback',
        name: me?.name || D.bizName,
        competitors: serperData?.competitors || [],
        competitorAvgReviews: serperData?.competitorAvgReviews || 120
      };
      
      console.log(`[RESEARCH] Subject found: ${googleData.listedOnGoogle}. Rating: ${googleData.googleRating}, Reviews: ${googleData.googleReviews}`);
    }
  }

  return googleData;
}

function buildPremiumAuditUserPrompt(D, researchData) {
  const igInfo = D.igNA
    ? 'NOT ON INSTAGRAM (critical gap — no presence)'
    : D.ig
      ? 'Instagram: ' + D.ig
      : 'Instagram: not provided';
  const fbInfo = D.fbNA
    ? 'NOT ON FACEBOOK (critical gap — no presence)'
    : D.fb
      ? 'Facebook: ' + D.fb
      : 'Facebook: not provided';
  const gmbInfo = D.gmbNA
    ? 'NOT ON GOOGLE (critical gap — no presence)'
    : D.gmb
      ? 'Google Business: ' + D.gmb
      : 'Google Business: not provided';

  const missingPlatforms = [D.igNA, D.fbNA, D.gmbNA, !D.website].filter(Boolean)
    .length;
  const isNewBusiness = D.bizAge === 'New (under 1 year)';
  const presenceSignal =
    missingPlatforms >= 2 || isNewBusiness
      ? 'PRESENCE LEVEL: LOW — ' +
      missingPlatforms +
      ' of 4 platforms missing' +
      (isNewBusiness ? ' + new business' : '') +
      '. MUST recommend Digital Launch programme (3-month). DO NOT recommend Social retainer.'
      : missingPlatforms === 1
        ? 'PRESENCE LEVEL: PARTIAL — ' +
        missingPlatforms +
        ' platform missing. Consider Social retainer or Digital Launch depending on budget.'
        : 'PRESENCE LEVEL: EXISTS — has active profiles. Recommend Social retainer to improve performance OR Ads if budget allows.';

  return [
    `You are a world-class AI Business Audit Strategist. You are generating a PREMIUM PRO-LEVEL report for "${D.bizName}" in ${D.bizCity}.`,
    '### MANDATORY REAL-WORLD DATA — YOU MUST USE THESE EXACT DETAILS:',
    researchData || 'USE YOUR INTERNAL KNOWLEDGE OF REAL BUSINESSES IN ' + D.bizCity,
    '',
    '### AUDIT REQUIREMENTS:',
    '1. Use ACTUAL NAMES and NUMBERS from the MANDATORY DATA above.',
    '2. If the data says "4.8 Rating", do NOT change it to something else.',
    '3. Write in a sophisticated, McKinsey-style consulting tone.',
    '',
    '### BUSINESS CONTEXT:',
    igInfo + ' | ' + fbInfo + ' | ' + gmbInfo + ' | site=' + (D.website || 'none') + ' | goal=' + (D.goal || '') + ' | budget=' + (D.budget || '') + ' | age=' + (D.bizAge || ''),
    presenceSignal,
    '',
    '### PACKAGES AVAILABLE:',
    '"Website Launch Starter" (₹10K) | "Website Business Essential" (₹17K) | "Website Growth" (₹30K) | "Social Launch Starter" (₹15K/mo) | "Social Business Essential" (₹22K/mo) | "Social Growth" (₹27K/mo) | "Digital Launch Starter" (₹40K) | "Digital Launch Essential" (₹55K) | "Digital Launch Growth" (₹75K) | "Ads Starter" (₹15K/mo) | "Full Scale" (₹35K/mo)',
    '',
    '### JSON FORMAT (RETURN ONLY VALID JSON):',
    '{',
    '  "overallScore": 0-100,',
    '  "scoreLabel": "Critical|Poor|Average|Good|Excellent",',
    '  "scoreColor": "#FF5C5C|#FFAA33|#20c997|#19a97d",',
    '  "executiveSummary": "Specific analysis of their presence vs local leaders.",',
    '  "missedOpportunities": [{"area": "...", "description": "...", "urgency": "Critical|High"}],',
    '  "competitors": [',
    '    {"name": "Your exact business name from data", "isYou": true, "reviews": "...", "gmbRating": "...", "score": 0-100, "rank": 1-4, "competitorInsight": ""},',
    '    {"name": "Actual competitor #1 from data", "isYou": false, "reviews": "...", "gmbRating": "...", "score": 0-100, "rank": 1-4, "competitorInsight": "One sentence why stay ahead"},',
    '    {"name": "Actual competitor #2 from data", "isYou": false, "reviews": "...", "gmbRating": "...", "score": 0-100, "rank": 1-4, "competitorInsight": "..."},',
    '    {"name": "Actual competitor #3 from data", "isYou": false, "reviews": "...", "gmbRating": "...", "score": 0-100, "rank": 1-4, "competitorInsight": "..."}',
    '  ],',
    '  "platforms": [ detailed objects ],',
    '  "strategicRecommendations": [ prioritised items ],',
    '  "recommendation": {"packageName": "...", "price": "...", "why": "...", "outcome90Days": "..."}',
    '}',
    '',
    '### FINAL REMINDER: YOU ARE GENERATING A REAL AUDIT FOR A REAL PAYING CUSTOMER. DO NOT USE PLACEHOLDERS. USE THE EXACT NAMES AND RATINGS FROM THE MANDATORY DATA AT THE TOP.',
    'IF RESEARCH DATA SAYS "DYU ART CAFE", USE "DYU ART CAFE". IF RESEARCH SAYS NO IG DATA, MARK IG AS 0 BUT USE THE REAL COMPETITOR NAME.',
    '',
    '### CRITICAL PACKAGE SELECTION RULES — apply in this exact order:',
    'RULE 1 — DIGITAL LAUNCH (3-month): Recommend "Digital Launch" tier if ANY of these are true: (a) business has NO website AND no Instagram AND no Google Business — i.e. 2+ platforms marked as NOT ON; (b) business age is "New (under 1 year)"; (c) business explicitly says they have NO digital presence yet. Digital Launch builds everything from scratch in 90 days. Choose Starter/Essential/Growth tier based on budget: <₹45K→Starter, ₹45K–₹65K→Essential, ₹65K+→Growth.',
    'RULE 2 — WEBSITE ONLY: Recommend website package ONLY if: budget is under ₹15K/mo AND they already have social media active. One-time investment.',
    'RULE 3 — SOCIAL RETAINER (12-month): Recommend "Social" tier if: business HAS existing presence (at least 1 platform active) but it is performing poorly. This is ongoing monthly management. Dental/Gym/Salon/Café/School with existing IG/Google→"Social Business Essential" minimum.',
    'RULE 4 — PERFORMANCE ADS: Recommend "Ads" tier if: budget ≥₹25K/mo AND business already has good social presence and website. Ads on top of existing presence.',
    'IMPORTANT: "Digital Launch" is a 3-MONTH one-time programme, NOT a monthly retainer. In the "why" field, explicitly mention the 3-month nature and what gets built. In outcome90Days, say what is fully operational after the 3 months. Do NOT recommend Social retainer for a business with zero/no presence.',
    '',
    'Generate this JSON with ALL fields filled with specific, insight-driven, consulting-grade content:',
    '{',
    '"overallScore": 0-100,',
    '"scoreLabel": "Critical|Poor|Average|Good|Excellent",',
    '"scoreColor": "#FF5C5C|#FFAA33|#20c997|#19a97d",',
    '"estimatedMonthlyLoss": "₹X,XXX – ₹X,XXX",',
    '"keyGaps": ["specific gap with numbers","specific gap","specific gap"],',
    '"executiveSummary": "three sentences with numbers and urgency",',
    '"brandPositioning": {"assessment": "...", "gap": "...", "impact": "..."},',
    '"missedOpportunities": [',
    '  {"area": "...", "description": "...", "estimatedMonthlyLoss": "₹X,XXX", "urgency": "Critical|High|Medium"},',
    '  {"area": "...", "description": "...", "estimatedMonthlyLoss": "₹X,XXX", "urgency": "Critical|High|Medium"},',
    '  {"area": "...", "description": "...", "estimatedMonthlyLoss": "₹X,XXX", "urgency": "Critical|High|Medium"}',
    '],',
    '"dataPoints": {"igFollowers":"n","igPostsPerMonth":"n","igEngagementRate":"X%","igReelsUsed":bool,"fbFollowers":"n","fbLastPostDays":"n","gmbReviews":"n","gmbRating":"X.X","gmbVerified":bool,"gmbPhotos":"n","websiteHasWhatsApp":bool,"adsRunning":bool,"whatsappFunnelSetup":bool},',
    '"benchmarks": {"igFollowersAvg":"n","igPostsPerMonthAvg":"n","igEngagementRateAvg":"X%","gmbReviewsAvg":"n","gmbRatingAvg":"X.X","monthlyEnquiriesAvg":"n-n","topCompetitorScore":0-100},',
    '// PLATFORMS — 4 items: Instagram, Facebook, Google Business, Website — each with emoji, score 0-10, color hex, metrics[], findings[], consultingInsight',
    '"platforms": [ detailed objects per frontend contract ],',
    '"competitors": [',
    '  {"name":"' +
    String(D.bizName).replace(/\\/g, '\\\\').replace(/"/g, '\\"') +
    ' (You)","score":n,"isYou":true,"reviews":"n","igFollowers":"n","gmbRating":"X.X","rank":1-4,"competitorInsight":""},',
    '  {"name":"Competitor name","score":n,"isYou":false,"reviews":"n","igFollowers":"n","gmbRating":"X.X","rank":1-4,"competitorInsight":"One sentence"},',
    '  two more competitor objects isYou false with realistic local names when possible',
    '],',
    '"opportunities": [3 items area effort Low|Med|High impact roiLabel timeToSee action],',
    '"freeActions": [3 items icon title desc],',
    '"strategicRecommendations": [3 items priority title rationale expectedOutcome effort],',
    '"recommendation": {"packageName":"...","packageBadge":"...","price":"₹X","priceNumeric":n,"discountedPrice":"₹X (10% off)","discountedNumeric":n,"discountSaving":"₹X saved","why":"...","whyBullets":["","",""],"features":["","","","","",""],"outcome90Days":"...","roiJustification":"..."},',
    '"showHostinger":bool,"hostingerRec":"premium|business"',
    '}',
  ].join('\n');
}

async function generatePremiumAuditReport(D) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const googleData = await fetchGoogleDataForPremium(D);
  console.log('[DEBUG] Final googleData for AI:', JSON.stringify(googleData, null, 2));

  if (!apiKey) {
    if (ENABLE_FREE_FALLBACK) {
      console.log('generatePremiumAuditReport: No Anthropic key, using improved local fallback');
      return localGeneratePremiumReport(D, googleData);
    }
    throw new Error('ANTHROPIC_API_KEY is not configured');
  }

  // Build research string for AI
  let researchData = 'none';
  if (googleData) {
    const bits = [];
    if (googleData.listedOnGoogle) {
      bits.push(`SUBJECT BUSINESS: listed on Maps with ${googleData.googleReviews} reviews and ${googleData.googleRating} rating.`);
    } else {
      bits.push(`SUBJECT BUSINESS: Not found on Google Maps yet.`);
    }
    if (googleData.competitors?.length) {
      bits.push('ACTUAL LOCAL COMPETITORS FOUND:');
      googleData.competitors.forEach((c, i) => {
        bits.push(`${i + 1}. NAME: "${c.name}", REVIEWS: ${c.reviews}, RATING: ${c.rating}, ADDRESS: ${c.address || 'near ' + D.bizCity}`);
      });
    }
    researchData = bits.join('\n');
  }

  // Debug: log the research data being sent to AI
  console.log('[AI PROMPT] Research payload:\n' + researchData);

  const userPrompt = buildPremiumAuditUserPrompt(D, researchData);
  console.log('[DEBUG] Anthropic Key Length:', (apiKey || '').length);

  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 4096,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
    const cleaned = text.replace(/```json|```/g, '').trim();
    console.log('[AI RESPONSE] Successfully generated JSON report.');
    return extractJsonFromText(cleaned);
  } catch (err) {
    console.error('[AI ERROR] generatePremiumAuditReport failed:', err.message);
    if (ENABLE_FREE_FALLBACK) {
      console.warn('Falling back to local template because AI failed...');
      return localGeneratePremiumReport(D, googleData);
    }
    throw err;
  }
}

const app = express();
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});
app.use(express.json({ limit: '35mb' }));

const AUDIT_PRICE_PAISE = Number(process.env.AUDIT_PRICE_PAISE || 29900);

function verifyRazorpaySignature(orderId, paymentId, signature) {
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!secret || !orderId || !paymentId || !signature) return false;
  const body = `${orderId}|${paymentId}`;
  const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
  return expected === signature;
}

async function verifyRazorpayPaymentCaptured(paymentId) {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret || !paymentId) return false;
  const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
  const r = await fetch(`https://api.razorpay.com/v1/payments/${paymentId}`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!r.ok) return false;
  const p = await r.json();
  return (
    p.status === 'captured' && Number(p.amount) === AUDIT_PRICE_PAISE
  );
}

async function assertPaidAuditRequest(body) {
  const allowUnverified =
    String(process.env.AUDIT_EMAIL_ALLOW_WITHOUT_PAYMENT_VERIFY || '')
      .trim()
      .toLowerCase() === 'true';
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } =
    body || {};

  if (
    razorpay_order_id &&
    razorpay_payment_id &&
    razorpay_signature &&
    verifyRazorpaySignature(
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
    )
  ) {
    return { ok: true };
  }

  if (razorpay_payment_id && (await verifyRazorpayPaymentCaptured(razorpay_payment_id))) {
    return { ok: true };
  }

  if (allowUnverified) {
    console.warn(
      'email-audit-pdf: sent without payment verification (AUDIT_EMAIL_ALLOW_WITHOUT_PAYMENT_VERIFY=true)',
    );
    return { ok: true };
  }

  return {
    ok: false,
    error:
      'Payment not verified. Add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET to .env (Dashboard → API Keys), or for local testing only set AUDIT_EMAIL_ALLOW_WITHOUT_PAYMENT_VERIFY=true',
  };
}

function createAuditMailTransport() {
  const host = (process.env.SMTP_HOST || '').trim();
  const user = (process.env.SMTP_USER || '').trim();
  const pass = (process.env.SMTP_PASS || '').trim();
  if (!host || !user || !pass) return null;
  const port = Number(process.env.SMTP_PORT || 587);
  const secure =
    String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' ||
    port === 465;
  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
  });
}

const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Diagnostic: check if SMTP is configured correctly by actually connecting to the server
 * and optionally sending a test email. Never returns the password.
 *   GET  /api/email-diag                 → verifies the SMTP connection (no email sent)
 *   POST /api/email-diag   body:{to}     → sends a tiny test email to `to`
 */
app.get('/api/email-diag', async (_req, res) => {
  const out = {
    ok: false,
    smtp_host: (process.env.SMTP_HOST || '').trim() || null,
    smtp_port: Number(process.env.SMTP_PORT || 587),
    smtp_user: (process.env.SMTP_USER || '').trim() || null,
    smtp_pass_present: Boolean((process.env.SMTP_PASS || '').trim()),
    smtp_pass_len: String(process.env.SMTP_PASS || '').trim().length,
    smtp_secure: String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true',
    mail_from: (process.env.MAIL_FROM || '').trim() || null,
    verify_ok: false,
    error: null,
    hint: null,
  };
  const transport = createAuditMailTransport();
  if (!transport) {
    out.error = 'SMTP_HOST / SMTP_USER / SMTP_PASS missing in .env. Restart Node after editing .env.';
    out.hint = 'Fill the SMTP_* lines in .env and run `npm start` again.';
    return res.json(out);
  }
  try {
    await transport.verify();
    out.verify_ok = true;
    out.ok = true;
  } catch (err) {
    out.error = err && err.message ? err.message : String(err);
    if (/invalid login|535|authentication/i.test(out.error)) {
      out.hint = 'Gmail rejected the App Password. Common causes: (1) 2-Step Verification is not enabled on the Gmail account, (2) App Password was revoked/expired, (3) password was typed with extra spaces. Generate a fresh App Password at https://myaccount.google.com/apppasswords and update SMTP_PASS in .env, then restart Node.';
    } else if (/ETIMEDOUT|ECONNREFUSED/i.test(out.error)) {
      out.hint = 'Could not reach the SMTP host. Check SMTP_HOST / SMTP_PORT, or your network/firewall.';
    } else if (/self signed|certificate/i.test(out.error)) {
      out.hint = 'TLS certificate issue. For Gmail use port 587 with SMTP_SECURE=false, or port 465 with SMTP_SECURE=true.';
    }
  }
  return res.json(out);
});

app.post('/api/email-diag', async (req, res) => {
  const to = String((req.body && req.body.to) || '').trim();
  if (!EMAIL_RX.test(to)) {
    return res.status(400).json({ ok: false, error: 'Provide a valid "to" email in the request body.' });
  }
  const transport = createAuditMailTransport();
  if (!transport) {
    return res.status(503).json({ ok: false, error: 'SMTP not configured on server.' });
  }
  try {
    await transport.verify();
    const from = (process.env.MAIL_FROM || '').trim() || `"Numero Uno Marketing" <${process.env.SMTP_USER}>`;
    const info = await transport.sendMail({
      from,
      to,
      subject: 'Numero Uno — SMTP Test',
      text: 'If you can read this, your Gmail SMTP setup is working correctly and the AI Audit flow will be able to email PDF reports to customers.',
      html: '<p>If you can read this, your Gmail SMTP setup is working correctly and the AI Audit flow will be able to email PDF reports to customers.</p>',
    });
    return res.json({ ok: true, messageId: info.messageId, to });
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    let hint = null;
    if (/invalid login|535|authentication/i.test(msg)) {
      hint = 'Gmail rejected the App Password. Generate a fresh one and update SMTP_PASS in .env, then restart Node.';
    }
    return res.status(500).json({ ok: false, error: msg, hint });
  }
});

/**
 * After successful Razorpay payment, the browser POSTs the generated PDF here.
 * Verifies payment (Razorpay API or signature), sends PDF to the customer's business email via SMTP.
 */
app.post('/api/email-audit-pdf', async (req, res) => {
  try {
    const body = req.body || {};
    const to = String(body.to || '').trim();
    const subject = String(body.subject || '').trim();
    const text = String(body.text || '').trim();
    const pdfBase64 = String(body.pdfBase64 || '').trim();
    const pdfNameRaw = String(body.pdfName || 'AI_Audit_Report.pdf').trim();
    const pdfName = pdfNameRaw.replace(/[/\\]/g, '_').slice(0, 180);
    const leadName = String(body.leadName || '').trim();
    const bizName = String(body.bizName || '').trim();

    if (!to || !EMAIL_RX.test(to)) {
      return res.status(400).json({ ok: false, error: 'Valid "to" email is required' });
    }
    if (!subject) {
      return res.status(400).json({ ok: false, error: 'subject is required' });
    }
    if (!text) {
      return res.status(400).json({ ok: false, error: 'text body is required' });
    }
    if (!pdfBase64 || pdfBase64.length < 100) {
      return res.status(400).json({ ok: false, error: 'pdfBase64 is missing or too small' });
    }

    let pdfBuffer;
    try {
      pdfBuffer = Buffer.from(pdfBase64, 'base64');
    } catch (e) {
      return res.status(400).json({ ok: false, error: 'Invalid pdfBase64' });
    }
    if (!pdfBuffer.length || pdfBuffer.length > 25 * 1024 * 1024) {
      return res.status(400).json({ ok: false, error: 'PDF attachment size invalid' });
    }

    // Allow a debug bypass when ENABLE_FREE_FALLBACK is enabled on the server.
    // This lets developers test the full post-payment flow locally without a real Razorpay payment.
    let paid;
    const freeFallbackEnabled = String(process.env.ENABLE_FREE_FALLBACK || '').trim().toLowerCase() !== 'false';
    const debugRequested = Boolean(body.debug || (req.headers && String(req.headers['x-debug'] || '').trim() === '1') || (req.query && (req.query.debug === '1' || req.query.debug === 'true')));
    if (freeFallbackEnabled && debugRequested) {
      console.log('email-audit-pdf: debug bypass active (ENABLE_FREE_FALLBACK=true) — skipping payment verification');
      paid = { ok: true };
    } else {
      paid = await assertPaidAuditRequest(body);
    }

    if (!paid.ok) {
      return res.status(403).json({ ok: false, error: paid.error });
    }

    const transport = createAuditMailTransport();
    if (!transport) {
      return res.status(503).json({
        ok: false,
        error:
          'SMTP not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS (and optional SMTP_PORT, MAIL_FROM) in .env',
      });
    }

    const from =
      (process.env.MAIL_FROM || '').trim() ||
      `"Numero Uno Marketing" <${process.env.SMTP_USER}>`;
    const esc = (s) =>
      String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    const safeBiz = esc(bizName || 'your business');
    const greet = leadName ? `Hi ${esc(leadName)},` : 'Hi,';
    const html = `<!DOCTYPE html><html><body style="font-family:system-ui,Segoe UI,sans-serif;line-height:1.6;color:#111;">
<p>${greet}</p>
<p>Thank you for your purchase. Your <strong>AI Digital Presence Audit</strong> for <strong>${safeBiz}</strong> is attached as a PDF.</p>
<p>If you have any questions, reply to this email or reach us on WhatsApp <strong>+91 96320 91371</strong>.</p>
<p style="margin-top:24px;color:#555;font-size:14px;">Best regards,<br><strong>Numero Uno Marketing</strong><br>Bangalore</p>
</body></html>`;

    await transport.sendMail({
      from,
      to,
      replyTo: (process.env.MAIL_REPLY_TO || '').trim() || undefined,
      subject,
      text,
      html,
      attachments: [
        {
          filename: pdfName.endsWith('.pdf') ? pdfName : `${pdfName}.pdf`,
          content: pdfBuffer,
          contentType: 'application/pdf',
        },
      ],
    });

    console.log(`email-audit-pdf: delivered to ${to} (${pdfBuffer.length} bytes)`);
    return res.json({ ok: true });
  } catch (err) {
    console.error('/api/email-audit-pdf', err);
    return res.status(500).json({
      ok: false,
      error: err.message || 'Failed to send email',
    });
  }
});

/**
 * Full McKinsey-style JSON report for ai-Audit.html.
 * Body: same fields as browser global `D` (bizName, bizType, bizCity, ig, fb, gmb, …).
 * Requires ANTHROPIC_API_KEY. GOOGLE_PLACES_API_KEY optional (adds competitor context).
 */
app.post('/api/premium-audit', async (req, res) => {
  try {
    const D = normalizePremiumD(req.body || {});
    if (!D.bizName || !D.bizCity) {
      return res.status(400).json({
        ok: false,
        error: 'bizName and bizCity are required',
      });
    }
    if (!process.env.ANTHROPIC_API_KEY && !ENABLE_FREE_FALLBACK) {
      return res.status(503).json({
        ok: false,
        error:
          'ANTHROPIC_API_KEY missing. Create Numer/.env from .env.example and restart the server.',
      });
    }
    const report = await generatePremiumAuditReport(D);
    return res.json({ ok: true, report });
  } catch (err) {
    console.error('/api/premium-audit', err);
    return res.status(500).json({
      ok: false,
      error:
        err.message ||
        'Premium audit failed. Check API key, quota, and ANTHROPIC_MODEL.',
    });
  }
});

app.post('/api/generate-audit', async (req, res) => {
  try {
    const formData = normalizeBody(req.body || {});

    if (!formData.businessName || !formData.city) {
      return res.status(400).json({
        ok: false,
        error: 'businessName and city are required',
      });
    }

    if (!process.env.GOOGLE_PLACES_API_KEY) {
      console.warn(
        '/api/generate-audit: GOOGLE_PLACES_API_KEY is missing, continuing without Google context',
      );
    }
    if (!process.env.ANTHROPIC_API_KEY && !ENABLE_FREE_FALLBACK) {
      return res.status(500).json({
        ok: false,
        error: 'Server misconfiguration: ANTHROPIC_API_KEY is missing',
      });
    }

    const googleData = await fetchGoogleData(
      formData.businessName,
      [formData.city, formData.area].filter(Boolean).join(' '),
      formData.businessType
    );

    const audit = await generateAudit(formData, googleData);

    return res.json({
      ok: true,
      googleData,
      audit,
    });
  } catch (err) {
    console.error('/api/generate-audit', err);
    return res.status(500).json({
      ok: false,
      error:
        err.message ||
        'Audit generation failed. Check API keys and model availability.',
    });
  }
});

/**
 * Exposes the public Razorpay Key ID to the browser.
 * Never exposes RAZORPAY_KEY_SECRET. Key ID is safe (it's used on the client anyway).
 */
app.get('/api/razorpay-config', (_req, res) => {
  const keyId = String(process.env.RAZORPAY_KEY_ID || '').trim();
  const keySecret = String(process.env.RAZORPAY_KEY_SECRET || '').trim();
  if (!keyId) {
    return res.status(503).json({ ok: false, error: 'RAZORPAY_KEY_ID is not configured on the server' });
  }
  const mode = keyId.startsWith('rzp_live_')
    ? 'live'
    : (keyId.startsWith('rzp_test_') ? 'test' : 'unknown');
  return res.json({
    ok: true,
    key_id: keyId,
    mode,
    has_secret: Boolean(keySecret),
    amount_paise: AUDIT_PRICE_PAISE,
  });
});

/**
 * Live diagnostic: actually hits Razorpay with the configured keys and reports what fails.
 * Intended for the Step 4 inline diagnostics button. Never leaks the secret.
 */
app.get('/api/razorpay-diag', async (_req, res) => {
  const out = {
    ok: false,
    key_id_present: false,
    key_secret_present: false,
    mode: 'unknown',
    razorpay_reachable: false,
    can_create_order: false,
    razorpay_error: null,
    hint: null,
  };
  try {
    const keyId = String(process.env.RAZORPAY_KEY_ID || '').trim();
    const keySecret = String(process.env.RAZORPAY_KEY_SECRET || '').trim();
    out.key_id_present = Boolean(keyId);
    out.key_secret_present = Boolean(keySecret);
    out.mode = keyId.startsWith('rzp_live_') ? 'live' : (keyId.startsWith('rzp_test_') ? 'test' : 'unknown');

    if (!keyId || !keySecret) {
      out.hint = 'RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET must both be set in .env, then restart the server.';
      return res.json(out);
    }

    // Try a live Razorpay API call: create a tiny test order (₹1) and then don't capture.
    try {
      const order = await razorpay.orders.create({
        amount: 100, // 1 rupee (test probe)
        currency: 'INR',
        receipt: `diag_${Date.now()}`,
        notes: { diag: 'true' },
      });
      out.razorpay_reachable = true;
      out.can_create_order = Boolean(order && order.id);
      out.ok = out.can_create_order;
      if (!out.ok) out.hint = 'Razorpay returned no order id.';
    } catch (rzpErr) {
      out.razorpay_reachable = false;
      const msg = (rzpErr && (rzpErr.error?.description || rzpErr.message)) || 'Unknown Razorpay error';
      out.razorpay_error = msg;
      // Common hints
      if (/authentication/i.test(msg) || /invalid key/i.test(msg) || /unauthorized/i.test(msg) || rzpErr?.statusCode === 401) {
        out.hint = 'Razorpay rejected your API keys. KEY_ID and KEY_SECRET do not match, or the keys are from different modes (live vs test). Double-check both in .env, save, and restart Node.';
      } else if (/activation/i.test(msg) || /account is not activated/i.test(msg)) {
        out.hint = 'Your Razorpay account is not yet activated for live mode. Go to Dashboard → Account & Settings → complete KYC & bank activation, or switch back to test keys.';
      } else if (/international/i.test(msg)) {
        out.hint = 'International payments are disabled on this account. Enable them in Razorpay Dashboard → Settings → Payment Methods.';
      } else {
        out.hint = 'Razorpay API rejected the request. See razorpay_error above.';
      }
    }
  } catch (err) {
    out.razorpay_error = err.message || 'Diag failed';
  }
  return res.json(out);
});

/**
 * Places API diagnostic endpoint.
 * Query params:
 *   q - optional text query like "Taj Bangalore" or "Business Name|City"
 */
app.get('/api/places-diag', async (req, res) => {
  try {
    let q = String(req.query.q || '').trim();
    if (!q) q = 'Taj Bangalore';
    // allow "name|city" form
    let businessName = q;
    let city = '';
    if (q.includes('|')) {
      const parts = q.split('|').map(s => s.trim());
      businessName = parts[0] || businessName;
      city = parts[1] || '';
    }

    const googleData = await fetchGoogleData(businessName, city, 'other');
    return res.json({ ok: true, query: q, googleData });
  } catch (err) {
    console.error('/api/places-diag', err && err.message ? err.message : err);
    return res.status(500).json({ ok: false, error: err && err.message ? err.message : 'places diag failed' });
  }
});

/**
 * Creates a new Razorpay Order.
 * Body: { amount: number (paise) }
 */
app.post('/api/create-order', async (req, res) => {
  try {
    const keyId = String(process.env.RAZORPAY_KEY_ID || '').trim();
    const keySecret = String(process.env.RAZORPAY_KEY_SECRET || '').trim();
    if (!keyId || !keySecret) {
      return res.status(503).json({
        ok: false,
        error: 'Razorpay keys missing on server. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in .env and restart Node.',
        code: 'NO_KEYS',
      });
    }

    const amount = Number(req.body.amount || 0);
    if (amount < 100) {
      return res.status(400).json({ ok: false, error: 'Amount must be at least 100 paise', code: 'BAD_AMOUNT' });
    }

    const options = {
      amount,
      currency: 'INR',
      receipt: `receipt_${Date.now()}`,
    };

    const order = await razorpay.orders.create(options);
    return res.json({
      ok: true,
      order_id: order.id,
      amount: order.amount,
      currency: order.currency,
    });
  } catch (err) {
    // Razorpay SDK attaches a structured `.error` on failures — pull out the real reason.
    const rzpDesc = err && err.error && err.error.description;
    const rzpCode = err && err.error && err.error.code;
    const status = Number(err && err.statusCode) || 500;
    const message = rzpDesc || err.message || 'Razorpay order creation failed';
    console.error('Razorpay Create Order Error:', {
      status,
      rzpCode,
      rzpDesc,
      message: err.message,
    });

    let hint = null;
    if (status === 401 || /authentication/i.test(message) || /invalid key/i.test(message)) {
      hint = 'Razorpay rejected your API keys. Check RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET in .env (both must be from the same account and same mode — live or test) and restart Node.';
    } else if (/activation/i.test(message)) {
      hint = 'Your Razorpay account is not activated for live transactions yet. Complete KYC in the Razorpay Dashboard, or switch .env back to your test keys.';
    }

    return res.status(status).json({
      ok: false,
      error: message,
      code: rzpCode || 'RZP_ERROR',
      hint,
    });
  }
});

/**
 * Verifies a Razorpay Payment Signature.
 * Body: { order_id, payment_id, signature }
 */
/**
 * Save audit form data before payment
 * Called from frontend before Razorpay Payment Button is clicked
 * Body: { bizName, bizType, city, ig, fb, gmb, website, email, phone, goal, budget, ... }
 * Returns: { ok: true, sessionKey: "email@example.com" }
 */
app.post('/api/save-audit-session', (req, res) => {
  try {
    const email = (req.body.email || req.body.bizEmail || '').trim();
    const phone = (req.body.phone || req.body.leadPhone || '').trim();
    
    if (!email && !phone) {
      return res.status(400).json({ ok: false, error: 'Email or phone required' });
    }

    const sessionKey = email || phone; // Use email/phone as key to retrieve later

    auditFormSessions.set(sessionKey, {
      ...req.body,
      timestamp: Date.now()
    });

    console.log(`💾 Audit session saved for: ${sessionKey}`);

    return res.json({ ok: true, sessionKey });
  } catch (err) {
    console.error('Save Audit Session Error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * Retrieve audit form data (used by webhook)
 */
function getAuditSession(sessionKey) {
  return auditFormSessions.get(sessionKey);
}

app.post('/api/verify-payment', async (req, res) => {
  try {
    const { order_id, payment_id, signature } = req.body;
    if (!order_id || !payment_id || !signature) {
      return res.status(400).json({ ok: false, error: 'Missing payment fields' });
    }

    const body = order_id + '|' + payment_id;
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(body.toString())
      .digest('hex');

    if (expectedSignature === signature) {
      return res.json({ ok: true, message: 'Payment verified successfully' });
    } else {
      return res.status(400).json({ ok: false, error: 'Signature mismatch' });
    }
  } catch (err) {
    console.error('Razorpay Verify Payment Error:', err);
    return res.status(500).json({ ok: false, error: err.message || 'Payment Verification Failed' });
  }
});

/**
 * Razorpay Webhook Handler (Payment Button Integration)
 * Called by Razorpay when payment events occur
 * Webhook URL in Razorpay Dashboard: Settings → Webhooks → https://yourdomain.com/api/razorpay-webhook
 * Subscribe to: payment.authorized, payment.failed
 */
app.post('/api/razorpay-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    // Get webhook body and signature
    const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    const signature = req.headers['x-razorpay-signature'];

    if (!signature) {
      console.warn('⚠️ Webhook received without signature');
      return res.status(400).json({ ok: false, error: 'Missing signature' });
    }

    // Verify webhook signature
    const hmac = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest('hex');

    if (hmac !== signature) {
      console.error('❌ Webhook signature mismatch');
      return res.status(400).json({ ok: false, error: 'Invalid signature' });
    }

    // Parse webhook body
    const webhookData = JSON.parse(body);
    const event = webhookData.event;
    const paymentEntity = webhookData.payload.payment.entity;

    console.log(`📨 Razorpay Webhook: ${event}`);

    if (event === 'payment.authorized') {
      const paymentId = paymentEntity.id;
      const orderId = paymentEntity.order_id;
      const amount = paymentEntity.amount / 100; // Convert paise to rupees
      const notes = paymentEntity.notes || {};

      console.log(`✅ Payment authorized: ${paymentId} | Order: ${orderId} | Amount: ₹${amount}`);

      // Try to retrieve saved audit session using email or phone
      let auditSession = null;
      const customerEmail = notes.customer_email || notes.email || paymentEntity.email || '';
      const customerPhone = notes.customer_phone || notes.phone || paymentEntity.contact || '';

      if (customerEmail) {
        auditSession = getAuditSession(customerEmail);
      }
      if (!auditSession && customerPhone) {
        auditSession = getAuditSession(customerPhone);
      }

      // Log payment for tracking
      const paymentLog = {
        timestamp: new Date().toISOString(),
        paymentId,
        orderId,
        amount,
        status: 'PAID',
        customerEmail,
        auditSessionFound: !!auditSession
      };
      console.log('💾 Payment Log:', JSON.stringify(paymentLog, null, 2));

      // Generate audit if we have the session data
      if (auditSession) {
        console.log('🚀 Generating audit for:', auditSession.bizName || 'Unknown Business');
        
        try {
          // Call generateAudit with the saved form data
          const auditResult = await generateAudit(auditSession);
          
          console.log(`✅ Audit generated successfully. Score: ${auditResult.score}`);

          // Send audit result email if SMTP is configured
          if (process.env.SMTP_HOST && auditSession.bizEmail) {
            try {
              const transporter = nodemailer.createTransport({
                host: process.env.SMTP_HOST,
                port: Number(process.env.SMTP_PORT || 587),
                secure: String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true',
                auth: {
                  user: process.env.SMTP_USER,
                  pass: process.env.SMTP_PASS,
                },
              });

              const auditSummary = `
                <h2>✅ Your AI Audit Report is Ready!</h2>
                <p>Business: <strong>${auditSession.bizName}</strong></p>
                <p>Overall Score: <strong>${auditResult.score}/100</strong></p>
                <div>
                  <p><strong>Score Breakdown:</strong></p>
                  <ul>
                    <li>Google: ${auditResult.googleScore}/10</li>
                    <li>Instagram: ${auditResult.instagramScore}/10</li>
                    <li>WhatsApp: ${auditResult.whatsappScore}/10</li>
                    <li>Website: ${auditResult.websiteScore}/10</li>
                    <li>Ads: ${auditResult.adsScore}/10</li>
                  </ul>
                </div>
                <p><strong>Estimated Monthly Loss:</strong> ₹${auditResult.monthlyLossLow.toLocaleString('en-IN')} - ₹${auditResult.monthlyLossHigh.toLocaleString('en-IN')}</p>
                <p><strong>Annual Loss Potential:</strong> ₹${auditResult.annualLoss.toLocaleString('en-IN')}</p>
                <div style="margin-top:20px; padding:20px; background:#f0f0f0; border-radius:8px;">
                  <p><strong>Top Gaps:</strong></p>
                  <ol>
                    ${auditResult.topGaps.map(gap => `<li>${gap}</li>`).join('')}
                  </ol>
                </div>
                <p style="margin-top:20px; color:#666;">Visit the dashboard to view the complete report, recommendations, and action items.</p>
              `;

              await transporter.sendMail({
                from: process.env.MAIL_FROM,
                to: auditSession.bizEmail,
                subject: `✅ Your AI Audit Report Ready - Score: ${auditResult.score}/100`,
                html: `
                  <h2>Payment Confirmed!</h2>
                  <p>Your payment of ₹${amount} has been received successfully.</p>
                  <p><strong>Payment ID:</strong> ${paymentId}</p>
                  ${auditSummary}
                  <p style="margin-top:30px;">Thank you for choosing Numero Uno Marketing!</p>
                `,
              });
              console.log('📧 Audit report email sent to:', auditSession.bizEmail);
            } catch (emailErr) {
              console.warn('⚠️ Failed to send audit email:', emailErr.message);
            }
          }

        } catch (auditErr) {
          console.error('❌ Audit generation failed:', auditErr.message);
          
          // Send error notification email
          if (process.env.SMTP_HOST && auditSession.bizEmail) {
            try {
              const transporter = nodemailer.createTransport({
                host: process.env.SMTP_HOST,
                port: Number(process.env.SMTP_PORT || 587),
                secure: String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true',
                auth: {
                  user: process.env.SMTP_USER,
                  pass: process.env.SMTP_PASS,
                },
              });

              await transporter.sendMail({
                from: process.env.MAIL_FROM,
                to: auditSession.bizEmail,
                subject: '⚠️ Payment Confirmed - Audit Generation In Progress',
                html: `
                  <h2>Payment Confirmed!</h2>
                  <p>Thank you for your payment of ₹${amount}.</p>
                  <p>Your AI audit is currently being generated and will be available shortly.</p>
                  <p>We encountered a temporary delay in generating your audit. Our team will process it manually and send you the results within 24 hours.</p>
                  <p>Thank you for your patience!</p>
                `,
              });
              console.log('📧 Status email sent to:', auditSession.bizEmail);
            } catch (emailErr2) {
              console.warn('⚠️ Failed to send status email:', emailErr2.message);
            }
          }
        }

      } else {
        console.warn('⚠️ No audit session found for payment. Customer may need to re-fill form.');
        
        // Send message to customer asking them to complete the form
        if (process.env.SMTP_HOST && customerEmail) {
          try {
            const transporter = nodemailer.createTransport({
              host: process.env.SMTP_HOST,
              port: Number(process.env.SMTP_PORT || 587),
              secure: String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true',
              auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS,
              },
            });

            await transporter.sendMail({
              from: process.env.MAIL_FROM,
              to: customerEmail,
              subject: '✅ Payment Confirmed - Complete Your Audit Form',
              html: `
                <h2>Payment Confirmed!</h2>
                <p>Thank you for your payment of ₹${amount}.</p>
                <p>We've received your payment, but we need you to complete the business details form to generate your audit report.</p>
                <p><a href="${process.env.SITE_URL || 'https://alphanumerouno.in'}/ai-Audit.html">Click here to complete your audit form</a></p>
                <p>Thank you for choosing Numero Uno Marketing!</p>
              `,
            });
            console.log('📧 Form completion email sent to:', customerEmail);
          } catch (emailErr) {
            console.warn('⚠️ Failed to send form email:', emailErr.message);
          }
        }
      }

      return res.json({ ok: true, message: 'Payment processed successfully' });

    } else if (event === 'payment.failed') {
      const paymentId = paymentEntity.id;
      const orderId = paymentEntity.order_id;
      const error = paymentEntity.error_description || 'Unknown error';

      console.log(`❌ Payment failed: ${paymentId} | Reason: ${error}`);

      // TODO: Handle failed payment
      // - Update order status to failed
      // - Notify customer
      // - Log error for debugging

      return res.json({ ok: true, message: 'Payment failure logged' });
    }

    // Unknown event, but acknowledge receipt
    console.log(`ℹ️ Webhook event not processed: ${event}`);
    res.json({ ok: true, message: 'Event acknowledged' });

  } catch (err) {
    console.error('Razorpay Webhook Error:', err.message);
    res.status(500).json({ ok: false, error: 'Webhook processing failed' });
  }
});

app.use(express.static(path.join(__dirname)));


const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`Audit API + static files → http://localhost:${PORT}`);
  console.log(
    `  Premium report: POST /api/premium-audit  ·  Paid PDF email: POST /api/email-audit-pdf`,
  );
  console.log(`  🔔 Razorpay Webhook: POST /api/razorpay-webhook`);
  console.log(`  Open audit UI: http://localhost:${PORT}/ai-Audit.html`);
});

module.exports = {
  app,
  fetchGoogleData,
  generateAudit,
  generatePremiumAuditReport,
  normalizeGoogleType,
};
