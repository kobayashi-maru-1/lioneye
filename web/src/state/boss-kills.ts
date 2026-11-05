/**
 * Log lines that mean a campaign boss just died, checked word for word against real
 * Client.txt logs. Most campaign bosses log nothing when they die (Hillock, Merveil,
 * Brutus...); their steps still tick when you leave the zone.
 *
 * `bosses` are the names in the route's {kill|...} fragments; `speaker` is the name the
 * log shows before the colon ("" for a system line).
 */
export interface BossDeath {
  bosses: string[];
  speaker: string;
  lines: string[];
}

export const BOSS_DEATHS: BossDeath[] = [
  {
    bosses: ["Piety"],
    speaker: "Piety",
    lines: ["Damn you!"],
  },
  {
    bosses: ["General Gravicius"],
    speaker: "Gravicius",
    lines: [
      "I fought for God. Who do you fight for, exile?",
      "My place is at God's side. Where will your journey end, exile?",
    ],
  },
  {
    bosses: ["Dominus, High Templar"],
    speaker: "Dominus",
    lines: ["This world is an illusion, exile."],
  },
  {
    bosses: ["Piety, the Abomination"],
    speaker: "Piety",
    // One per class.
    lines: [
      "My beautiful champion. I knew I could rely on you.",
      "Well done, assassin. Another satisfied customer.",
      "I may have misjudged that God of yours...",
      "Our mistakes can be our greatest achievements.",
      "Kaom wasn't half the man you are, Marauder.",
      "You've just earned yourself some bigger prey, huntress.",
      "Let's not make this a habit. It really hurts.",
    ],
  },
  {
    bosses: ["Malachai, The Nightmare"],
    speaker: "Malachai",
    lines: ["Why... are you so in love with Death?"],
  },
  {
    bosses: ["Maligaro, The Inquisitor"],
    speaker: "Maligaro, the Inquisitor",
    lines: [
      "You have murdered... an artist...",
      "I could have made you... into a wonder...",
      "You are the greatest form... I never sculpted...",
    ],
  },
  // Acts 5-10: the god or boss is silent; Sin calls its name, then speaks a second line.
  {
    bosses: ["Kitava, the Insatiable"],
    speaker: "Sin",
    lines: [
      "The flame of hope may flicker but it cannot be extinguished!",
      "May a new dawn arise!",
    ],
  },
  {
    bosses: ["Kitava, the Insatiable"],
    speaker: "",
    lines: [
      "You have been permanently weakened by Kitava's cruel affliction. You now have -30% to all Resistances.",
      "You have been permanently weakened by Kitava's merciless affliction. You now have a total of -60% to all Resistances.",
    ],
  },
  {
    bosses: ["Abberath, the Cloven One"],
    speaker: "Sin",
    lines: ["Abberath!", "At last your thirst is quenched."],
  },
  {
    bosses: ["Ryslatha, the Puppet Mistress"],
    speaker: "Sin",
    lines: ["Ryslatha!", "Release this land to the will of its true children."],
  },
  {
    bosses: ["Tsoagoth, The Brine King"],
    speaker: "Sin",
    lines: [
      "Tsoagoth!",
      "Born of ocean's mire, in death washed clean of dark desire.",
    ],
  },
  {
    bosses: ["Tukohama, Karui God of War"],
    speaker: "Sin",
    lines: ["Tukohama!", "The soil wants for your blood no more."],
  },
  {
    bosses: ["Greust, Lord of the Forest"],
    speaker: "Sin",
    lines: [
      "Ralakesh!",
      "Turn away the tyrant's face and kingdom end without a trace.",
    ],
  },
  {
    bosses: ["Gruthkul, Mother of Despair"],
    speaker: "Sin",
    lines: ["Gruthkul!", "Thus I release you from motherhood's rage."],
  },
  {
    bosses: ["Arakaali, Spinner of Shadows"],
    speaker: "Sin",
    lines: ["Arakaali!", "Death is the true climax of perverted lust."],
  },
  {
    bosses: ["Yugul, Reflection of Terror"],
    speaker: "Sin",
    lines: ["Yugul!", "In death the mirrors are thus shattered."],
  },
  {
    // They die together.
    bosses: ["Lunaris, Eternal Moon", "Solaris, Eternal Sun"],
    speaker: "Sin",
    lines: [
      "Solaris! Lunaris!",
      "Eclipse cold pride, flaming rage, and pass beyond this human age.",
    ],
  },
  {
    bosses: ["Shakari, Queen of the Sands"],
    speaker: "Sin",
    lines: [
      "Daughter!",
      "Rest, my child. Be free from the torments of immortality.",
    ],
  },
  {
    bosses: ["Garukhan, Queen of the Winds"],
    speaker: "Sin",
    lines: [
      "My love...",
      "You were too beautiful for this ugly world. I shall find you in the next.",
    ],
  },
  {
    bosses: ["High Templar Avarius"],
    speaker: "Sin",
    lines: ["Innocence!", "You and only you, I shall save."],
  },
];

/** `] Speaker: text` (or `] : text` for a system line). */
const SPEECH = /\] ([^:\]]*): (.*)$/;

/** The route's boss names that a log line says just died, or null. */
export function bossesKilledBy(line: string): string[] | null {
  const match = SPEECH.exec(line);
  if (!match) return null;
  const speaker = match[1].trim();
  // The log sometimes ends Sin's lines with a space.
  const text = match[2].trim();
  for (const death of BOSS_DEATHS) {
    if (death.speaker === speaker && death.lines.includes(text))
      return death.bosses;
  }
  return null;
}
