import Image from 'next/image';

export function SiftvaneMark({ size = 32, hero = false }: { size?: number; hero?: boolean }) {
  if (!hero) return <Image src="/icon.svg" width={size} height={size} alt="" unoptimized />;

  return <div className="siftvane-hero-mark" aria-hidden="true">
    <svg viewBox="0 0 256 200" fill="none">
      <circle cx="128" cy="100" r="91" stroke="currentColor" strokeOpacity=".18" />
      <circle cx="128" cy="100" r="74" stroke="currentColor" strokeOpacity=".26" strokeDasharray="2 6" />
      <path d="M13 76h32l19 19h24M17 119h36l19-19h18M166 100h24l21-21h33M168 106h19l19 19h31"
        stroke="currentColor" strokeOpacity=".55" strokeWidth="1.6" strokeLinejoin="round" />
      <circle cx="13" cy="76" r="3.5" fill="currentColor" />
      <circle cx="17" cy="119" r="3.5" fill="currentColor" />
      <circle cx="244" cy="79" r="3.5" fill="currentColor" />
      <circle cx="237" cy="125" r="3.5" fill="currentColor" />
    </svg>
    <Image src="/icon.svg" width={128} height={128} alt="" unoptimized priority />
  </div>;
}
