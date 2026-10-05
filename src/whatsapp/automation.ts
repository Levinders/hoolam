/**
 * The things WhatsApp shows before anyone types:
 *  - Ice breakers: up to 4 tappable suggestions in a brand-new chat (max 80 characters, no emoji).
 *  - Commands: the list that pops up when someone types "/" (max 30; name up to 32 characters, hint up to 256).
 *  - Welcome message: WhatsApp tells us when someone opens the chat for the first time,
 *    and we answer with the main menu (see the 'welcome' case in flow.ts).
 *
 * Sent to Meta with POST /{phone-number-id}/conversational_automation every time the server starts.
 * If Meta refuses, the reason is logged and you can set the same things by hand in
 * WhatsApp Manager > Phone numbers > (your number) > Automations.
 *
 * Every ice breaker and command here must also be understood in flow.ts (PHRASES and SLASH).
 */
export type MenuItem = 'open' | 'sell' | 'deals' | 'account' | 'pay' | 'problem' | 'how' | 'fees' | 'human';

/**
 * Shown in a brand-new chat. Each one is a first line a real person would say, and where it leads.
 * WhatsApp rules: 4 max, 80 characters max, no emoji. The chat understands these exact words (flow.ts).
 */
export const ICE_BREAKER_STEPS: { text: string; goTo: MenuItem }[] = [
  { text: 'I want to sell something safely', goTo: 'sell' },
  { text: 'A seller sent me a deal code', goTo: 'pay' },
  { text: 'How does Hoolam protect my money?', goTo: 'how' },
  { text: 'I want to talk to a person', goTo: 'human' },
];
export const ICE_BREAKERS = ICE_BREAKER_STEPS.map((i) => i.text);

/** Typed with "/" at any time. Short hints: they show up in a small pop-up list. */
export const COMMANDS: { name: string; hint: string; goTo: MenuItem }[] = [
  { name: 'menu', hint: 'Everything you can do', goTo: 'open' },
  { name: 'sell', hint: 'Get a safe-pay link for your buyer', goTo: 'sell' },
  { name: 'pay', hint: 'Pay with a code from a seller', goTo: 'pay' },
  { name: 'deals', hint: 'Where your deals and money are', goTo: 'deals' },
  { name: 'problem', hint: 'Freeze the money on a bad delivery', goTo: 'problem' },
  { name: 'account', hint: 'Where we send your money', goTo: 'account' },
  { name: 'fees', hint: 'What it costs and who pays', goTo: 'fees' },
  { name: 'help', hint: 'How Hoolam keeps you safe', goTo: 'how' },
  { name: 'human', hint: 'Talk to a real person', goTo: 'human' },
];

export interface AutomationOptions {
  token: string;
  phoneNumberId: string;
  graphVersion: string;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

export function automationPayload() {
  return {
    enable_welcome_message: true,
    prompts: ICE_BREAKERS,
    commands: COMMANDS.map((c) => ({ command_name: c.name, command_description: c.hint })),
  };
}

/** Pushes the ice breakers, commands and welcome setting to Meta. Never throws: returns ok + Meta's answer. */
export async function syncAutomation(o: AutomationOptions): Promise<{ ok: boolean; status: number; body: string }> {
  const f = o.fetchImpl ?? fetch;
  try {
    const res = await f(`https://graph.facebook.com/${o.graphVersion}/${o.phoneNumberId}/conversational_automation`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${o.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(automationPayload()),
    });
    const body = (await res.text()).slice(0, 400);
    o.log?.(res.ok
      ? `whatsapp menu sync OK: ${ICE_BREAKERS.length} ice breakers, ${COMMANDS.length} commands, welcome message on`
      : `whatsapp menu sync FAILED (HTTP ${res.status}): ${body}. You can set them by hand in WhatsApp Manager > Automations.`);
    return { ok: res.ok, status: res.status, body };
  } catch (e) {
    o.log?.(`whatsapp menu sync FAILED: ${(e as Error).message}`);
    return { ok: false, status: 0, body: (e as Error).message };
  }
}
