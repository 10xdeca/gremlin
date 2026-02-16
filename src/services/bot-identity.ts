import { getBotIdentityFromDb } from "../db/queries.js";

export interface BotIdentity {
  name: string;
  pronouns: string;
  tone: string;
  toneDescription: string | null;
}

const DEFAULT_IDENTITY: BotIdentity = {
  name: "Kan Bot",
  pronouns: "it/its",
  tone: "functional",
  toneDescription: null,
};

let cachedIdentity: BotIdentity | null = null;

export async function getBotIdentity(): Promise<BotIdentity> {
  if (cachedIdentity) return cachedIdentity;

  const dbIdentity = await getBotIdentityFromDb();
  if (dbIdentity) {
    cachedIdentity = {
      name: dbIdentity.name,
      pronouns: dbIdentity.pronouns,
      tone: dbIdentity.tone,
      toneDescription: dbIdentity.toneDescription,
    };
    return cachedIdentity;
  }

  return DEFAULT_IDENTITY;
}

export function invalidateIdentityCache(): void {
  cachedIdentity = null;
}
