import { ArrowRight, ClipboardCheck, GitCompareArrows, Inbox, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { ClamMascot } from '@/components/ClamMascot';

const workflow = [
  { Icon: Inbox, title: 'Read the inbox', copy: 'Clam reads sanitized messages and their thread context to identify changes and work that needs attention.' },
  { Icon: ShieldCheck, title: 'Apply your policy', copy: 'A separate executor checks permission, recipient provenance, and write budgets before calling a tool.' },
  { Icon: GitCompareArrows, title: 'Check what changed', copy: 'Calendar, mail, and ledger writes are read back. Verified changes appear with before and after values.' },
  { Icon: ClipboardCheck, title: 'Keep the receipt', copy: 'Review the trace, approve gated actions, or roll back eligible changes from the Inbox Briefing.' },
];

export default function AboutPage() {
  return <div className="landing">
    <header className="landing-header">
      <div className="landing-header-inner">
        <Link href="/" className="inline-flex items-center gap-2 font-extrabold"><ClamMascot variant="glyph" size={32} /> Clam</Link>
        <nav className="landing-nav" aria-label="About navigation"><a href="#workflow">How it works</a></nav>
        <Link href="/" className="landing-button landing-button-secondary">Open Inbox Briefing <ArrowRight size={16} /></Link>
      </div>
    </header>
    <main>
      <section className="landing-hero" id="hero">
        <div className="landing-hero-content">
          <span className="landing-badge landing-tone-neutral">Agentware 2026 · Inbox &amp; Calendar</span>
          <div className="landing-hero-mascot"><ClamMascot size={254} interactive /></div>
          <h1>Build an agent you can <span>walk away from.</span></h1>
          <p className="landing-lede">Clam handles permitted inbox and calendar work. You get a verified record of what changed and an approval inbox for the rest.</p>
          <div className="landing-actions">
            <Link href="/" className="landing-button btn-primary">Open Inbox Briefing <ArrowRight size={16} /></Link>
            <a href="#workflow" className="landing-button landing-button-secondary">See the workflow</a>
          </div>
        </div>
      </section>
      <section id="workflow" className="landing-section landing-section-inset">
        <div className="landing-wrap">
          <div className="landing-section-heading"><h2>How Clam works</h2></div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {workflow.map(({ Icon, title, copy }) => <article key={title} className="bento-card rounded-2xl p-6">
              <Icon size={21} className="mb-3 text-emerald-matte" aria-hidden="true" />
              <h3 className="mb-2 text-base font-bold">{title}</h3>
              <p className="text-sm leading-relaxed text-ink-secondary">{copy}</p>
            </article>)}
          </div>
        </div>
      </section>
    </main>
  </div>;
}
