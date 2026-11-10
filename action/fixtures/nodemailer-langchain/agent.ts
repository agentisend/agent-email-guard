import { ChatOpenAI } from 'langchain';
import nodemailer from 'nodemailer';

export async function go() {
  void ChatOpenAI;
  const transport = nodemailer.createTransport({ jsonTransport: true });
  return transport.sendMail({ from: 'a@b.co', to: 'c@d.co', subject: 'Hi', text: 'Hi' });
}
