import type { QuantizedNote } from './types';

/**
 * Assign MusicXML voice IDs (1 for primary/upper voice, 2 for secondary/lower voice)
 * for notes within the same staff measure to prevent rhythmic duration overlap collisions.
 */
export function assignMeasureVoices(notes: readonly QuantizedNote[]): Map<string, number> {
  const voiceMap = new Map<string, number>();
  if (notes.length === 0) return voiceMap;

  const staff1 = notes.filter((n) => n.staff === 1);
  const staff2 = notes.filter((n) => n.staff === 2);

  for (const staffNotes of [staff1, staff2]) {
    const sorted = [...staffNotes].sort((a, b) => a.onsetBeats - b.onsetBeats || b.pitch - a.pitch);
    for (let i = 0; i < sorted.length; i++) {
      const note = sorted[i];
      if (!voiceMap.has(note.id)) voiceMap.set(note.id, 1);

      for (let j = 0; j < i; j++) {
        const prev = sorted[j];
        const prevEnd = prev.onsetBeats + prev.durationBeats;
        if (prevEnd > note.onsetBeats + 1e-4) {
          if (note.pitch < prev.pitch) {
            voiceMap.set(note.id, 2);
          } else if (prev.pitch < note.pitch) {
            voiceMap.set(prev.id, 2);
          }
        }
      }
    }
  }

  return voiceMap;
}
