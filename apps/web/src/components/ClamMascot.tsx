'use client';

import React, { useState } from 'react';

export type ClamMascotState = 'armed' | 'allow' | 'blocked' | 'pending';

interface ClamMascotProps {
  state?: ClamMascotState;
  size?: number;
  interactive?: boolean;
  peek?: boolean;
  variant?: 'full' | 'glyph';
  className?: string;
}

const ANGLE_MAP: Record<ClamMascotState, number> = {
  armed: -11,
  allow: -22,
  blocked: 0,
  pending: -17,
};

export function ClamMascot({
  state = 'armed',
  size = 32,
  interactive = false,
  peek = false,
  variant = 'full',
  className = '',
}: ClamMascotProps) {
  const [hovered, setHovered] = useState(false);

  if (variant === 'glyph') {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 32 32"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className={className}
        aria-label="Clam brand mark"
      >
        <rect
          x="1"
          y="1"
          width="30"
          height="30"
          rx="7"
          fill="#141518"
          stroke="#2A2D35"
          strokeWidth="1.2"
        />
        <g transform="translate(3, 4)">
          <path
            d="M2.5 12.2C2.5 6.8 7.5 3.8 13 3.8C18.5 3.8 23.5 6.8 23.5 12.2H2.5Z"
            fill="#2E323B"
            stroke="#4B505C"
            strokeWidth="1.15"
            strokeLinejoin="round"
          />
          <path
            d="M8.5 4.8C7.8 7.6 7.5 10 7.5 11.8M13 4V11.8M17.5 4.8C18.2 7.6 18.5 10 18.5 11.8"
            stroke="#444A56"
            strokeWidth="1"
            strokeLinecap="round"
          />
          <rect x="3.5" y="12.1" width="19" height="2.4" rx="1.2" fill="#0D0E10" />
          <circle cx="15.5" cy="13.3" r="1.7" fill="#F0ECE3" />
          <path
            d="M3 14.7H23C22.2 18.3 18.2 20.5 13 20.5C7.8 20.5 3.8 18.3 3 14.7Z"
            fill="#23262E"
            stroke="#414652"
            strokeWidth="1.15"
            strokeLinejoin="round"
          />
        </g>
      </svg>
    );
  }

  const effectivePeek = (interactive && hovered) || peek;
  const lidAngle =
    state === 'blocked'
      ? 0
      : effectivePeek
        ? Math.min(ANGLE_MAP[state] - 8, -24)
        : ANGLE_MAP[state];

  const lidTransition =
    state === 'blocked'
      ? 'transform 150ms cubic-bezier(0.2, 0, 0, 1)'
      : 'transform 460ms cubic-bezier(0.34, 1.56, 0.64, 1)';

  const isAllow = state === 'allow';
  const isBlocked = state === 'blocked';
  const isPending = state === 'pending';
  const isArmed = state === 'armed';

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 96 96"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={`select-none ${interactive ? 'cursor-pointer' : ''} ${className}`}
      onMouseEnter={() => interactive && setHovered(true)}
      onMouseLeave={() => interactive && setHovered(false)}
      role="img"
      aria-label={`Clam firewall mascot (${state})`}
    >
      {/* Lower Matte Charcoal Shell Cup */}
      <path
        d="M11 50C12 63.5 26 73 48 73C70 73 84 63.5 85 50H11Z"
        fill="#262A32"
        stroke="#464B57"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      {/* Lower cup architectural curved ribs */}
      <path
        d="M21 56C25 63.5 31 68.5 36 71M35 57C37 64 40 69.5 43 72M52 57C52 64 51 69.5 50 72M68 56C65 63.5 60 68.5 56 71"
        stroke="#3A3F4B"
        strokeWidth="1.5"
        strokeLinecap="round"
      />

      {/* Warm Ivory Lower Mouth Rim / Basin */}
      <path
        d="M11 50C18 44.5 78 44.5 85 50C78 56.5 18 56.5 11 50Z"
        fill="#ECE6D8"
        stroke="#464B57"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />

      {/* Interior Pocket & Pearl (hidden when clamped shut) */}
      <g
        style={{
          opacity: isBlocked ? 0 : 1,
          transition: 'opacity 140ms ease-out',
        }}
      >
        {/* Armed dark recessed cavity vs Allow/Pending warm ivory inner shell */}
        {isArmed ? (
          <path
            d="M14 49C22 39 74 39 82 49C74 53 22 53 14 49Z"
            fill="#0D0E10"
          />
        ) : (
          <path
            d="M14 49C22 35 74 35 82 49C74 54 22 54 14 49Z"
            fill="#E5DEC9"
            opacity="0.95"
          />
        )}

        {/* Watchful / Happy / Upward Eyes */}
        {isArmed && (
          <g className="animate-clam-blink">
            <path
              d="M32 45.2C34 42.6 38.5 42.6 40.5 45.2C38.5 47.4 34 47.4 32 45.2Z"
              fill="#F0ECE3"
            />
            <circle cx="37.4" cy="45.1" r="1.7" fill="#111214" />
            <path
              d="M45.5 45.2C47.5 42.6 52 42.6 54 45.2C52 47.4 47.5 47.4 45.5 45.2Z"
              fill="#F0ECE3"
            />
            <circle cx="50.9" cy="45.1" r="1.7" fill="#111214" />
          </g>
        )}

        {isAllow && (
          <g>
            <path
              d="M34 38.5C35.2 35 39.2 35 40.4 38.5"
              stroke="#1E2127"
              strokeWidth="2.3"
              strokeLinecap="round"
            />
            <path
              d="M47.6 38.5C48.8 35 52.8 35 54 38.5"
              stroke="#1E2127"
              strokeWidth="2.3"
              strokeLinecap="round"
            />
          </g>
        )}

        {isPending && (
          <g>
            <circle cx="39" cy="40.5" r="3.4" fill="#F0ECE3" stroke="#1E2127" strokeWidth="1.5" />
            <circle cx="39.4" cy="39.1" r="1.5" fill="#1E2127" />
            <circle cx="51" cy="40.5" r="3.4" fill="#F0ECE3" stroke="#1E2127" strokeWidth="1.5" />
            <circle cx="51.4" cy="39.1" r="1.5" fill="#1E2127" />
          </g>
        )}

        {/* Pearl (Warm Ivory in Armed, Matte Emerald in Allow) */}
        {(isArmed || isAllow) && (
          <g>
            <circle
              cx="63"
              cy="47.5"
              r="5.6"
              fill={isAllow ? '#3E9E76' : '#F0ECE3'}
              stroke="#24272F"
              strokeWidth="1.5"
            />
            <circle
              cx="61.2"
              cy="45.8"
              r="1.5"
              fill={isAllow ? '#8CD4B4' : '#FFFFFF'}
              opacity="0.7"
            />
          </g>
        )}

        {/* Allow: Tiny crisp envelope on right rim */}
        {isAllow && (
          <g transform="translate(65, 29) rotate(-14)">
            <rect
              x="0"
              y="0"
              width="17"
              height="12"
              rx="2"
              fill="#F0ECE3"
              stroke="#1E2127"
              strokeWidth="1.5"
            />
            <path
              d="M1 1.5L8.5 7L16 1.5"
              stroke="#1E2127"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </g>
        )}

        {/* Pending (Ask First): Warm amber pause badge on right rim */}
        {isPending && (
          <g transform="translate(62, 36)" className="animate-clam-pending">
            <rect
              x="0"
              y="0"
              width="15"
              height="15"
              rx="5"
              fill="#D49A45"
              stroke="#1E2127"
              strokeWidth="1.6"
            />
            <rect x="5" y="4.2" width="1.8" height="6.6" rx="0.9" fill="#141518" />
            <rect x="8.5" y="4.2" width="1.8" height="6.6" rx="0.9" fill="#141518" />
          </g>
        )}
      </g>

      {/* Hinged Upper Ribbed Charcoal Shell Lid */}
      <g
        style={{
          transformOrigin: '13px 49px',
          transform: `rotate(${lidAngle}deg)`,
          transition: lidTransition,
        }}
      >
        {/* Warm ivory underside lip of upper shell */}
        <path
          d="M11 49.5C18 45.5 78 45.5 85 49.5C78 52.2 18 52.2 11 49.5Z"
          fill="#EBE5D8"
          stroke="#464B57"
          strokeWidth="1.5"
        />
        {/* Upper shell dome */}
        <path
          d="M11 48.5C13 31 28 22 48 22C68 22 83 31 85 48.5C74 44.8 22 44.8 11 48.5Z"
          fill="#2D313A"
          stroke="#4C525F"
          strokeWidth="2"
          strokeLinejoin="round"
        />
        {/* Curved architectural ridges */}
        <path
          d="M22 45C24 36 29 29 36 24.5M35 44.5C36.5 34.5 40 27.5 44 23M50 44.5C50 34.5 49 27.5 48 22.5M65 44.5C63.5 34.5 60 27.5 54 23.5M76 45.5C74 36 69 29.5 61 25.5"
          stroke="#434955"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
      </g>

      {/* Blocked State: Terracotta Padlock Clasp Sealing the Front Lip */}
      <g
        style={{
          opacity: isBlocked ? 1 : 0,
          transform: isBlocked ? 'translateY(0) scale(1)' : 'translateY(-3px) scale(0.86)',
          transformOrigin: '60px 54px',
          transition: 'opacity 140ms ease-out, transform 150ms cubic-bezier(0.2, 0, 0, 1)',
        }}
      >
        <path
          d="M55 48V44.5C55 41.8 57.2 39.8 60 39.8C62.8 39.8 65 41.8 65 44.5V48"
          stroke="#141518"
          strokeWidth="4"
          strokeLinecap="round"
        />
        <path
          d="M55 48V44.5C55 41.8 57.2 39.8 60 39.8C62.8 39.8 65 41.8 65 44.5V48"
          stroke="#9A9CA3"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
        <rect
          x="52"
          y="47.5"
          width="16"
          height="13"
          rx="2.5"
          fill="#C95D52"
          stroke="#141518"
          strokeWidth="1.8"
        />
        <circle cx="60" cy="52.8" r="1.5" fill="#141518" />
        <path d="M60 53.8V56.8" stroke="#141518" strokeWidth="1.6" strokeLinecap="round" />
      </g>
    </svg>
  );
}
