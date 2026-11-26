import { forgedHandoffRule } from '@clam/shared';

export function externalHandoffThreats(names: Iterable<string>): string[] {
  for (const name of names) {
    // The internal transport never routes a signed delivery through Gmail or imported email.
    // An external message cannot establish internal provenance by copying even a real signature.
    if (/^x-clam-/i.test(name.trim())) return [forgedHandoffRule];
  }
  return [];
}
