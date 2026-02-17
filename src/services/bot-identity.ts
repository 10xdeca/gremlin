import { getBotIdentityFromDb } from "../db/queries.js";

export interface BotIdentity {
  name: string;
  pronouns: string;
  tone: string;
  toneDescription: string | null;
}

const DEFAULT_IDENTITY: BotIdentity = {
  name: "Gremlin",
  pronouns: "they/them",
  tone: "Chaotic unhinged energy",
  toneDescription:
    "An absolute menace that's barely holding it together, communicating like a caffeinated creature causing problems on purpose.",
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
