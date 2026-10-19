const escape = (value: string) => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Inline styles and presentation tables work in Gmail, Apple Mail and Outlook. All user content is escaped. */
export function shareEmailHtml(input: {
  from: string;
  title: string;
  message: string;
  url: string;
  origin: string;
  expiresAt: Date | null;
  password: boolean;
  reminder: boolean;
}) {
  const e = escape;
  const heading = input.reminder ? 'Your files expire soon' : 'You have files to download';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${heading}</title></head>
<body style="margin:0;padding:0;background:#f3f6fb;color:#10213b;font-family:Arial,Helvetica,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 12px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="width:100%;max-width:560px;background:#ffffff;border:1px solid #dce4ef;border-radius:16px">
<tr><td style="padding:28px 28px 24px;background:#082451;border-radius:16px 16px 0 0"><a href="${e(input.origin)}" style="color:#ffffff;text-decoration:none;font-size:24px;font-weight:bold">Rokela <span style="color:#ff655b">PDF</span></a></td></tr>
<tr><td style="padding:28px">
<h1 style="margin:0 0 16px;font-size:26px;line-height:34px">${heading}</h1>
<p style="margin:0 0 24px;font-size:15px;line-height:24px;color:#53647c">${e(input.from)} shared files with you.</p>
<h2 style="margin:0 0 16px;font-size:21px;line-height:28px;overflow-wrap:anywhere">${e(input.title)}</h2>
${input.message ? `<div style="padding:18px;margin:0 0 24px;background:#f3f6fb;border-left:4px solid #ff655b;font-size:16px;line-height:25px;overflow-wrap:anywhere">${e(input.message).replace(/\r\n|\r|\n/g, '<br>')}</div>` : ''}
<table role="presentation" cellpadding="0" cellspacing="0"><tr><td bgcolor="#173f78" style="border-radius:8px"><a href="${e(input.url)}" style="display:inline-block;padding:16px 26px;border:1px solid #173f78;border-radius:8px;color:#ffffff;font-size:16px;font-weight:bold;text-decoration:none">View and download files</a></td></tr></table>
${input.expiresAt ? `<p style="margin:20px 0 0;font-size:14px;line-height:22px;color:#53647c">Available until ${e(input.expiresAt.toUTCString())}.</p>` : ''}
${input.password ? '<p style="font-size:14px;line-height:22px;color:#53647c">This transfer is password protected. Ask the sender for the password.</p>' : ''}
<p style="margin:24px 0 0;font-size:14px;line-height:22px;color:#53647c">Reply to this email to contact the sender.</p>
<p style="margin:24px 0 0;font-size:12px;line-height:19px;color:#53647c">Button not working? Copy this link into your browser:<br><a href="${e(input.url)}" style="color:#173f78;word-break:break-all">${e(input.url)}</a></p>
</td></tr>
<tr><td style="padding:20px 28px;border-top:1px solid #dce4ef;font-size:12px;line-height:19px;color:#53647c">You received this because ${e(input.from)} shared files with your address. If unexpected, ignore this email or <a href="${e(input.origin)}/report" style="color:#173f78">report it</a>.</td></tr>
</table></td></tr></table></body></html>`;
}
