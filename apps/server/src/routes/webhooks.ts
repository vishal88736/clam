import type { FastifyInstance } from 'fastify';
import {
  answerTelegramCallback,
  verifySlackSignature,
  verifyWhatsAppSignature,
} from '../approvals/channels.js';
import type { ApprovalService } from '../approvals/service.js';

export function registerWebhookRoutes(
  app: FastifyInstance,
  approvalService: ApprovalService
): void {
  // Encapsulate raw body preservation strictly for webhook signature verification
  app.register(async function webhookScope(scoped) {
    scoped.removeContentTypeParser('application/json');
    scoped.addContentTypeParser(
      'application/json',
      { parseAs: 'string' },
      (req, body, done) => {
        (req as unknown as { rawBodyString?: string }).rawBodyString = body as string;
        try {
          done(null, JSON.parse(body as string));
        } catch (err) {
          done(err as Error, undefined);
        }
      }
    );
    scoped.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (req, body, done) => {
        (req as unknown as { rawBodyString?: string }).rawBodyString = body as string;
        const params = new URLSearchParams(body as string);
        done(null, Object.fromEntries(params.entries()));
      }
    );

    // Slack Block Kit interactive action webhook
    scoped.post('/webhooks/slack', async (request, reply) => {
      const rawBody = (request as unknown as { rawBodyString?: string }).rawBodyString ?? '';
      const channels = await approvalService.getChannelConfigs();

      if (channels.slack.signingSecret) {
        const valid = verifySlackSignature({
          signingSecret: channels.slack.signingSecret,
          rawBody,
          timestampHeader: request.headers['x-slack-request-timestamp'] as string | undefined,
          signatureHeader: request.headers['x-slack-signature'] as string | undefined,
        });
        if (!valid) {
          return reply.code(401).send({ error: 'Invalid Slack signature' });
        }
      }

      const body = request.body as { payload?: string } | { actions?: { action_id?: string; value?: string }[] };
      const parsedPayload =
        'payload' in body && typeof body.payload === 'string'
          ? (JSON.parse(body.payload) as {
              actions?: { action_id?: string; value?: string }[];
            })
          : (body as { actions?: { action_id?: string; value?: string }[] });

      const action = parsedPayload.actions?.[0];
      if (!action?.value) {
        return reply.code(400).send({ error: 'Missing Slack action payload' });
      }

      const resolution = action.action_id === 'siftvane_approve' || action.action_id === 'clam_approve' ? 'APPROVED' : 'REJECTED';
      try {
        const outcome = await approvalService.resolveApproval({
          id: action.value,
          resolution,
          channel: 'slack',
        });
        return {
          replace_original: true,
          text: `Siftvane HITL ${resolution} via Slack (Approval ${outcome.approval.id}). Ephemeral payload wiped.`,
        };
      } catch (err) {
        return reply.code(400).send({
          text: err instanceof Error ? err.message : 'Unable to resolve approval',
        });
      }
    });

    // Telegram Bot API webhook callback_query handler
    scoped.post('/webhooks/telegram', async (request, reply) => {
      const channels = await approvalService.getChannelConfigs();
      if (channels.telegram.webhookSecret) {
        const hdr = request.headers['x-telegram-bot-api-secret-token'];
        if (hdr !== channels.telegram.webhookSecret) {
          return reply.code(401).send({ error: 'Invalid Telegram secret token' });
        }
      }

      const body = request.body as {
        callback_query?: {
          id?: string;
          data?: string;
        };
      };

      const data = body.callback_query?.data;
      if (!data) {
        return { ok: true, ignored: true };
      }

      const [verb, approvalId] = data.split(':');
      if (!approvalId || (verb !== 'approve' && verb !== 'deny')) {
        return reply.code(400).send({ error: 'Invalid Telegram callback_data' });
      }

      const resolution = verb === 'approve' ? 'APPROVED' : 'REJECTED';
      try {
        await approvalService.resolveApproval({
          id: approvalId,
          resolution,
          channel: 'telegram',
        });
        if (body.callback_query?.id) {
          await answerTelegramCallback(
            channels.telegram,
            body.callback_query.id,
            `Siftvane ${resolution}`
          );
        }
        return { ok: true, status: resolution, approval_id: approvalId };
      } catch (err) {
        return reply.code(400).send({
          error: err instanceof Error ? err.message : 'Unable to resolve approval',
        });
      }
    });

    // WhatsApp Cloud API verification challenge
    scoped.get('/webhooks/whatsapp', async (request, reply) => {
      const q = request.query as {
        'hub.mode'?: string;
        'hub.verify_token'?: string;
        'hub.challenge'?: string;
      };
      const channels = await approvalService.getChannelConfigs();
      if (
        q['hub.mode'] === 'subscribe' &&
        channels.whatsapp.verifyToken &&
        q['hub.verify_token'] === channels.whatsapp.verifyToken
      ) {
        return reply.type('text/plain').send(q['hub.challenge'] ?? '');
      }
      return reply.code(403).send({ error: 'WhatsApp verification failed' });
    });

    // WhatsApp interactive reply button webhook
    scoped.post('/webhooks/whatsapp', async (request, reply) => {
      const rawBody = (request as unknown as { rawBodyString?: string }).rawBodyString ?? '';
      const channels = await approvalService.getChannelConfigs();

      if (channels.whatsapp.appSecret) {
        const sig = request.headers['x-hub-signature-256'] as string | undefined;
        if (!verifyWhatsAppSignature(channels.whatsapp.appSecret, rawBody, sig)) {
          return reply.code(401).send({ error: 'Invalid WhatsApp HMAC signature' });
        }
      }

      const body = request.body as {
        entry?: {
          changes?: {
            value?: {
              messages?: {
                interactive?: { button_reply?: { id?: string } };
              }[];
            };
          }[];
        }[];
      };

      const replyId =
        body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.interactive?.button_reply?.id;
      if (!replyId) {
        return { ok: true, ignored: true };
      }

      const [verb, approvalId] = replyId.split(':');
      if (!approvalId || (verb !== 'approve' && verb !== 'deny')) {
        return reply.code(400).send({ error: 'Invalid WhatsApp interactive reply id' });
      }

      const resolution = verb === 'approve' ? 'APPROVED' : 'REJECTED';
      try {
        await approvalService.resolveApproval({
          id: approvalId,
          resolution,
          channel: 'whatsapp',
        });
        return { ok: true, status: resolution, approval_id: approvalId };
      } catch (err) {
        return reply.code(400).send({
          error: err instanceof Error ? err.message : 'Unable to resolve approval',
        });
      }
    });
  });
}
