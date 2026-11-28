'use client';

import { BrainCircuit, CircleCheck, CircleX } from 'lucide-react';
import { useEffect, useState } from 'react';

type Provider = 'off' | 'gemini' | 'openai' | 'anthropic' | 'groq' | 'ollama';
type View = { source: 'website' | 'environment'; provider: Provider | 'local'; model: string | null; endpoint: string | null; has_key: boolean;
  suggestions: Record<Exclude<Provider, 'off'>, string[]> };

const names: Record<Provider, string> = {
  off: 'No AI (fixed workflows only)', gemini: 'Google Gemini', openai: 'OpenAI', anthropic: 'Anthropic Claude', groq: 'Groq', ollama: 'Ollama (runs on this computer)',
};
const keyHelp: Partial<Record<Provider, string>> = {
  gemini: 'aistudio.google.com → Get API key', openai: 'platform.openai.com → API keys', anthropic: 'console.anthropic.com → API keys', groq: 'console.groq.com → API keys',
};

const call = async (method: string, path = '', body?: unknown) => {
  const response = await fetch('/api/inbox/platform/ai-provider' + path, {
    method, cache: 'no-store', ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(({
    AI_KEY_REQUIRED: 'Paste an API key for this provider.', AI_KEY_STORAGE_UNAVAILABLE: 'This server has no SIFTVANE_TOKEN_ENCRYPTION_KEY, so it cannot store API keys safely.',
    SIGN_IN_REQUIRED: 'Sign in with Google first.', AI_SETTINGS_INVALID: 'That provider and model combination is not valid.',
  } as Record<string, string>)[data.error] ?? 'The request failed.');
  return data;
};

/** Pick the AI that powers agents: planning a request in plain language, reading mail, and writing replies. */
export function AiProvider() {
  const [view, setView] = useState<View | null>(null);
  const [provider, setProvider] = useState<Provider>('off');
  const [model, setModel] = useState('');
  const [key, setKey] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const show = (loaded: View) => {
    setView(loaded);
    const current = loaded.provider === 'local' ? 'off' : loaded.provider;
    setProvider(current);
    setModel(loaded.model ?? '');
    setEndpoint(loaded.endpoint ?? '');
    setKey('');
  };
  useEffect(() => { void call('GET').then(show).catch(() => setResult({ ok: false, text: 'Could not load the AI settings.' })); }, []);
  const same = view && (view.provider === 'local' ? 'off' : view.provider) === provider;
  const needsKey = provider !== 'off' && provider !== 'ollama' && !(same && view?.has_key);

  const save = async () => {
    setBusy(true);
    setResult(null);
    try {
      const saved = await call('PUT', '', { provider, ...(provider !== 'off' && model.trim() ? { model: model.trim() } : {}),
        ...(key.trim() ? { api_key: key.trim() } : {}), ...(provider === 'ollama' && endpoint.trim() ? { endpoint: endpoint.trim() } : {}) }) as View;
      show(saved);
      if (provider === 'off') { setResult({ ok: true, text: 'Saved. Agents now use fixed workflows only.' }); return; }
      const test = await call('POST', '/test') as { ok: boolean; latency_ms: number; error: string | null };
      setResult(test.ok ? { ok: true, text: `Saved and working: ${names[provider]} answered in ${(test.latency_ms / 1000).toFixed(1)} s.` }
        : { ok: false, text: `Saved, but the test call failed (${test.error ?? 'no answer'}). Check the key, the model name, or that the server is running.` });
    } catch (failure) { setResult({ ok: false, text: failure instanceof Error ? failure.message : 'Saving failed.' }); }
    finally { setBusy(false); }
  };

  return <section className="inbox-panel ai-provider" id="ai">
    <h2><BrainCircuit size={19} /> AI provider</h2>
    <p>The AI that turns your plain-language requests into agents, reads your mail, and writes replies. Your key is stored encrypted and never shown again.</p>
    {!view ? <p>Loading…</p> : <form className="ai-provider-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <label>Provider
        <select value={provider} onChange={(event) => { const next = event.target.value as Provider; setProvider(next); setResult(null);
          setModel(next !== 'off' && next === (view.provider === 'local' ? 'off' : view.provider) ? view.model ?? '' : next === 'off' ? '' : view.suggestions[next][0]); }}>
          {(Object.keys(names) as Provider[]).map((item) => <option key={item} value={item}>{names[item]}</option>)}
        </select>
      </label>
      {provider !== 'off' && <label>Model
        <input value={model} list="ai-models" onChange={(event) => setModel(event.target.value)} placeholder={view.suggestions[provider][0]} />
        <datalist id="ai-models">{view.suggestions[provider].map((item) => <option key={item} value={item} />)}</datalist>
      </label>}
      {provider !== 'off' && provider !== 'ollama' && <label>API key
        <input type="password" value={key} autoComplete="off" onChange={(event) => setKey(event.target.value)}
          placeholder={same && view.has_key ? 'Saved. Leave empty to keep it' : 'Paste your key'} />
        <small>{keyHelp[provider]}</small>
      </label>}
      {provider === 'ollama' && <label>Ollama address
        <input value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder="http://127.0.0.1:11434" />
        <small>Start it with <code>ollama serve</code>, and pull the model first (<code>ollama pull {model || 'qwen2.5:7b'}</code>).</small>
      </label>}
      <div className="inbox-actions">
        <button type="submit" className="inbox-button" data-tone="primary" disabled={busy || (needsKey && !key.trim())}>{busy ? 'Saving and testing…' : 'Save & test'}</button>
        {view.source === 'website' && <button type="button" className="inbox-button" disabled={busy}
          onClick={() => void call('DELETE').then((loaded) => { show(loaded as View); setResult({ ok: true, text: 'Back to the server’s .env settings.' }); })}>Use server default</button>}
      </div>
    </form>}
    {result && <p className="ai-provider-result" data-ok={result.ok} role="status">{result.ok ? <CircleCheck size={16} /> : <CircleX size={16} />} {result.text}</p>}
    {view && <small>Now using: <strong>{view.provider === 'local' || view.provider === 'off' ? 'no AI' : `${names[view.provider as Provider]} · ${view.model}`}</strong>
      {view.source === 'environment' ? ' (from the server’s .env)' : ''}</small>}
  </section>;
}
