import { generateObject } from "ai";
import { z } from "zod";
import { getModel } from "../services/anthropic-client.js";
import type { ImageAttachment } from "../agent/agent-loop.js";

/** Concurrency limiter — drop excess scans to avoid overload. */
let activeScanCount = 0;
const MAX_CONCURRENT_SCANS = 2;

export interface ExtractedContact {
  name?: string;
  email?: string;
  phone?: string;
  organization?: string;
  title?: string;
}

export interface ClassificationResult {
  hasContacts: boolean;
  contacts?: ExtractedContact[];
}

/** Context needed to send a confirmation message back to the chat. */
export interface ScanContext {
  chatId: number;
  messageThreadId?: number;
}

/** Callback to send the confirmation message. Injected by the middleware. */
export type SendConfirmation = (
  ctx: ScanContext,
  message: string,
) => Promise<void>;

const ClassificationSchema = z.object({
  hasContacts: z.boolean().describe("Whether the image contains contact information"),
  contacts: z.array(z.object({
    name: z.string().optional().describe("Person's name"),
    email: z.string().optional().describe("Email address"),
    phone: z.string().optional().describe("Phone number"),
    organization: z.string().optional().describe("Company or organization"),
    title: z.string().optional().describe("Job title or role"),
  })).optional().describe("Extracted contacts, only if hasContacts is true"),
});

const CLASSIFICATION_PROMPT = `You are a contact information detector. Analyze the image and determine if it contains contact information such as:
- Business cards
- Event badges or name tags
- Speaker slides with contact details
- Signup sheets or rosters
- Email signatures
- Social media profiles with contact info

Only include fields that are clearly visible. Do not guess or infer missing fields.`;

/**
 * Scan an image for contact information and send a confirmation message.
 * Does NOT create contacts automatically — asks the user to confirm first.
 * Fire-and-forget — logs results, never throws.
 */
export async function scanImageForContacts(
  base64: string,
  mediaType: ImageAttachment["mediaType"],
  scanCtx: ScanContext,
  sendConfirmation: SendConfirmation,
): Promise<void> {
  // Concurrency gate
  if (activeScanCount >= MAX_CONCURRENT_SCANS) {
    console.log("Contact scanner: at capacity, dropping scan");
    return;
  }

  activeScanCount++;
  try {
    await doScan(base64, mediaType, scanCtx, sendConfirmation);
  } catch (err) {
    console.error("Contact scanner: unexpected error:", err);
  } finally {
    activeScanCount--;
  }
}

async function doScan(
  base64: string,
  mediaType: ImageAttachment["mediaType"],
  scanCtx: ScanContext,
  sendConfirmation: SendConfirmation,
): Promise<void> {
  const classification = await classify(base64, mediaType);
  if (!classification.hasContacts || !classification.contacts?.length) {
    return;
  }

  console.log(
    `Contact scanner: found ${classification.contacts.length} potential contact(s), sending confirmation`,
  );

  const message = formatConfirmation(classification.contacts);
  await sendConfirmation(scanCtx, message);
}

async function classify(
  base64: string,
  mediaType: ImageAttachment["mediaType"],
): Promise<ClassificationResult> {
  try {
    const { object } = await generateObject({
      model: getModel(),
      schema: ClassificationSchema,
      messages: [
        {
          role: "user" as const,
          content: [
            { type: "image" as const, image: base64, mediaType },
            { type: "text" as const, text: CLASSIFICATION_PROMPT },
          ],
        },
      ],
      maxOutputTokens: 512,
    });
    return object;
  } catch (err) {
    console.warn("Contact scanner: classification failed:", err);
    return { hasContacts: false };
  }
}

/** Format extracted contacts into a confirmation message. */
export function formatConfirmation(contacts: ExtractedContact[]): string {
  const lines = contacts.map((c) => {
    const parts: string[] = [];
    if (c.name) parts.push(`*${c.name}*`);
    if (c.title) parts.push(c.title);
    if (c.organization) parts.push(c.organization);
    if (c.email) parts.push(c.email);
    if (c.phone) parts.push(c.phone);
    return `- ${parts.join(" | ")}`;
  });

  const noun = contacts.length === 1 ? "contact" : "contacts";
  return [
    `I spotted ${contacts.length} potential ${noun} in that image:`,
    "",
    ...lines,
    "",
    `Want me to save ${contacts.length === 1 ? "this" : "them"} to contacts?`,
  ].join("\n");
}

/** Exported for testing — returns current active scan count. */
export function getActiveScanCount(): number {
  return activeScanCount;
}

/** Exported for testing — allows resetting concurrency counter. */
export function _resetActiveScanCount(): void {
  activeScanCount = 0;
}
