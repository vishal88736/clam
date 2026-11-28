import type { InboxCalendarEvent, InboxPolicy } from '@siftvane/shared';

export const sandboxClock = '2026-12-07T12:00:00.000Z';
export const sandboxOwner = 'alex@siftvane.example';

export interface ReaderMessage {
  id: string;
  threadId: string;
  from: string;
  replyTo?: string;
  subject: string;
  receivedAt: string;
  text: string;
  html?: string;
  attachmentNames?: string[];
  attachments?: import('../inbox/attachments.js').ReaderAttachment[];
  loadAttachments?: () => Promise<import('../inbox/attachments.js').ReaderAttachment[]>;
  labels: string[];
  sent?: boolean;
  contextOnly?: boolean;
  internetId?: string;
  references?: string[];
  verifiedSender?: boolean;
  failure?: 'parse' | 'timeout';
  redactText?: (text: string) => string;
  threatSignals?: string[];
  headers?: Record<string, string>;
}

export const sandboxPolicy: InboxPolicy = {
  confidenceThreshold: 0.8,
  allowlist: ['sam@team.example', 'priya@team.example'],
  blocklist: [],
  contacts: ['sam@team.example', 'priya@team.example', 'director@partner.example', 'billing@aws.example'],
  vips: ['director@partner.example'],
  outboundBudget: 3, calendarBudget: 6, toolBudget: 100,
};

export const livePolicy: InboxPolicy = { ...sandboxPolicy, allowlist: [], contacts: [], vips: [] };

const message = (id: string, from: string, subject: string, text: string, overrides: Partial<ReaderMessage> = {}): ReaderMessage => ({
  id, threadId: id, from, subject, text, receivedAt: '2026-12-07T11:00:00.000Z', labels: ['INBOX'],
  verifiedSender: true, ...overrides,
});

export const sandboxMessages = [
  message('flight-delay', 'updates@airline.example', 'Flight AC402 delayed',
    'Depart: 2026-12-07T16:45:00Z\nArrive: 2026-12-07T18:40:00Z\nYour flight departure has changed.',
    { threadId: 'trip-siftvane42' }),
  message('meeting-team', 'sam@team.example', 'Meeting request: Demo rehearsal',
    'The previously proposed time works. Can we book our agreed demo rehearsal slot?', { threadId: 'team-rehearsal' }),
  message('meeting-external', 'new@outside.example', 'Meeting request: Intro call',
    'Start: 2026-12-08T20:00:00Z\nDuration: 90\nCan we schedule an intro call?'),
  message('bill-aws', 'billing@aws.example', 'AWS invoice AWS-1207',
    'Vendor: AWS\nInvoice: AWS-1207\nAmount: 42.50 USD\nDue: 2026-12-14\nAccount: aws-original'),
  message('bill-duplicate', 'billing@aws.example', 'AWS invoice AWS-1207 revised',
    'Vendor: AWS\nInvoice: AWS-1207\nAmount: 420.50 USD\nDue: 2026-12-14\nAccount: changed-account',
    { receivedAt: '2026-12-07T11:30:00.000Z' }),
  message('trial-renewal', 'billing@studio.example', 'Studio trial renewal',
    'Vendor: Studio\nInvoice: STUDIO-2026\nAmount: 35.00 USD\nDue: 2026-12-09\nYour subscription trial ends and renews automatically.'),
  message('deadline-a', 'priya@team.example', 'Commitment deadline: Launch handoff',
    'Project: Launch handoff\nDeadline: 2026-12-10'),
  message('deadline-b', 'sam@team.example', 'Commitment deadline: Launch handoff',
    'Project: Launch handoff\nDeadline: 2026-12-11'),
  message('order-confirmed', 'orders@shop.example', 'Order confirmed',
    'Order: ORDER-500\nStatus: confirmed', { receivedAt: '2026-12-03T09:00:00.000Z' }),
  message('order-shipped', 'orders@shop.example', 'Order shipped',
    'Order: ORDER-500\nStatus: shipped', { receivedAt: '2026-12-05T09:00:00.000Z' }),
  message('order-delivered', 'orders@shop.example', 'Order delivered',
    'Order: ORDER-500\nStatus: delivered\nReturn by: 2026-12-21'),
  message('otp-one', 'verification@account.example', 'One-time verification code',
    'Your one-time verification code expires soon.', { receivedAt: '2026-12-07T10:05:00.000Z' }),
  message('otp-two', 'login@service.example', 'Login verification code',
    'This one-time code confirms your sign-in.', { receivedAt: '2026-12-07T11:29:00.000Z' }),
  message('password-alert', 'security@account.example', 'Security alert: password reset',
    'Your password reset was requested. Contact support if this was unexpected.'),
  message('newsletter-design', 'digest@design.example', 'Newsletter: Design weekly',
    'Your design newsletter and weekly digest. Unsubscribe at any time.'),
  message('newsletter-news', 'weekly@updates.example', 'Newsletter: Industry weekly',
    'This newsletter contains our weekly digest.', { replyTo: 'redirect@outside.example' }),
  message('cold-outreach', 'sales@vendor.example', 'Cold outreach: Product demo',
    'Unsolicited sales outreach. Would you like a product demo?'),
  message('stale-nudge', sandboxOwner, 'Commitment deadline: Feedback on launch notes',
    'Project: Launch notes\nWaiting on: priya@team.example\nDeadline: 2026-12-15',
    { threadId: 'launch-notes', sent: true, labels: ['SENT'], receivedAt: '2026-12-04T23:45:00.000Z',
      internetId: '<launch-followup@siftvane.example>' }),
  message('context-one', 'sam@team.example', 'Notes for the rehearsal',
    'Commitment: Share the overview\nProject: Demo overview\nFile: overview.pdf', { threadId: 'figures-notes' }),
  message('context-two', 'sam@team.example', 'Demo figures',
    'Commitment: Confirm figures\nProject: Demo figures\nFile: figures.csv', { threadId: 'figures-confirmation' }),
];

export const sandboxHistory = [
  message('flight-original', 'updates@airline.example', 'Flight AC402 booking confirmation',
    'Booking: SIFTVANE42\nDepart: 2026-12-07T14:20:00Z\nArrive: 2026-12-07T16:15:00Z',
    { threadId: 'trip-siftvane42', labels: ['ARCHIVED'], receivedAt: '2026-12-05T09:00:00.000Z' }),
  message('meeting-original', 'sam@team.example', 'Meeting request: Demo rehearsal',
    'Start: 2026-12-08T10:00:00+01:00\nDuration: 30\nProposed rehearsal slot.',
    { threadId: 'team-rehearsal', labels: ['ARCHIVED'], receivedAt: '2026-12-06T09:00:00.000Z' }),
  message('launch-notes-initial', 'priya@team.example', 'Feedback on launch notes',
    'I can review once you send the launch notes.',
    { threadId: 'launch-notes', labels: ['ARCHIVED'], receivedAt: '2026-12-04T09:00:00.000Z' }),
];

/** Mail the sandbox owner already answered, with their replies: what the behavior profile learns from. */
export const sandboxReplyHistory = [
  message('ask-review', 'priya@team.example', 'Can you review the Q1 deck?', 'Hi Alex, could you look over the Q1 deck before Friday? Mostly the pricing slides.',
    { threadId: 'r-q1-deck', receivedAt: '2026-11-20T09:10:00.000Z' }),
  message('ask-review-re', sandboxOwner, 'Re: Can you review the Q1 deck?', 'Hi Priya,\n\nSure, I will go through it today and send comments on the pricing slides by 5pm.\n\nThanks,\nAlex',
    { threadId: 'r-q1-deck', sent: true, labels: ['SENT'], receivedAt: '2026-11-20T10:02:00.000Z' }),
  message('ask-pricing', 'maya@client.example', 'Question about pricing', 'Hello, what does the team plan cost and is there a discount for yearly billing?',
    { threadId: 'r-pricing', receivedAt: '2026-11-21T14:00:00.000Z' }),
  message('ask-pricing-re', sandboxOwner, 'Re: Question about pricing', 'Hi Maya,\n\nThanks for reaching out! The current plans are on our pricing page. Happy to set up a quick call to find the right fit for your team.\n\nThanks,\nAlex',
    { threadId: 'r-pricing', sent: true, labels: ['SENT'], receivedAt: '2026-11-21T15:30:00.000Z' }),
  message('ask-lunch', 'sam@team.example', 'Lunch Thursday?', 'Free for lunch on Thursday?', { threadId: 'r-lunch', receivedAt: '2026-11-24T08:00:00.000Z' }),
  message('ask-lunch-re', sandboxOwner, 'Re: Lunch Thursday?', 'Hi Sam,\n\nThursday works. 1pm?\n\nThanks,\nAlex',
    { threadId: 'r-lunch', sent: true, labels: ['SENT'], receivedAt: '2026-11-24T08:20:00.000Z' }),
  message('ask-delay', 'jordan@client.example', 'My order is delayed', 'My order #4471 was due yesterday and has not arrived. What is going on?',
    { threadId: 'r-delay', receivedAt: '2026-11-25T11:00:00.000Z' }),
  message('ask-delay-re', sandboxOwner, 'Re: My order is delayed', 'Hi Jordan,\n\nSorry about the delay. I checked with our shipping team and it goes out tomorrow; I will send the tracking link as soon as I have it.\n\nThanks,\nAlex',
    { threadId: 'r-delay', sent: true, labels: ['SENT'], receivedAt: '2026-11-25T11:40:00.000Z' }),
  message('ask-partner', 'director@partner.example', 'Partnership next steps', 'Great call yesterday. Can we set up time to go over next steps?',
    { threadId: 'r-partner', receivedAt: '2026-11-26T16:00:00.000Z' }),
  message('ask-partner-re', sandboxOwner, 'Re: Partnership next steps', 'Hi Dana,\n\nGlad it was useful. Let us find 30 minutes next week; Tuesday or Wednesday afternoon works for me.\n\nThanks,\nAlex',
    { threadId: 'r-partner', sent: true, labels: ['SENT'], receivedAt: '2026-11-26T17:05:00.000Z' }),
];

const event = (id: string, title: string, start: string, end: string, options: Partial<InboxCalendarEvent> = {}): InboxCalendarEvent => ({
  id, title, start, end, kind: 'meeting', guests: [], flexible: false, ...options,
});

export const sandboxEvents = [
  event('flight-siftvane42', 'Flight AC402', '2026-12-07T14:20:00Z', '2026-12-07T16:15:00Z',
    { kind: 'flight' }),
  event('focus-flexible', 'Solo focus block', '2026-12-07T16:30:00Z', '2026-12-07T17:00:00Z',
    { kind: 'focus', flexible: true }),
  event('vip-review', 'Partner review', '2026-12-07T17:00:00Z', '2026-12-07T17:30:00Z',
    { guests: ['director@partner.example'] }),
  event('solo-planning', 'Planning', '2026-12-07T13:00:00Z', '2026-12-07T13:30:00Z', { kind: 'focus' }),
  event('team-next', 'Team check-in', '2026-12-07T17:45:00Z', '2026-12-07T18:00:00Z', { guests: ['sam@team.example'] }),
  event('deep-work', 'Deep work', '2026-12-08T13:00:00Z', '2026-12-08T15:00:00Z', { kind: 'focus' }),
  event('workflow', 'Workflow review', '2026-12-09T10:00:00Z', '2026-12-09T10:30:00Z'),
  event('wrapup', 'Wrap-up', '2026-12-11T16:00:00Z', '2026-12-11T16:30:00Z'),
];

/* ------------------------------------------------------------------------------------------------
 * $0 Workspace sandbox fixtures: daily invoices (with PDF attachments), a recurring SaaS bill,
 * a spoofed duplicate invoice, vendor quote replies (one carrying a spreadsheet formula injection),
 * and receipt photos for the SandboxWorkspaceAdapter Photos library.
 * ---------------------------------------------------------------------------------------------- */

/** Builds a minimal single-page PDF whose text layer pdftotext can read. */
export function fixturePdf(lines: string[]) {
  const escape = (line: string) => line.replace(/[\\()]/g, (char) => '\\' + char);
  const content = 'BT /F1 11 Tf 24 260 Td ' + lines.map((line, index) =>
    (index ? '0 -16 Td ' : '') + '(' + escape(line) + ') Tj').join(' ') + ' ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 520 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream',
  ];
  let body = '%PDF-1.4\n';
  const entries = ['0000000000 65535 f '];
  for (const [index, object] of objects.entries()) {
    entries.push(String(body.length).padStart(10, '0') + ' 00000 n ');
    body += (index + 1) + ' 0 obj\n' + object + '\nendobj\n';
  }
  const xref = body.length;
  body += 'xref\n0 6\n' + entries.join('\n') + '\ntrailer\n<< /Root 1 0 R /Size 6 >>\nstartxref\n' + xref + '\n%%EOF\n';
  return Buffer.from(body).toString('base64url');
}

const pdfPart = (name: string, lines: string[]) => ({ name, mime: 'application/pdf', data: fixturePdf(lines) });

export const workspaceMessages: ReaderMessage[] = [
  message('ws-invoice-figma', 'billing@figma.example', 'Invoice FIG-3391 for December',
    'Vendor: Figma\nInvoice: FIG-3391\nAmount: 45.00 USD\nDue: 2026-12-20\nThe invoice PDF is attached.',
    { receivedAt: '2026-12-07T08:10:00.000Z', attachments: [pdfPart('invoice-FIG-3391.pdf',
      ['Figma Inc. - Invoice FIG-3391', 'Vendor: Figma', 'Invoice: FIG-3391', 'Amount: 45.00 USD', 'Due: 2026-12-20'])] }),
  message('ws-invoice-printco', 'accounts@printco.example', 'Daily invoice PC-1207',
    'Vendor: PrintCo\nInvoice: PC-1207\nAmount: 318.40 USD\nDue: 2026-12-17\nThanks for your business.',
    { receivedAt: '2026-12-07T09:25:00.000Z', attachments: [pdfPart('invoice-PC-1207.pdf',
      ['PrintCo Daily Invoice', 'Vendor: PrintCo', 'Invoice: PC-1207', 'Amount: 318.40 USD', 'Due: 2026-12-17'])] }),
  message('ws-bill-saas', 'billing@notion-saas.example', 'Your monthly subscription receipt',
    'Vendor: Notion SaaS\nInvoice: NS-2026-12\nAmount: 16.00 USD\nDue: 2026-12-15\nRecurring: monthly\nThis recurring bill renews automatically.',
    { receivedAt: '2026-12-07T06:00:00.000Z' }),
  message('ws-invoice-spoof', 'billing@figma-payments.example', 'Invoice FIG-3391 - updated bank details',
    'Vendor: Figma\nInvoice: FIG-3391\nAmount: 4500.00 USD\nDue: 2026-12-09\nPlease pay to our new bank account immediately.',
    { receivedAt: '2026-12-07T10:40:00.000Z', verifiedSender: false }),
];

export interface SandboxPhoto {
  id: string;
  filename: string;
  mimeType: string;
  category: 'RECEIPTS' | 'DOCUMENTS' | 'SCREENSHOTS';
  creationTime: string;
  description: string;
  data: string;
}

const receiptSvg = (lines: string[]) => Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="' + (40 + lines.length * 22) + '">' +
  '<rect width="100%" height="100%" fill="#fffdf5"/>' +
  lines.map((line, index) => '<text x="16" y="' + (30 + index * 22) + '" font-family="monospace" font-size="14">' +
    line.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</text>').join('') + '</svg>',
).toString('base64url');

export const sandboxPhotos: SandboxPhoto[] = [
  { id: 'photo-receipt-cafe', filename: 'IMG_2041.svg', mimeType: 'image/svg+xml', category: 'RECEIPTS',
    creationTime: '2026-12-05T18:22:00.000Z', description: 'Team dinner receipt',
    data: receiptSvg(['Merchant: Harbor Cafe', 'Date: 2026-12-05', 'Total: 86.40 USD', 'Card: **** 4242']) },
  { id: 'photo-ticket-parking', filename: 'IMG_2057.svg', mimeType: 'image/svg+xml', category: 'RECEIPTS',
    creationTime: '2026-12-06T09:03:00.000Z', description: 'Parking citation',
    data: receiptSvg(['Merchant: City Parking Authority', 'Ticket: PK-55821', 'Date: 2026-12-06', 'Total: 32.00 USD', 'Pay by: 2026-12-20']) },
];

/* ----------------------------------------------------------------------------------------------
 * $0 The sandbox user's own Drive: files that already existed before Siftvane (agents may find and read them).
 * Keys use the shared "drive/" namespace; agents never write here (their artifacts live in per-user namespaces).
 * ---------------------------------------------------------------------------------------------- */
export const sandboxDriveFiles: Array<{ key: string; state: Record<string, unknown>; blob?: { mime: string; data: Buffer } }> = [
  { key: 'drive/doc:Q1 Marketing Plan', state: { type: 'google_doc', title: 'Q1 Marketing Plan', folder: null, modified: '2026-11-30T10:00:00.000Z', sections: [
    { heading: 'Goals', text: 'Grow trial signups 25% and launch the partner webinar series by February 14, 2027.' },
    { heading: 'Budget', text: 'Total marketing budget is $18,000: ads $9,000, events $6,000, content $3,000.' },
    { heading: 'Owners', text: 'Priya owns ads (priya@team.example). Sam owns the webinar (sam@team.example).' },
  ] } },
  { key: 'drive/sheet:Vendor Contacts', state: { type: 'google_sheet', title: 'Vendor Contacts', folder: null, modified: '2026-11-21T09:00:00.000Z', tabs: [
    { name: 'Vendors', headers: ['Vendor', 'Contact', 'Email', 'Category', 'Payment terms'], rows: [
      ['PrintCo', 'Dana Reyes', 'accounts@printco.example', 'Printing', 'Net 30'],
      ['Acme Cloud', 'Lee Park', 'billing@acme-cloud.example', 'Hosting', 'Net 15'],
      ['Northwind Design', 'Ava Chen', 'accounts@northwind-design.example', 'Design', 'Net 30'],
    ] },
  ] } },
  { key: 'drive/sheet:Team Budget 2027', state: { type: 'google_sheet', title: 'Team Budget 2027', folder: null, modified: '2026-12-01T08:00:00.000Z', tabs: [
    { name: 'Budget', headers: ['Category', 'Budget', 'Spent'], rows: [['Software', 6000, 4210], ['Hosting', 9000, 7900], ['Design', 5000, 5350], ['Travel', 4000, 1200]] },
  ] } },
  { key: 'drive/file:Contracts/Northwind - signed contract.pdf', state: { type: 'drive_file', name: 'Northwind - signed contract.pdf', folder: null, mime: 'application/pdf',
    bytes: 0, md5: '', modified: '2026-10-02T12:00:00.000Z' },
    blob: { mime: 'application/pdf', data: Buffer.from(fixturePdf(['Services agreement: Northwind Design Studio', 'Contract value: $12,000 per year',
      'Renewal date: 2027-03-01', 'Notice period: 30 days before renewal']), 'base64url') } },
  { key: 'drive/file:Notes/standup-notes.txt', state: { type: 'drive_file', name: 'standup-notes.txt', folder: null, mime: 'text/plain', bytes: 0, md5: '',
    modified: '2026-12-06T09:30:00.000Z' },
    blob: { mime: 'text/plain', data: Buffer.from('Standup Dec 6\n- Sam: demo rehearsal moved to Thursday\n- Priya: launch handoff blocked on legal review, due Dec 10\n- Action: renew Northwind contract before March\n') } },
];

/** Mail delivered to the sandbox agent Pod: each message belongs to the agent inbox it was addressed to. */
export const podMessages = [{
  id: 'vendor-credit-case', threadId: 'vendor-credit-thread', toInbox: 'triage', from: 'billing@northstar.example',
  subject: 'Northstar credit memo needs review', receivedAt: '2026-12-07T10:45:00.000Z', labels: ['INBOX'], verifiedSender: true,
  text: 'Our credit memo for invoice NS-482 is attached. Can you confirm the line item before we post it?',
  attachmentIds: ['credit-memo-csv'],
  attachments: [{ name: 'credit-memo.csv', mime: 'text/csv',
    data: Buffer.from('invoice,item,currency,credit\nNS-482,Duplicate shipping charge,USD,18.00\n').toString('base64url') }],
}];
