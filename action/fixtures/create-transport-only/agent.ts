import { ChatOpenAI } from '@langchain/core/language_models/chat_models';
import nodemailer from 'nodemailer';

export function go() {
  void ChatOpenAI;
  return nodemailer.createTransport({ jsonTransport: true });
}
