export type CutoverNumber = Readonly<{ state: 'missing' | 'invalid' | 'provided'; value: string | null }>;

/** Presentation only. A well-formed number is never proof of bank availability. */
export function itauCutoverNumbers(internalSequence: string, ourNumberBase: string) {
  const number = (value: string, valid: boolean): CutoverNumber => Object.freeze({
    state: value === '' ? 'missing' : valid ? 'provided' : 'invalid',
    value: valid ? value : null,
  });
  return Object.freeze({
    internalSequence: number(internalSequence, /^[1-9]\d{0,6}$/.test(internalSequence)),
    ourNumberBase: number(ourNumberBase, /^\d{8}$/.test(ourNumberBase) && /[1-9]/.test(ourNumberBase)),
    availabilityVerified: false as const,
  });
}
