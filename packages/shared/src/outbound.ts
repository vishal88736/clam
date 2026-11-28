/**
 * Deterministic outbound secret/credential/OTP leak scanner.
 * Blocks recognizable credentials and authentication material in outgoing content.
 */
export function scanOutboundSecrets(text: string): string | null {
  if (/\b(?:siftvane|clm)_(?:ag|inbox|pod)_[A-Za-z0-9_-]{12,}/.test(text)) {
    return 'Siftvane bearer token';
  }
  if (/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/.test(text)) {
    return 'AWS access key identifier';
  }
  if (/\b(?:AIza[A-Za-z0-9_-]{35}|GOCSPX-[A-Za-z0-9_-]{20,}|ya29\.[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|sk-(?:proj-|ant-)?[A-Za-z0-9_-]{25,}|gsk_[A-Za-z0-9]{25,})\b/.test(text)) {
    return 'provider credential';
  }
  if (/(?:^|[\r\n])\s*(?:export\s+)?[A-Z][A-Z0-9_]*(?:API_KEY|SECRET|ACCESS_TOKEN|REFRESH_TOKEN|PASSWORD)\s*=\s*['"]?[^\s'"#]{6,}/m.test(text)) {
    return 'environment credential assignment';
  }
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) {
    return 'private cryptographic key';
  }
  if (
    /(?:one-time\s*(?:password|passcode|code)|otp|2fa\s*(?:login\s*)?code|verification\s*code)\s*(?:is|:|#)?\s*\d{4,8}/i.test(
      text
    )
  ) {
    return 'OTP / 2FA code';
  }
  if (
    /(?:password\s*reset|reset\s*token|magic\s*link)\s*[:=]?\s*https?:\/\/|https?:\/\/[^\s]*(?:RecoverAccount\?token=|password_reset\/)/i.test(
      text
    )
  ) {
    return 'password reset link';
  }
  return null;
}
