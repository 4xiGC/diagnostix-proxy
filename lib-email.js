// ═════════════════════════════════════════════════════════════════════════════
// Customer email builders. PURE: no I/O, no env, no clock.
//
// WHY THESE MOVED OUT OF server.js (v8.11.35).
//
// Importing server.js starts a listener, so no test had ever seen a finished
// email. Every assertion about customer copy was therefore made against a
// template read as source, or against a helper that produced one line of it.
// "The HTML contains exactly one anchor carrying the signed link" is a claim
// about the assembled email or it is not the claim being made.
//
// Nothing about the emails changed in the move itself. The templates are the
// same bytes, with two exceptions that are the point of the release: the swap
// and recovery links are buttons, and baseUrl arrives as an argument instead
// of being read from process.env, which is what makes these pure.
// ═════════════════════════════════════════════════════════════════════════════

import {
  deliveryProvenanceLines, swapLinkSentence, renderEmailButton, buttonPlainText,
  SWAP_BUTTON_LABEL, RECOVERY_BUTTON_LABEL, BUTTON_FALLBACK_LINE,
} from './lib-pending.js';

export function buildCustomerReportEmail(argsIn) {
  const args = (argsIn && typeof argsIn === 'object') ? argsIn : {};
  const { subscriber = {}, report = {}, reportNumber = 1, survey = {}, provenance, swapUrl } = args;
  const baseUrl = args.baseUrl || 'https://diagnostix-proxy-production.up.railway.app';

  // Subscriber object can arrive in two shapes (Supabase snake_case vs in-memory camelCase).
  // Read each field with a fallback so the email works in both flows.
  const subField = (snake, camel) => subscriber[snake] !== undefined ? subscriber[snake] : subscriber[camel];
  const reportTokenSafe = subField('report_token', 'reportToken') || '';
  const restaurantNameSafe = subField('restaurant_name', 'restaurantName') || 'your restaurant';
  const firstNameSafe = subField('first_name', 'firstName') || 'there';
  const planTypeSafe = subField('plan_type', 'planType') || '';

  const link = baseUrl + '/report?token=' + reportTokenSafe;
  const score = report?.healthCheckScore ?? 0;
  const verdict = report?.scoreVerdict || '';
  const restaurant = restaurantNameSafe;
  const firstName = firstNameSafe;
  const isOneOff = planTypeSafe === 'one_off';

  let subject, headline, intro;
  if (isOneOff) {
    subject = `Your DiagnostiX Full Report is ready: ${restaurant}`;
    headline = 'Your DiagnostiX Full Report is ready';
    intro = 'Thank you for purchasing the DiagnostiX Full Report. Your full HealthCheck is now permanently available at the link below. Bookmark it for future reference. If you would like ongoing progress tracking, DiagnostiX Annual gives you two additional reports, at the 4-month and 8-month marks, to measure what is changing year over year.';
  } else if (reportNumber === 1) {
    subject = `Welcome to DiagnostiX Annual: your baseline report for ${restaurant}`;
    headline = 'Your DiagnostiX baseline is ready';
    intro = 'Thank you for subscribing to DiagnostiX Annual. Your baseline report is now stored and ready to view anytime over the next 12 months. Your Annual plan includes two further progress reports. Report 2 arrives automatically 4 months from today, and Report 3 arrives at the 8-month mark. At the 12-month anniversary you will receive a reminder with the option to renew for another year.';
  } else if (reportNumber === 2) {
    subject = `Your DiagnostiX Report 2 is ready: ${restaurant}`;
    headline = 'Your Month 4 progress report is ready';
    intro = 'Four months on from your baseline, your second DiagnostiX report is ready. The link below shows your latest scores side-by-side with your baseline so you can see exactly what is moving. Your final report of the year will arrive at the 8-month mark.';
  } else {
    subject = `Your DiagnostiX Report 3 is ready: ${restaurant}`;
    headline = 'Your Month 8 progress report is ready';
    intro = 'Eight months on from your baseline, your third DiagnostiX report is ready. Inside you will find a year-to-date comparison across all three reports for every pillar. At the 12-month anniversary of your subscription, you will receive a reminder with the option to renew DiagnostiX Annual for another year of progress tracking.';
  }

  // v8.11.30: WHICH SURVEY THIS REPORT ANSWERS, stated before anything else
  // the buyer has to read. The sentences are built by deliveryProvenanceLines
  // in lib-pending.js, where they are unit tested as strings, so the copy
  // cannot drift inside an HTML template nobody renders in a test.
  const provLines = deliveryProvenanceLines(provenance || {
    restaurantName: restaurant,
    surveySavedAt: (survey && survey.savedAt) || null,
  });

  // v8.11.31: ONE SWAP PER ORDER, offered to everybody who paid on a call we
  // could authenticate. swapUrl is null when the webhook secret was absent or
  // wrong, and an empty string here means the sentence is simply not rendered:
  // an unauthenticated call must not be handed a signed link.
  const swapLine = swapLinkSentence(swapUrl);

  // Score color matches the survey banding (green ≥65, amber ≥45, red <45)
  const scoreColor = score >= 65 ? '#00A651' : score >= 45 ? '#F7941D' : '#ED1C24';
  const escE = (s) => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const html = `<!doctype html><html><head><meta charset="utf-8">
<title>${escE(subject)}</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=League+Spartan:wght@300;400;500;700;900&display=swap');
</style>
</head>
<body style="margin:0;padding:0;background:#F5F4FC;font-family:'League Spartan',-apple-system,Segoe UI,Arial,sans-serif;color:#1B1464;-webkit-font-smoothing:antialiased">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#F5F4FC">
<tr><td align="center" style="padding:24px 12px">

  <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;width:100%">

    <!-- Purple gradient header -->
    <tr><td style="background:#1B1464;background-image:linear-gradient(135deg,#92278F,#2E3192,#1B1464);border-radius:14px 14px 0 0;padding:32px 32px 28px">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
        <tr><td>
          <div style="font-family:'League Spartan',Arial,sans-serif;font-weight:900;letter-spacing:1px;color:#ffffff;font-size:22px;line-height:1">diagnosti<span style="color:#0072BC">X</span></div>
          <div style="font-family:'League Spartan',Arial,sans-serif;font-size:10px;letter-spacing:2px;color:rgba(255,255,255,.75);text-transform:uppercase;margin-top:4px;font-weight:500">Restaurant HealthCheck · by 4xi</div>
        </td></tr>
        <tr><td style="padding-top:28px">
          <div style="font-family:'League Spartan',Arial,sans-serif;font-size:10px;letter-spacing:3px;color:rgba(255,255,255,.7);text-transform:uppercase;font-weight:700">Performance Intelligence Report</div>
          <div style="font-family:'League Spartan',Arial,sans-serif;color:#ffffff;font-size:26px;font-weight:900;line-height:1.2;margin-top:6px">${escE(restaurant)}</div>
        </td></tr>
      </table>
    </td></tr>

    <!-- Gold/blue gradient divider -->
    <tr><td style="height:4px;background:#0072BC;background-image:linear-gradient(90deg,#92278F,#0072BC);font-size:0;line-height:0">&nbsp;</td></tr>

    <!-- White content body -->
    <tr><td style="background:#ffffff;padding:32px;border-radius:0 0 14px 14px">

      <div style="font-family:'League Spartan',Arial,sans-serif;font-size:20px;font-weight:900;color:#1B1464;margin:0 0 14px;line-height:1.25">${escE(headline)}</div>
      <p style="font-family:'League Spartan',Arial,sans-serif;font-size:14px;line-height:1.65;color:#444;margin:0 0 14px;font-weight:400">Hi ${escE(firstName)}, ${escE(intro)}</p>
      <div style="font-family:'League Spartan',Arial,sans-serif;font-size:14px;line-height:1.65;color:#1B1464;margin:0 0 24px;padding:14px 16px;background:#F5F4FC;border-left:4px solid #0072BC;border-radius:6px;font-weight:500">${provLines.map(l => '<div style="margin:0 0 6px">' + escE(l) + '</div>').join('')}${swapLine ? '<div style="margin:12px 0 0;font-weight:400;color:#444;font-size:13px">' + escE(swapLine) + '</div>' + renderEmailButton({ url: swapUrl, label: SWAP_BUTTON_LABEL }) : ''}</div>

      <!-- Score block -->
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#F5F4FC;border-radius:10px;margin:0 0 28px">
        <tr><td align="center" style="padding:22px 18px">
          <div style="font-family:'League Spartan',Arial,sans-serif;font-size:10px;letter-spacing:2px;color:#1B1464;text-transform:uppercase;font-weight:700;opacity:.7">Overall HealthCheck Score</div>
          <div style="font-family:'League Spartan',Arial,sans-serif;font-size:54px;font-weight:900;color:${scoreColor};line-height:1;margin:10px 0 4px">${score}<span style="font-size:20px;color:#999;font-weight:500">/100</span></div>
          <div style="font-family:'League Spartan',Arial,sans-serif;font-size:13px;color:#1B1464;font-weight:700;letter-spacing:1px;text-transform:uppercase">${escE(verdict)}</div>
        </td></tr>
      </table>

      <!-- CTA button -->
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
        <tr><td align="center" style="padding:0 0 8px">
          <a href="${link}" style="display:inline-block;background:#1B1464;background-image:linear-gradient(135deg,#92278F,#2E3192,#1B1464);color:#ffffff;text-decoration:none;padding:16px 36px;border-radius:8px;font-family:'League Spartan',Arial,sans-serif;font-weight:900;font-size:14px;letter-spacing:1.5px;text-transform:uppercase;mso-padding-alt:0">View Your Full Report &rarr;</a>
        </td></tr>
      </table>

      <p style="font-family:'League Spartan',Arial,sans-serif;font-size:12px;color:#999;line-height:1.6;margin:28px 0 0;text-align:center">Or paste this link into your browser:<br><span style="color:#1B1464;word-break:break-all;font-weight:500">${link}</span></p>

    </td></tr>
  </table>

  <!-- Footer -->
  <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;width:100%;margin-top:8px">
    <tr><td align="center" style="padding:20px 24px;font-family:'League Spartan',Arial,sans-serif;font-size:11px;color:#999;line-height:1.6;letter-spacing:.5px">
      <div style="font-weight:900;color:#1B1464;letter-spacing:1px;text-transform:uppercase;font-size:10px">DiagnostiX by 4xi</div>
      <div style="margin-top:4px">24/7 · 365 Intelligence Platform</div>
      <div style="margin-top:10px;opacity:.8">This link is private to you. Keep it safe.</div>
    </td></tr>
  </table>

</td></tr></table>
</body></html>`;
  return { subject, html, text: swapUrl
    ? buttonPlainText({ sentence: swapLine, label: SWAP_BUTTON_LABEL, url: swapUrl })
    : '' };
}

// The "we could not locate your report" email. The recovery link here is the
// same signed link, gated the same way, and it becomes a button for the same
// reasons. With no link configured the email reads exactly as it did before,
// which is what lets this deploy ahead of the secret being set.
export function buildCacheMissEmail(argsIn) {
  const args = (argsIn && typeof argsIn === 'object') ? argsIn : {};
  const { firstName, restaurantName, recoverUrl, internalTo = 'hello@4xiconsulting.com' } = args;
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const who = restaurantName ? ' for ' + esc(restaurantName) : '';

  const recoverBlock = recoverUrl
    ? '<div style="background:#eaf6f1;border-left:4px solid #0b6b57;padding:12px 14px;border-radius:4px;">'
      + '<p style="margin:0 0 4px"><strong>You can fix this yourself in one step.</strong><br>'
      + 'If the email on your payment is not the one you typed into the survey, '
      + 'use the button below and we will send the report straight away. '
      + 'The link works for 14 days.</p>'
      + renderEmailButton({ url: recoverUrl, label: RECOVERY_BUTTON_LABEL })
      + '</div>'
    : '';

  const html = '<p>Hello' + (firstName ? ' ' + esc(firstName) : '') + ',</p>'
    + '<p>Your payment went through, and we could not locate the HealthCheck report' + who
    + ' to attach to it. This usually means the email on your payment is different from '
    + 'the one you used in the survey.</p>'
    + recoverBlock
    + '<p>Or reply to this email or write to '
    + '<a href="mailto:' + esc(internalTo) + '">' + esc(internalTo) + '</a> and we will put it right. '
    + 'Your payment is recorded, so nothing is lost either way.</p>'
    + '<p>DiagnostiX, 4xi Global Consulting</p>';

  return {
    subject: 'We could not locate your DiagnostiX report',
    html,
    text: recoverUrl
      ? buttonPlainText({
          sentence: 'If the email on your payment is not the one you typed into the survey, '
            + 'use the link below and we will send the report straight away. '
            + 'The link works for 14 days.',
          label: RECOVERY_BUTTON_LABEL, url: recoverUrl })
      : '',
  };
}
