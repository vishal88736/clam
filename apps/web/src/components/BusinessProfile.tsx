'use client';

import { Store } from 'lucide-react';
import { useEffect, useState } from 'react';

type Profile = { inbox_id: string; text: string; updated_at: string | null };

const example = `Business: Acme Lamps — handmade ceramic lamps, shipped across India.
Products: Table lamp ₹2,400; Floor lamp ₹5,900. Warranty: 1 year.
Shipping: 3–5 business days. Returns: 14 days, free for damaged items.
Support: Mon–Sat 10am–6pm, support@acme.example, +91 90000 00000.
Website: https://acme.example`;

/** The facts reply-writing agents may state about the user's business; anything not written here they never claim. */
export function BusinessProfile() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void fetch('/api/inbox/platform/business-profile', { cache: 'no-store' })
      .then((response) => response.ok ? response.json() as Promise<Profile> : Promise.reject(new Error()))
      .then((loaded) => { setProfile(loaded); setDraft(loaded.text); })
      .catch(() => setStatus('The business profile could not be loaded.'));
  }, []);
  const save = async () => {
    setBusy(true);
    setStatus('');
    try {
      const response = await fetch('/api/inbox/platform/business-profile', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: draft }),
      });
      if (!response.ok) throw new Error();
      const saved = await response.json() as Profile;
      setProfile(saved);
      setDraft(saved.text);
      setStatus(saved.text ? 'Saved. Agents use it from their next reply.' : 'Cleared.');
    } catch {
      setStatus('Saving failed.');
    } finally {
      setBusy(false);
    }
  };
  return <section className="inbox-panel business-profile">
    <h2><Store size={19} /> Business profile</h2>
    <p>Agents that reply to customers use these facts: products, prices, hours, policies, links. They never state anything that isn't
      written here, and every reply still waits for your approval.{profile && <> Applies to the <strong>{profile.inbox_id === 'sandbox' ? 'sandbox' : 'connected Gmail'}</strong> mailbox.</>}</p>
    <textarea value={draft} onChange={(event) => { setDraft(event.target.value); setStatus(''); }} rows={8} maxLength={4000}
      placeholder={example} aria-label="Business profile" disabled={!profile} />
    <div className="business-profile-actions">
      <small>{draft.length}/4000{profile?.updated_at && <> · last saved {new Date(profile.updated_at).toLocaleString()}</>}</small>
      <button type="button" className="inbox-button" data-tone="primary" disabled={busy || !profile || draft.trim() === profile.text}
        onClick={() => void save()}>Save profile</button>
    </div>
    {status && <p role="status">{status}</p>}
  </section>;
}
