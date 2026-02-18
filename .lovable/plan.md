

# PitchVC AI -- Full Backend + AI Voice Integration Plan

## Overview

Set up the complete backend and real-time AI conversation pipeline so the VC "Shark" persona speaks with an animated avatar, listens to the founder via microphone, and responds intelligently using AI. No external API keys required beyond the pre-configured `LOVABLE_API_KEY`.

---

## Architecture

The system uses three layers:

1. **Lovable AI Gateway** (via edge function) -- powers the VC's brain (conversation, questions, personality)
2. **Web Speech API (browser-native)** -- handles speech-to-text (founder's mic) and text-to-speech (VC's voice)
3. **Animated Avatar** -- a real-time audio-reactive visualization that pulses/animates when the VC speaks

```text
+-------------------+       +-------------------+       +------------------------+
|  Founder's Mic    | ----> | Web Speech API    | ----> | Edge Function          |
|  (audio input)    |       | (speech-to-text)  |       | (Lovable AI Gateway)   |
+-------------------+       +-------------------+       +------------------------+
                                                                   |
                                                                   v
+-------------------+       +-------------------+       +------------------------+
|  Animated Avatar  | <---- | Web Speech API    | <---- | AI Response Text       |
|  (visual output)  |       | (text-to-speech)  |       | (VC persona prompt)    |
+-------------------+       +-------------------+       +------------------------+
```

---

## Step-by-Step Implementation

### Step 1: Enable Lovable Cloud

Activate Lovable Cloud to get Supabase edge function support. The `LOVABLE_API_KEY` is already available.

### Step 2: Create the AI VC Edge Function

**File: `supabase/functions/vc-chat/index.ts`**

- Accepts `{ messages, persona, phase }` from the client
- Prepends a detailed system prompt per persona (The Shark = aggressive, skeptical, demands numbers)
- Calls Lovable AI Gateway (`google/gemini-3-flash-preview`) with streaming disabled (simpler for voice pipeline)
- Returns the VC's text response
- Handles 429/402 rate limit errors gracefully

The system prompt for "The Shark" will include:
- Persona personality and tone rules
- Session phase awareness (intro vs interrogation vs deep dive)
- Instructions to ask hard questions about traction, MRR, burn rate, moat
- Keep responses concise (2-4 sentences) so TTS feels natural

### Step 3: Build the Speech Services Module

**File: `src/lib/speech.ts`**

Two utilities using browser-native Web Speech API (zero dependencies):

- **`startListening(onResult, onEnd)`** -- Uses `SpeechRecognition` to capture founder's speech as text. Continuous mode with interim results.
- **`speak(text, onStart, onEnd)`** -- Uses `SpeechSynthesis` to speak the VC's response aloud. Selects a deep male voice when available.

### Step 4: Build the Conversation Hook

**File: `src/hooks/use-vc-conversation.ts`**

A custom React hook that orchestrates the full conversation loop:

1. Listens to founder's microphone via `SpeechRecognition`
2. When the founder stops speaking, sends their transcript to the edge function
3. Receives AI response text
4. Speaks it via `SpeechSynthesis`
5. Manages conversation state: `listening`, `thinking`, `speaking`, `idle`
6. Maintains message history for context
7. Handles phase transitions (intro -> pitch -> interrogation -> deepdive -> feedback)
8. Auto-starts with a VC intro message when session begins

Exposes:
- `status` (idle/listening/thinking/speaking)
- `transcript` (array of all messages with roles and timestamps)
- `isSpeaking` (boolean for avatar animation)
- `startSession()` / `endSession()`
- `currentPhase`

### Step 5: Create the Animated VC Avatar Component

**File: `src/components/pitch/VCAvatar.tsx`**

An animated avatar that reacts to the VC's speech:

- Concentric pulsing rings that expand when `isSpeaking` is true
- Animated waveform bars (5-7 bars) that randomly oscillate during speech
- Persona icon/initial in the center
- Smooth framer-motion transitions between idle and speaking states
- Status text below: "Listening...", "Thinking...", "Speaking..."
- Gradient glow effect matching the persona color

### Step 6: Refactor PitchRoom to Use Real AI

**File: `src/pages/PitchRoom.tsx`**

Major updates:

- Import and use `useVCConversation` hook
- Replace static `sampleTranscript` with live `transcript` from the hook
- Replace the placeholder Volume2 icon with the new `VCAvatar` component
- Wire `startSession` to begin listening + send intro
- Wire `endSession` to stop listening + generate feedback summary
- Auto-scroll transcript panel as new messages arrive
- Show real-time status indicator (listening/thinking/speaking)
- Phase transitions driven by conversation context
- Disable mic button to mute/unmute speech recognition
- Handle edge cases: mic permission denied, speech API not supported, network errors

### Step 7: Add the Feedback Summary Phase

When session ends, the hook sends a final request to the edge function asking for structured feedback:

- Investor readiness score (0-100)
- Key strengths identified
- Weak points to improve
- Suggested next steps

Display this in a new feedback card UI within PitchRoom when `phase === "feedback"`.

### Step 8: Update Config

**File: `supabase/config.toml`**

- Register the `vc-chat` edge function
- Set `verify_jwt = false` for simplicity (public function)

---

## Technical Details

### Persona System Prompts

Each persona gets a unique system prompt. Example for The Shark:

> "You are a tier-1 Silicon Valley VC partner known for being ruthlessly direct. You have zero patience for fluff. You demand specific numbers: MRR, burn rate, CAC, LTV. If a founder is vague, you interrupt and press harder. You are skeptical by default but excited by real traction. Keep responses to 2-3 sentences max. Never be generic."

### Browser Compatibility

Web Speech API is supported in Chrome, Edge, and Safari. For unsupported browsers, the system will fall back to text-only chat mode with a notice.

### Error Handling

- Microphone denied: show toast, allow text input fallback
- Speech API unsupported: text-only mode
- Network error during AI call: show error toast, allow retry
- Rate limit (429): show "Please wait" message
- Long silence detection: VC prompts "Are you still there?"

---

## Files Created/Modified

| File | Action |
|------|--------|
| `supabase/functions/vc-chat/index.ts` | Create -- AI conversation edge function |
| `src/lib/speech.ts` | Create -- Browser speech utilities |
| `src/hooks/use-vc-conversation.ts` | Create -- Conversation orchestration hook |
| `src/components/pitch/VCAvatar.tsx` | Create -- Animated speaking avatar |
| `src/pages/PitchRoom.tsx` | Modify -- Wire real AI conversation |
| `supabase/config.toml` | Update -- Register edge function |

