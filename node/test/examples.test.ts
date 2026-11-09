import nodemailer from 'nodemailer';
import { describe, expect, it } from 'vitest';
import { ApprovalRequired, GuardRefused } from '../src/index.js';
import { guardedSendMail } from '../examples/nodemailer.js';
import { fromSesInput, guardedSesSend } from '../examples/ses.js';
import { guardedResendSend } from '../examples/resend.js';
import { guardedAgentiSend, hostedAgentiSend } from '../examples/agentisend.js';
import { sendEmailTool } from '../examples/vercel-ai-tool.js';

describe('examples run against stub transports', () => {
  it('nodemailer: sends through a JSON transport, holds a listed domain', async () => {
    const { sendMail } = guardedSendMail(nodemailer.createTransport({ jsonTransport: true }));
    const info = await sendMail({ from: 'a@yourapp.com', to: 'c@example.com', subject: 'Hi', text: 'x' });
    expect(JSON.parse(String(info.message)).subject).toBe('Hi');
    await expect(sendMail({ from: 'a@yourapp.com', to: 'cto@bigcustomer.com', subject: 'Hi', text: 'x' })).rejects.toBeInstanceOf(ApprovalRequired);
  });

  it('SES: maps the SESv2 input and passes the command to the client', async () => {
    const sent: unknown[] = [];
    const { send } = guardedSesSend({ send: (async (cmd: { input: unknown }) => { sent.push(cmd.input); return { MessageId: 'm1' }; }) as never });
    const input = {
      FromEmailAddress: 'b@yourapp.com',
      Destination: { ToAddresses: ['x@example.com'], CcAddresses: ['y@example.com'] },
      Content: { Simple: { Subject: { Data: 'Invoice' }, Body: { Text: { Data: 'Attached.' } } } },
    };
    expect(fromSesInput(input)).toMatchObject({ to: ['x@example.com'], cc: ['y@example.com'], subject: 'Invoice', text: 'Attached.' });
    await expect(send(input)).resolves.toEqual({ MessageId: 'm1' });
    expect(sent).toHaveLength(1);
  });

  it('Resend: a { error } result is thrown and the budget is given back', async () => {
    let fail = true;
    const stub = { emails: { send: async () => (fail ? { data: null, error: { message: 'domain not verified', name: 'validation_error' } } : { data: { id: 'r1' }, error: null }) } };
    const { send } = guardedResendSend(stub as never);
    const email = { from: 'h@yourapp.com', to: 'n@example.com', subject: 'Welcome', text: 'Hi.' };
    await expect(send(email)).rejects.toThrow(/domain not verified/);
    fail = false;
    await expect(send(email)).resolves.toEqual({ id: 'r1' });
  });

  it('AgentiSend SDK: local guard wraps emails.send; hosted guard calls the API', async () => {
    const { send } = guardedAgentiSend({ emails: { send: async () => ({ id: 'e1' }) } } as never);
    await expect(send({ from: 'a@yourapp.com', to: 'c@example.com', subject: 'Hi', text: 'x' } as never)).resolves.toEqual({ id: 'e1' });
    const hosted = hostedAgentiSend({
      apiKey: 'as_test',
      fetch: (async () => new Response(JSON.stringify({ ok: true, simulated: true, error: null, checks: {} }), { status: 200 })) as unknown as typeof fetch,
    });
    expect((await hosted.check({ from: 'a@yourapp.com', to: 'delivered@simulator.test', subject: 'Hi', text: 'x' })).outcome).toBe('allow');
  });

  it('Vercel AI SDK tool: holds a new recipient, sends once approved by a recorded send, refuses past the ceiling', async () => {
    const delivered: string[] = [];
    const { guard, sendEmail } = sendEmailTool(async (e) => { delivered.push(String(e.to)); return { id: `id${delivered.length}` }; });
    const exec = (input: { to: string; subject: string; text: string }) =>
      (sendEmail.execute as unknown as (i: typeof input, o: unknown) => Promise<{ status: string; reason?: string }>)(input, { toolCallId: 't', messages: [] });
    expect((await exec({ to: 'ana@example.com', subject: 'Refund', text: 'Done.' })).status).toBe('held_for_approval');
    await guard.record({ to: 'ana@example.com' });
    for (let i = 0; i < 5; i++) expect((await exec({ to: 'ana@example.com', subject: `Update ${i}`, text: `Step ${i} of the refund is complete, reference ${i * 977}.` })).status).toBe('sent');
    const sixth = await exec({ to: 'ana@example.com', subject: 'More', text: 'Another distinct message entirely.' });
    expect(sixth).toMatchObject({ status: 'refused', reason: 'rate_ceiling_exceeded' });
    expect(delivered).toHaveLength(5);
    expect(GuardRefused).toBeDefined();
  });
});
