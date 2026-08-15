// services/groqDtcService.ts
//
// AI fallback for OBD-II codes that are NOT in the local DTC_DATABASE
// (rare codes, manufacturer-specific codes like JAC/Chery/Geely P1xxx codes,
// or anything newer than the last time the local dictionary was updated).
//
// This replaces the earlier Gemini-based service. Gemini was dropped because
// Google's new "AQ." API key format has been returning
// 401 ACCESS_TOKEN_TYPE_UNSUPPORTED for a large number of accounts on the
// native REST endpoint since mid-2026, with no confirmed fix — see the
// Google AI Developers forum for ongoing reports. Groq is used instead:
// it's genuinely free with no credit card, runs on very fast LPU hardware,
// and exposes an OpenAI-compatible /chat/completions endpoint.
//
// This is called ONLY when the local dictionary lookup misses — see
// resolveFaultCode() in app/diagnostics.tsx. It asks the model to return a
// bilingual, structured object that matches our existing DTCRecord shape
// exactly, so the rest of the UI (fault cards, urgency badges, advice modal)
// doesn't need to know whether a record came from the local dictionary or
// from the AI.
//
// ---------------------------------------------------------------------------
// API KEY SETUP
// ---------------------------------------------------------------------------
// 1. Get a free Groq API key from https://console.groq.com/keys — no
//    credit card required, sign in with Google/GitHub/email.
// 2. Create a `.env` file at the project root (never commit it — add it to
//    .gitignore) with:
//
//      EXPO_PUBLIC_GROQ_API_KEY=your_key_here
//
//    Expo only inlines env vars prefixed with EXPO_PUBLIC_ into the client
//    bundle, which is what makes it reachable here via process.env.
//
// ⚠️ SECURITY NOTE: Any EXPO_PUBLIC_* variable is bundled into the app and
// IS extractable by anyone who has the compiled app (it is client-side, not
// a server secret). That's an acceptable tradeoff for a prototype, but for
// a production release you should instead proxy this call through your own
// backend (e.g. a Cloud Function) that holds the real key server-side and
// rate-limits requests — never ship a key directly inside a public app
// binary. The fetch call below is written so swapping the URL for your own
// backend endpoint later is a one-line change.
// ---------------------------------------------------------------------------

import { DTCRecord, UrgencyLevel } from '../constants/dtc_dictionary';

const GROQ_API_KEY = process.env.EXPO_PUBLIC_GROQ_API_KEY ?? '';
// Configurable so you can swap models without touching code. Free-tier
// limits and available models can change — check
// https://console.groq.com/docs/models for the current list.
// llama-3.3-70b-versatile is a solid default: strong instruction-following
// and good bilingual (EN/AR) output at no cost on the free tier.
const GROQ_MODEL = process.env.EXPO_PUBLIC_GROQ_MODEL ?? 'llama-3.3-70b-versatile';
const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';

// How long we wait for a response before giving up and surfacing the
// 'error' state (with a Retry button) on the fault card. Without this, a
// stalled connection would leave the card spinning in 'loading' forever.
const REQUEST_TIMEOUT_MS = 15000;

const VALID_URGENCY: UrgencyLevel[] = ['STOP', 'REDUCE_SPEED', 'CAUTION'];

// The advice array is always [immediate driving guidance, ...repair steps].
// We require at least 2 entries so the UI always has something to show in
// both the "Immediate Driving Guidance" box and the "Technical Repair
// Steps" list — even if the model doesn't return the full 5 items we ask for.
const MIN_ADVICE_ITEMS = 2;

// Groq's json_object mode guarantees syntactically valid JSON but, unlike
// Gemini's responseSchema, does not enforce a specific shape — so the exact
// field layout has to be spelled out in the prompt itself, and the runtime
// validation below carries more of the weight.
const SYSTEM_PROMPT = `You are an automotive diagnostics expert covering global and manufacturer-specific
(including Chinese brands like JAC, Chery, Geely, MG) OBD-II trouble codes.

Always respond with ONLY a single JSON object (no markdown, no commentary) with exactly
these fields:
{
  "descEn": string — short English description of the fault,
  "descAr": string — same description in Modern Standard Arabic, short and clear,
  "module": string — the responsible ECU/module in English, e.g. "Engine Control Module (ECM)",
  "urgency": "STOP" | "REDUCE_SPEED" | "CAUTION",
  "adviceEn": string[] — exactly 5 items. Item[0] MUST be the immediate on-road driving
    guidance (what the driver should do right now, behind the wheel). Items[1..4] are
    numbered technical repair steps for a workshop/mechanic.,
  "adviceAr": string[] — the same 5 items translated into Arabic, in the same order,
    item[0] also being the immediate driving guidance.
}

Be conservative with the urgency classification — if you are not fully certain the fault
is minor, classify it as at least CAUTION, and use STOP only for faults that pose a real
risk of stranding the driver, engine damage, or an accident (e.g. brake, steering,
overheating, major loss of power, airbag-related codes).`;

function buildPrompt(code: string, moduleName?: string): string {
  const modText = moduleName ? `reported specifically by the ${moduleName} module` : 'reported by the vehicle';
  return `The local app dictionary does not have an entry for DTC code "${code}" (${modText}). Generate an
accurate, safety-conscious explanation for this exact code, following the JSON shape
described in the system prompt.`;
}

export interface AIResolvedDTC extends DTCRecord {
  source: 'AI';
}

export async function fetchDTCFromAI(code: string, moduleName?: string): Promise<AIResolvedDTC> {
  if (!GROQ_API_KEY) {
    throw new Error('Missing EXPO_PUBLIC_GROQ_API_KEY — set it in your .env file.');
  }

  // Guard against a stalled connection leaving the fault card stuck in
  // 'loading' forever — abort and let the caller show the Retry state.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(GROQ_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildPrompt(code) },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.2,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Groq request timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Groq request failed (${response.status}): ${errText}`);
  }

  const data = await response.json();
  const rawText: string | undefined = data?.choices?.[0]?.message?.content;
  if (!rawText) {
    throw new Error('Groq returned an empty response.');
  }

  let parsed: any;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new Error('Groq returned malformed JSON.');
  }

  if (
    !parsed.descEn ||
    !parsed.descAr ||
    !Array.isArray(parsed.adviceEn) ||
    !Array.isArray(parsed.adviceAr) ||
    parsed.adviceEn.length < MIN_ADVICE_ITEMS ||
    parsed.adviceAr.length < MIN_ADVICE_ITEMS
  ) {
    throw new Error('Groq response is missing required fields or has incomplete advice steps.');
  }

  const urgency: UrgencyLevel = VALID_URGENCY.includes(parsed.urgency) ? parsed.urgency : 'CAUTION';

  return {
    code,
    descEn: parsed.descEn,
    descAr: parsed.descAr,
    module: moduleName || parsed.module, // Use our detected module name, fallback to AI's guess
    urgency,
    adviceEn: parsed.adviceEn,
    adviceAr: parsed.adviceAr,
    source: 'AI',
  };
}