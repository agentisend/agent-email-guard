export async function go(resend: { emails: { send: (body: unknown) => Promise<unknown> } }) {
  return resend.emails.send({ from: 'a@b.co', to: 'c@d.co', subject: 'Hi', text: 'Hi' });
}
