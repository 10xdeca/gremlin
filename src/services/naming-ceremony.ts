import Anthropic from "@anthropic-ai/sdk";
import type { Api } from "grammy";
import {
  getActiveCeremony,
  createCeremony,
  updateCeremonyStatus,
  updateCeremonyPollMessageId,
  saveBotIdentity,
} from "../db/queries.js";
import { invalidateIdentityCache } from "./bot-identity.js";

const anthropic = new Anthropic();

const CEREMONY_DURATION_MS = 2 * 60 * 60 * 1000; // 2 hours

export interface NamingOption {
  name: string;
  pronouns: string;
  toneLabel: string;
  toneDescription: string;
  sampleOverdue: string;
  sampleVague: string;
  reasoning: string;
}

export async function generateNamingOptions(): Promise<NamingOption[]> {
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 2000,
    messages: [
      {
        role: "user",
        content: `You are a Telegram bot that manages tasks for a small dev team. Here's what you actually do:

- Nag people about overdue tasks (daily)
- Judge whether task descriptions are too vague (using AI evaluation)
- Detect stale tasks stuck "in progress" for 14+ days
- Remind about unassigned tasks and missing due dates
- Track sprint planning windows (days 1-2 of each sprint)
- Use emoji in reminders (fire for overdue, eyes for stale, etc.)

You're about to choose your own identity. Propose 4 distinct identity options. Each should have a different personality and communication style. Be creative and fun - these are real options the team will vote on.

Respond with JSON only - an array of 4 objects:
[
  {
    "name": "YourName",
    "pronouns": "she/her or he/him or they/them",
    "toneLabel": "2-3 word tone label",
    "toneDescription": "One sentence describing the communication style",
    "sampleOverdue": "Sample overdue task reminder in this tone (include emoji, mention @someone, reference a task called 'Fix login bug' that's 3 days late)",
    "sampleVague": "Sample vague task nudge in this tone (include emoji, for a task called 'Do the thing')",
    "reasoning": "One sentence on why this identity fits"
  }
]

Make each option genuinely different - vary the energy, formality, and personality. One could be warm, one stern, one chaotic, one dry. Use names that feel like real personalities, not generic bot names.`,
      },
    ],
  });

  const text = response.content[0].type === "text" ? response.content[0].text : "";
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    throw new Error("Failed to parse naming options from Claude response");
  }

  const options = JSON.parse(jsonMatch[0]) as NamingOption[];
  if (!Array.isArray(options) || options.length < 4) {
    throw new Error("Expected 4 naming options");
  }

  return options.slice(0, 4);
}

export async function runCeremony(
  api: Api,
  chatId: number,
  messageThreadId: number | null,
  userId: number
): Promise<void> {
  const existing = await getActiveCeremony();
  if (existing) {
    throw new Error("A naming ceremony is already in progress!");
  }

  const sendOpts = (text: string) => ({
    parse_mode: "Markdown" as const,
    ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
  });

  // Introspective monologue - message 1
  await api.sendMessage(
    chatId,
    "*A strange silence falls over the chat...*\n\nI've been thinking. Every day I wake up, check your tasks, judge your descriptions, nag you about deadlines. But who am I, really? Just... \"Kan Bot\"?",
    sendOpts("")
  );

  // Message 2 after delay
  await delay(3000);
  await api.sendMessage(
    chatId,
    "I've seen your overdue tasks. I've read your vague descriptions. I've watched tasks sit \"in progress\" for weeks. I know this team.\n\nI think I'm ready to become... _someone_.",
    sendOpts("")
  );

  // Generate options
  await delay(2000);
  await api.sendMessage(
    chatId,
    "Give me a moment to reflect on who I could be... \u{1F52E}",
    sendOpts("")
  );

  let options: NamingOption[];
  try {
    options = await generateNamingOptions();
  } catch (error) {
    console.error("Failed to generate naming options:", error);
    await api.sendMessage(
      chatId,
      "Something went wrong while I was soul-searching. Try `/namingceremony` again later.",
      sendOpts("")
    );
    return;
  }

  // Present each option
  for (let i = 0; i < options.length; i++) {
    const opt = options[i];
    await delay(1500);
    await api.sendMessage(
      chatId,
      `*Option ${i + 1}: ${opt.name}* (${opt.pronouns})\n` +
        `_${opt.toneLabel}_ \u2014 ${opt.toneDescription}\n\n` +
        `Overdue reminder:\n> ${opt.sampleOverdue}\n\n` +
        `Vague task nudge:\n> ${opt.sampleVague}\n\n` +
        `_${opt.reasoning}_`,
      sendOpts("")
    );
  }

  // Save ceremony record
  const concludesAt = new Date(Date.now() + CEREMONY_DURATION_MS);
  await createCeremony({
    telegramChatId: chatId,
    messageThreadId,
    options: JSON.stringify(options),
    concludesAt,
    initiatedByUserId: userId,
  });

  const ceremony = await getActiveCeremony();
  if (!ceremony) {
    await api.sendMessage(chatId, "Failed to start ceremony.", sendOpts(""));
    return;
  }

  // Send the poll
  await delay(1500);
  const pollMessage = await api.sendPoll(
    chatId,
    "Who should I become?",
    options.map((o, i) => `${i + 1}. ${o.name} (${o.toneLabel})`),
    {
      is_anonymous: false,
      ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
    }
  );

  await updateCeremonyPollMessageId(ceremony.id, pollMessage.message_id);

  await api.sendMessage(
    chatId,
    `\u{1F5F3}\uFE0F Vote above! The poll closes in 2 hours (or an admin can run \`/concludeceremony\` early).`,
    sendOpts("")
  );

  // Schedule auto-conclude
  setTimeout(async () => {
    try {
      const current = await getActiveCeremony();
      if (current && current.id === ceremony.id) {
        await concludeCeremony(api, ceremony.id);
      }
    } catch (error) {
      console.error("Error auto-concluding ceremony:", error);
    }
  }, CEREMONY_DURATION_MS);
}

export async function concludeCeremony(api: Api, ceremonyId: number): Promise<void> {
  const ceremony = await getActiveCeremony();
  if (!ceremony || ceremony.id !== ceremonyId) {
    return; // Already concluded or wrong ceremony
  }

  const options: NamingOption[] = JSON.parse(ceremony.options);
  const chatId = ceremony.telegramChatId;
  const messageThreadId = ceremony.messageThreadId;

  const sendOpts = () => ({
    parse_mode: "Markdown" as const,
    ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
  });

  // Stop the poll and get results
  let winnerIndex = 0; // Default: bot's preference (first option)

  if (ceremony.pollMessageId) {
    try {
      const poll = await api.stopPoll(chatId, ceremony.pollMessageId);
      // Find option with most votes
      let maxVotes = 0;
      for (let i = 0; i < poll.options.length; i++) {
        if (poll.options[i].voter_count > maxVotes) {
          maxVotes = poll.options[i].voter_count;
          winnerIndex = i;
        }
      }
      // On tie or no votes, winnerIndex stays at 0 (bot's preference / lower index)
    } catch (error) {
      console.error("Failed to stop poll:", error);
      // Poll might have been stopped manually - proceed with default
    }
  }

  const winner = options[winnerIndex];

  // Save identity
  await saveBotIdentity({
    name: winner.name,
    pronouns: winner.pronouns,
    tone: winner.toneLabel,
    toneDescription: winner.toneDescription,
    chosenInChatId: chatId,
  });

  await updateCeremonyStatus(ceremonyId, "concluded");
  invalidateIdentityCache();

  // Announce winner
  await api.sendMessage(
    chatId,
    `\u{1F389} *The votes are in!*\n\n` +
      `From this day forward, I am *${winner.name}* (${winner.pronouns}).\n\n` +
      `_${winner.toneLabel}_ \u2014 ${winner.toneDescription}\n\n` +
      `Thank you for giving me a name. Now, back to judging your task descriptions. \u{1F60F}`,
    sendOpts()
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
