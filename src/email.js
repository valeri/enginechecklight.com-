// Sign-in emails through Resend (https://resend.com). Needs RESEND_API_KEY and a verified sender
// domain (EMAIL_FROM, e.g. "EngineCheckLight <login@enginechecklight.com>").

const COPY = {
  en: {
    subject: 'Your EngineCheckLight sign-in link',
    title: 'Sign in to EngineCheckLight',
    body: 'Tap the button to sign in. The link works once and expires in 15 minutes.',
    button: 'Sign in',
    ignore: "If you didn't ask for this, you can ignore this email.",
  },
  ka: {
    subject: 'EngineCheckLight — შესვლის ბმული',
    title: 'შესვლა EngineCheckLight-ში',
    body: 'შესასვლელად დააჭირე ღილაკს. ბმული ერთხელ მუშაობს და 15 წუთში იწურება.',
    button: 'შესვლა',
    ignore: 'თუ ეს შენ არ მოგითხოვია, უბრალოდ უგულებელყავი ეს წერილი.',
  },
};

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function loginEmail(link, lang = 'en') {
  const t = COPY[lang] ?? COPY.en;
  const html = `<!doctype html><html><body style="margin:0;background:#eef0ef;font-family:Arial,sans-serif;color:#1c2023">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" style="max-width:440px;background:#ffffff;border-radius:14px" cellpadding="0" cellspacing="0"><tr><td style="padding:28px">
<div style="font-size:22px;font-weight:bold">Engine<span style="color:#d9480f">CheckLight</span></div>
<h1 style="font-size:20px;margin:20px 0 8px">${esc(t.title)}</h1>
<p style="font-size:15px;line-height:1.5;margin:0 0 20px">${esc(t.body)}</p>
<a href="${esc(link)}" style="display:inline-block;background:#d9480f;color:#ffffff;text-decoration:none;font-weight:bold;padding:13px 22px;border-radius:12px">${esc(t.button)}</a>
<p style="font-size:12px;color:#5d666b;margin:24px 0 0">${esc(t.ignore)}</p>
</td></tr></table></td></tr></table></body></html>`;
  const text = `${t.title}\n\n${t.body}\n\n${link}\n\n${t.ignore}`;
  return { subject: t.subject, html, text };
}

export function createEmailSender({ apiKey, from, fetchImpl = fetch } = {}) {
  if (!apiKey || !from) return null; // not configured: the app turns sign-in off
  return async function send({ to, subject, html, text }) {
    const res = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject, html, text }),
    });
    if (!res.ok) throw new Error(`email send failed: ${res.status} ${await res.text().catch(() => '')}`);
    return res.json();
  };
}
