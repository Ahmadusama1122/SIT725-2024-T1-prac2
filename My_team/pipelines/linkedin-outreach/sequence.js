const { callClaude } = require("../../shared/pipeline-claude");

// ---------------------------------------------------------------------------
// LinkedIn DM Sequence — 6 steps (connect + 5 DMs)
// ---------------------------------------------------------------------------
const LINKEDIN_SEQUENCE = [
  {
    step: "connection_request",
    trigger: "day_6_no_email_reply",
    label: "Connection request",
  },
  {
    step: "dm_1",
    trigger: "connection_accepted",
    label: "DM 1 — Soft open",
    daysAfterPrev: 0, // Immediately on acceptance
  },
  {
    step: "dm_2",
    trigger: "days_after_dm_1",
    label: "DM 2 — Permission pitch",
    daysAfterPrev: 2,
  },
  {
    step: "dm_3",
    trigger: "days_after_dm_2",
    label: "DM 3 — Follow-up",
    daysAfterPrev: 4,
  },
  {
    step: "dm_4",
    trigger: "days_after_dm_3",
    label: "DM 4 — Pattern interrupt",
    daysAfterPrev: 7,
  },
  {
    step: "dm_5",
    trigger: "days_after_dm_4",
    label: "DM 5 — Breakup",
    daysAfterPrev: 10,
  },
];

// ---------------------------------------------------------------------------
// Generate content for each sequence step
// ---------------------------------------------------------------------------

/**
 * Generate a connection request note.
 * @param {{ name: string, company: string, niche: string, city: string }} prospect
 * @returns {Promise<string>} — connection note (max 300 chars)
 */
async function generateConnectionNote(prospect) {
  const country = prospect.country || "Australia";
  const prompt = `Write a LinkedIn connection request note. Max 200 characters.
Target: ${prospect.name}, who runs ${prospect.company} (${prospect.niche}) in ${prospect.city}, ${country}.
Tone: casual, genuine. Like connecting with a fellow business owner.
Do NOT pitch anything. Just express interest in connecting with ${prospect.niche} business owners in ${prospect.city}.
Do NOT use quotation marks around the output.`;

  try {
    const raw = await callClaude(prompt, `Write the connection note now.`, 100);
    return raw.trim().slice(0, 300);
  } catch (err) {
    return `Hi ${prospect.name.split(" ")[0]}, noticed you run ${prospect.company} in ${prospect.city} — always good connecting with ${prospect.niche} business owners. Cheers!`;
  }
}

/**
 * Generate a LinkedIn DM based on the step.
 * @param {string} step — "dm_1" through "dm_5"
 * @param {{ name: string, company: string, niche: string, city: string }} prospect
 * @returns {Promise<string>} — the DM text
 */
async function generateDM(step, prospect) {
  const firstName = prospect.name.split(" ")[0];
  const country = prospect.country || "Australia";
  const prompts = {
    dm_1: `Write a LinkedIn DM opening message. You just connected with ${firstName} who runs ${prospect.company} (${prospect.niche}) in ${prospect.city}, ${country}.

Rules:
- 20-30 words max
- Casual opener — "Hey ${firstName}, saw you're running ${prospect.company} in ${prospect.city}. How's business going?"
- Do NOT pitch anything
- Do NOT mention ReceptFlow
- Like messaging a new connection you genuinely want to know`,

    dm_2: `Write a LinkedIn DM permission pitch. You connected with ${firstName} who runs ${prospect.company} (${prospect.niche}) in ${prospect.city}.

Rules:
- 30-50 words max
- "Trojan Horse" approach — ask permission to share something useful
- "I put together something on how ${prospect.niche} businesses handle after-hours calls. Want me to send it?"
- Do NOT pitch a product
- Casual LinkedIn DM tone`,

    dm_3: `Write a LinkedIn DM follow-up. ${firstName} at ${prospect.company} (${prospect.niche}, ${prospect.city}) hasn't replied to your permission pitch.

Rules:
- 15-25 words max
- Casual nudge with personality
- "Just checking — still interested in that breakdown on after-hours calls for ${prospect.niche} businesses?"
- Not pushy, not formal`,

    dm_4: `Write a LinkedIn DM pattern interrupt. ${firstName} at ${prospect.company} hasn't replied to previous DMs.

Rules:
- 10-20 words max
- Humor or self-aware follow-up
- Example styles: "Not gonna lie, I'm persistent 😄" or "Last one, promise"
- NO product pitch, NO links
- Must feel like a real person, not a bot`,

    dm_5: `Write a LinkedIn DM breakup message. ${firstName} at ${prospect.company} hasn't replied to any DMs. This is the final message.

Rules:
- 15-25 words max
- "No worries if not your thing — just thought it might help. Door's always open."
- Genuine and respectful
- No links, no pitch`,
  };

  const prompt = prompts[step] || prompts["dm_3"];

  try {
    const raw = await callClaude(prompt, `Write the DM now.`, 150);
    return raw.trim();
  } catch (err) {
    // Fallback messages
    const fallbacks = {
      dm_1: `Hey ${firstName}, saw you're running ${prospect.company} in ${prospect.city}. How's business going?`,
      dm_2: `I put together a quick breakdown on how ${prospect.niche} businesses handle after-hours calls without hiring extra staff. Want me to send it over?`,
      dm_3: `Just checking — still interested in that breakdown?`,
      dm_4: `Not gonna lie, I'm persistent. Last nudge, promise!`,
      dm_5: `No worries at all — just thought it might be useful. All the best with ${prospect.company}!`,
    };
    return fallbacks[step] || fallbacks["dm_3"];
  }
}

/**
 * Get the next step in the LinkedIn sequence based on current status.
 * @param {string} currentStatus — current linkedin_status value
 * @returns {{ step: string, label: string } | null} — next step or null if sequence complete
 */
function getNextStep(currentStatus) {
  const statusToNextStep = {
    "none": "connection_request",
    "connection_sent": null, // Wait for acceptance
    "connected": "dm_1",
    "dm_1": "dm_2",
    "dm_2": "dm_3",
    "dm_3": "dm_4",
    "dm_4": "dm_5",
    "dm_5": null, // Sequence complete
    "replied": null,
    "stopped": null,
    "not_found": null,
    "connection_expired": null,
  };

  const nextStepName = statusToNextStep[currentStatus];
  if (!nextStepName) return null;

  const step = LINKEDIN_SEQUENCE.find((s) => s.step === nextStepName);
  return step || null;
}

/**
 * Check if enough days have passed since last action to send the next DM.
 * @param {string} nextStep — the step name (e.g. "dm_2")
 * @param {string} lastActionDate — ISO date of last LinkedIn action
 * @returns {boolean}
 */
function isDMDue(nextStep, lastActionDate) {
  const step = LINKEDIN_SEQUENCE.find((s) => s.step === nextStep);
  if (!step || !step.daysAfterPrev) return true; // connection_request and dm_1 are immediate

  const last = new Date(lastActionDate);
  if (isNaN(last.getTime())) return true;

  const daysSince = Math.floor((Date.now() - last.getTime()) / (24 * 60 * 60 * 1000));
  return daysSince >= step.daysAfterPrev;
}

module.exports = {
  LINKEDIN_SEQUENCE,
  generateConnectionNote,
  generateDM,
  getNextStep,
  isDMDue,
};
