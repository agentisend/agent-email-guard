import { z } from "zod";

export const emailInputSchema = z.object({
  to: z.string().describe("Recipient email address"),
  cc: z.string().optional().describe("Optional cc address"),
  bcc: z.string().optional().describe("Optional bcc address"),
  subject: z.string().describe("Subject line"),
  text: z.string().optional().describe("Plain-text body"),
  html: z.string().optional().describe("HTML body"),
});

export type EmailInput = z.infer<typeof emailInputSchema>;
