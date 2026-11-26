import type { ReaderAttachment } from '../inbox/attachments.js';

export const podCase = {
  messageId: 'vendor-credit-case',
  threadId: 'vendor-credit-thread',
  sender: 'billing@northstar.example',
  receivedAt: '2026-12-07T10:45:00.000Z',
  subject: 'Northstar credit memo needs review',
  text: 'Our credit memo for invoice NS-482 is attached. Can you confirm the line item before we post it?',
  attachmentId: 'credit-memo-csv',
  attachment: {
    name: 'credit-memo.csv', mime: 'text/csv',
    data: Buffer.from('invoice,item,currency,credit\nNS-482,Duplicate shipping charge,USD,18.00\n').toString('base64url'),
  } satisfies ReaderAttachment,
};

export const isPodCaseThread = (threadId: string) => threadId === podCase.threadId ||
  new RegExp('^' + podCase.threadId + '-[a-f0-9]{8}$').test(threadId);
