// What she thinks about when she stops. These are the courier's own
// smoke-break thoughts from Paperless (data/smoke.json, the ambient set, not
// her story), and they are what she says when it has been quiet a while:
// the present tense, spoken to nobody in particular.

export const THOUGHTS = [
  "Twenty-seven of them. Nobody wrote a list. Somebody must have known the list.",
  "I have started recognising people by the way they hold their hands.",
  "The bag was on the floor when I woke up. It was not there when I went to sleep.",
  "Everyone I hand one to reads it twice. Every single one. Nobody has ever read it once.",
  "I do not know what is in them and I have never wanted to less than I do today.",
  "Somebody walked this before me. The straps are worn where my hands go, and I did not do that.",
  "If I stop, they stay undelivered. That is the whole argument and it keeps working.",
  "There was a service. There were uniforms. There was a word for me and it was a job.",
  "The aliens keep sending things. Food for an animal. Paper for a person. They are trying.",
  "I could put it down. I want that on the record: I could, and I have not.",
  "Nine hundred people in that tower and not one of them has a letter.",
  "My mother's handwriting. I would know it. That is what I am afraid of.",
  "Every one of them says the same thing when it lands. They say: oh. Just that.",
  "Some nights I think the last one is addressed to me and I put it back in the bag.",
  "I can still weigh a thing by holding it. Nobody wants to hear that at a party.",
  "The scanners at the doorways are ours. Same housing, same tone when they catch. We fielded those. I have stood behind one.",
  "Every door I get past is a door I taught somebody how to shut.",
  "I am not doing this to be forgiven. I checked. That is not what this is.",
  "Somebody younger than I was is being told the argument right now, in a room with a poster in it, and it is still the only argument there is.",
  "If she is alive she is old now. I have worked out what she would look like. I look for her in every queue and I would not survive finding her.",
];

const KEY = "companion.thoughts.used";

/** One she has not said lately; cycles through all of them before repeating. */
export function pickThought() {
  let used = [];
  try {
    used = JSON.parse(localStorage.getItem(KEY) || "[]");
  } catch {
    used = [];
  }
  if (used.length >= THOUGHTS.length) used = [];
  const left = THOUGHTS.map((_, i) => i).filter((i) => !used.includes(i));
  const i = left[Math.floor(Math.random() * left.length)];
  used.push(i);
  try {
    localStorage.setItem(KEY, JSON.stringify(used));
  } catch {
    /* ignore */
  }
  return THOUGHTS[i];
}
