/** Keep existing local client configuration working during the rename. Explicit new values take precedence. */
export function siftvaneEnvironment<T extends Record<string, string | undefined>>(environment: T): T {
  const settings: Record<string, string | undefined> = environment;
  for (const key of Object.keys(settings)) {
    if (key.startsWith('CLAM_')) settings['SIFTVANE_' + key.slice(5)] ??= settings[key];
  }
  return environment;
}

export function mcpTokenKind(value: string) {
  return /^(?:siftvane|clm)_(ag|inbox|pod)_[\w-]+$/.exec(value)?.[1];
}
