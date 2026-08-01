/**
 * Greeting and filler tokens that disqualify a customer message from becoming a title
 * (feature 023, roadmap 4.18 — U8 / research R6).
 *
 * **Data, not code.** Extending it must not need a deploy: the support team will find phrases we did
 * not, and a list that requires a release to change is a list that stops being maintained.
 *
 * **Matched as a UNION across every language**, not a language-selected subset, because this product
 * has no language signal (research R6). A Spanish greeting is filtered in a Russian conversation too,
 * which is harmless — nobody's real question is exactly "hola".
 *
 * Seeded from what their own traffic shows: the operator's players are Chile / Argentina / Mexico
 * (Spanish), the support floor writes Russian and English, and the bot funnels produce bare
 * punctuation and stickers.
 *
 * ⚠️ Entries are matched against the WHOLE normalised message, never as a substring — "hola, no me
 * llegó el depósito" must pass. Adding a common word here would silently swallow real questions.
 */
export const FILLER_TOKENS: readonly string[] = [
  // Russian
  'привет',
  'здравствуйте',
  'добрый день',
  'добрый вечер',
  'доброе утро',
  'здрасте',
  'ку',
  'алло',
  'есть кто',
  'помогите',

  // Spanish (the largest player base)
  'hola',
  'buenas',
  'buenos dias',
  'buenas tardes',
  'buenas noches',
  'que tal',
  'alguien ahi',
  'ayuda',
  'gracias',

  // English
  'hi',
  'hey',
  'hello',
  'good morning',
  'good evening',
  'anyone there',
  'help',
  'thanks',
  'thank you',

  // Portuguese (present in LATAM traffic)
  'ola',
  'bom dia',
  'boa tarde',
  'boa noite',

  // Channel noise: punctuation and sticker markers collapse to these after normalisation.
  '?',
  '??',
  '???',
  '!',
  'sticker',
  'gif',
];
