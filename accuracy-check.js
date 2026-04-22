/* eslint-disable no-console */
const BASE = process.env.AUDIT_API_BASE || 'http://localhost:3000';

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  return { ok: res.ok, status: res.status, data };
}

function isFiniteNumber(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

function evaluatePremium(report) {
  const checks = [];
  const score = Number(report?.overallScore);
  const rec = String(report?.recommendation?.packageName || '').toLowerCase();
  const hasLoss = /\u20b9|rs|inr/i.test(String(report?.estimatedMonthlyLoss || ''));
  const hasPlatforms = Array.isArray(report?.platforms) && report.platforms.length >= 4;
  const hasGaps = Array.isArray(report?.keyGaps) && report.keyGaps.length >= 3;
  const hasSummary = String(report?.executiveSummary || '').length > 30;

  checks.push({ name: 'overallScore is 0-100', pass: isFiniteNumber(score) && score >= 0 && score <= 100 });
  checks.push({ name: 'estimatedMonthlyLoss present', pass: hasLoss });
  checks.push({ name: 'keyGaps has 3+', pass: hasGaps });
  checks.push({ name: 'platforms has 4+', pass: hasPlatforms });
  checks.push({ name: 'executiveSummary meaningful', pass: hasSummary });
  checks.push({ name: 'recommendation package exists', pass: rec.length > 3 });
  return checks;
}

function evaluateBasic(audit) {
  const checks = [];
  const score = Number(audit?.score);
  const reviewGap = Number(audit?.reviewGap);
  checks.push({ name: 'score is 0-10', pass: isFiniteNumber(score) && score >= 0 && score <= 10 });
  checks.push({ name: 'reviewGap is non-negative', pass: isFiniteNumber(reviewGap) && reviewGap >= 0 });
  checks.push({ name: 'topGaps has 3', pass: Array.isArray(audit?.topGaps) && audit.topGaps.length >= 3 });
  checks.push({ name: 'freeActions has 3', pass: Array.isArray(audit?.freeActions) && audit.freeActions.length >= 3 });
  return checks;
}

function printChecks(title, checks) {
  const passed = checks.filter((c) => c.pass).length;
  console.log(`\n${title}: ${passed}/${checks.length}`);
  for (const c of checks) {
    console.log(` - ${c.pass ? 'PASS' : 'FAIL'}: ${c.name}`);
  }
  return { passed, total: checks.length };
}

async function run() {
  const strong = {
    bizName: 'Clove Dental',
    bizType: 'Dental Clinic',
    bizCity: 'Bangalore',
    ig: '@clovedentalindia',
    fb: 'CloveDentalIndia',
    gmb: 'Clove Dental Indiranagar Bangalore',
    website: 'https://clovedental.in',
    goal: 'Increase new patient bookings',
    budget: '₹45K+/mo',
    enquiries: '80+ per month',
    bizAge: '5+ years',
    leadName: 'QA Test',
    leadPhone: '9999999999',
    igNA: false,
    fbNA: false,
    gmbNA: false,
  };

  const weak = {
    bizName: 'Test Startup Clinic',
    bizType: 'Dental Clinic',
    bizCity: 'Bangalore',
    ig: '',
    fb: '',
    gmb: '',
    website: '',
    goal: 'Get first leads',
    budget: '₹15K-25K/mo',
    enquiries: '0-10 per month',
    bizAge: 'New (under 1 year)',
    leadName: 'QA Test',
    leadPhone: '9999999999',
    igNA: true,
    fbNA: true,
    gmbNA: true,
  };

  console.log(`Checking API at ${BASE}`);
  const strongRes = await postJson(`${BASE}/api/premium-audit`, strong);
  const weakRes = await postJson(`${BASE}/api/premium-audit`, weak);
  const basicRes = await postJson(`${BASE}/api/generate-audit`, {
    businessName: 'Third Wave Coffee',
    businessType: 'cafe',
    city: 'Bangalore',
    area: 'Indiranagar',
    igFollowers: 12000,
    hasWhatsapp: true,
    hasWebsite: true,
    runningAds: true,
  });

  if (!strongRes.ok) {
    console.error('\nFAIL: /api/premium-audit strong case failed', strongRes.status, strongRes.data);
    process.exit(1);
  }
  if (!weakRes.ok) {
    console.error('\nFAIL: /api/premium-audit weak case failed', weakRes.status, weakRes.data);
    process.exit(1);
  }
  if (!basicRes.ok) {
    console.error('\nFAIL: /api/generate-audit failed', basicRes.status, basicRes.data);
    process.exit(1);
  }

  const strongReport = strongRes.data?.report;
  const weakReport = weakRes.data?.report;
  const basicAudit = basicRes.data?.audit;

  const strongChecks = evaluatePremium(strongReport);
  const weakChecks = evaluatePremium(weakReport);
  const basicChecks = evaluateBasic(basicAudit);

  const s = printChecks('Premium strong-case structure', strongChecks);
  const w = printChecks('Premium weak-case structure', weakChecks);
  const b = printChecks('Basic audit structure', basicChecks);

  const strongScore = Number(strongReport?.overallScore || 0);
  const weakScore = Number(weakReport?.overallScore || 0);
  const recStrong = String(strongReport?.recommendation?.packageName || '');
  const recWeak = String(weakReport?.recommendation?.packageName || '');
  const deltaPass = strongScore >= weakScore;

  console.log('\nDirectional checks:');
  console.log(` - ${deltaPass ? 'PASS' : 'FAIL'}: strong score (${strongScore}) >= weak score (${weakScore})`);
  console.log(` - INFO: strong package="${recStrong}" | weak package="${recWeak}"`);

  const totalPassed = s.passed + w.passed + b.passed + (deltaPass ? 1 : 0);
  const totalChecks = s.total + w.total + b.total + 1;
  console.log(`\nAccuracy smoke score: ${totalPassed}/${totalChecks}`);

  if (totalPassed < totalChecks - 2) {
    process.exit(2);
  }
}

run().catch((err) => {
  console.error('\nAccuracy check crashed:', err?.message || err);
  process.exit(1);
});
