import type { ReactNode } from 'react';

// Profile pictures: simple characters in white with dark features, drawn on the profile's colour.
// Each is a 64×64 picture; the circle behind it is the avatar itself.

const W = '#ffffff';
const D = '#141414';

export const AVATAR_ART: Record<string, { label: string; art: ReactNode }> = {
  cat: {
    label: 'Cat',
    art: (
      <>
        <path d="M15 22 L19 8 L28 17 Z M49 22 L45 8 L36 17 Z" fill={W} stroke={W} strokeWidth="2" strokeLinejoin="round" />
        <ellipse cx="32" cy="34" rx="19" ry="17" fill={W} />
        <ellipse cx="25" cy="32" rx="2.6" ry="3.6" fill={D} />
        <ellipse cx="39" cy="32" rx="2.6" ry="3.6" fill={D} />
        <path d="M30 38 L34 38 L32 40.5 Z" fill={D} />
        <path d="M32 40.5 Q29 44 26 42 M32 40.5 Q35 44 38 42" fill="none" stroke={D} strokeWidth="1.6" strokeLinecap="round" />
      </>
    )
  },
  bear: {
    label: 'Bear',
    art: (
      <>
        <circle cx="18" cy="19" r="7" fill={W} />
        <circle cx="46" cy="19" r="7" fill={W} />
        <circle cx="32" cy="34" r="18" fill={W} />
        <circle cx="25" cy="30" r="2.4" fill={D} />
        <circle cx="39" cy="30" r="2.4" fill={D} />
        <ellipse cx="32" cy="40" rx="7.5" ry="5.5" fill={D} opacity="0.12" />
        <ellipse cx="32" cy="37.5" rx="3.2" ry="2.3" fill={D} />
        <path d="M32 40 L32 43 M29 44 Q32 46 35 44" fill="none" stroke={D} strokeWidth="1.6" strokeLinecap="round" />
      </>
    )
  },
  panda: {
    label: 'Panda',
    art: (
      <>
        <circle cx="18" cy="18" r="7" fill={D} />
        <circle cx="46" cy="18" r="7" fill={D} />
        <circle cx="32" cy="34" r="18" fill={W} />
        <ellipse cx="24.5" cy="32" rx="5" ry="6.5" fill={D} transform="rotate(-20 24.5 32)" />
        <ellipse cx="39.5" cy="32" rx="5" ry="6.5" fill={D} transform="rotate(20 39.5 32)" />
        <circle cx="25" cy="31" r="1.6" fill={W} />
        <circle cx="39" cy="31" r="1.6" fill={W} />
        <ellipse cx="32" cy="40" rx="2.8" ry="2" fill={D} />
      </>
    )
  },
  bunny: {
    label: 'Bunny',
    art: (
      <>
        <ellipse cx="24" cy="15" rx="5" ry="13" fill={W} transform="rotate(-8 24 15)" />
        <ellipse cx="40" cy="15" rx="5" ry="13" fill={W} transform="rotate(8 40 15)" />
        <circle cx="32" cy="38" r="16" fill={W} />
        <circle cx="26" cy="36" r="2.3" fill={D} />
        <circle cx="38" cy="36" r="2.3" fill={D} />
        <path d="M30.5 41 L33.5 41 L32 43 Z" fill={D} />
        <path d="M30 45.5 L30 48 M34 45.5 L34 48" stroke={D} strokeWidth="1.6" strokeLinecap="round" />
      </>
    )
  },
  owl: {
    label: 'Owl',
    art: (
      <>
        <path d="M14 18 L22 24 M50 18 L42 24" stroke={W} strokeWidth="4" strokeLinecap="round" />
        <ellipse cx="32" cy="35" rx="18" ry="19" fill={W} />
        <circle cx="24.5" cy="31" r="7" fill="none" stroke={D} strokeWidth="2.4" />
        <circle cx="39.5" cy="31" r="7" fill="none" stroke={D} strokeWidth="2.4" />
        <circle cx="24.5" cy="31" r="2.6" fill={D} />
        <circle cx="39.5" cy="31" r="2.6" fill={D} />
        <path d="M29.5 38 L34.5 38 L32 42.5 Z" fill={D} />
      </>
    )
  },
  frog: {
    label: 'Frog',
    art: (
      <>
        <circle cx="21" cy="21" r="8" fill={W} />
        <circle cx="43" cy="21" r="8" fill={W} />
        <ellipse cx="32" cy="38" rx="21" ry="15" fill={W} />
        <circle cx="21" cy="21" r="3.2" fill={D} />
        <circle cx="43" cy="21" r="3.2" fill={D} />
        <path d="M20 40 Q32 50 44 40" fill="none" stroke={D} strokeWidth="2.4" strokeLinecap="round" />
      </>
    )
  },
  ghost: {
    label: 'Ghost',
    art: (
      <>
        <path d="M16 50 L16 30 A16 16 0 0 1 48 30 L48 50 L42.5 45.5 L37 50 L32 45.5 L27 50 L21.5 45.5 Z" fill={W} stroke={W} strokeWidth="1.5" strokeLinejoin="round" />
        <ellipse cx="26" cy="30" rx="2.8" ry="4" fill={D} />
        <ellipse cx="38" cy="30" rx="2.8" ry="4" fill={D} />
        <ellipse cx="32" cy="38.5" rx="3" ry="2.4" fill={D} />
      </>
    )
  },
  robot: {
    label: 'Robot',
    art: (
      <>
        <path d="M32 11 L32 17" stroke={W} strokeWidth="2.5" strokeLinecap="round" />
        <circle cx="32" cy="10" r="3" fill={W} />
        <rect x="14" y="18" width="36" height="30" rx="9" fill={W} />
        <rect x="10" y="28" width="4" height="10" rx="2" fill={W} />
        <rect x="50" y="28" width="4" height="10" rx="2" fill={W} />
        <rect x="21" y="27" width="7" height="7" rx="2" fill={D} />
        <rect x="36" y="27" width="7" height="7" rx="2" fill={D} />
        <rect x="24" y="39" width="16" height="3.5" rx="1.75" fill={D} />
      </>
    )
  },
  alien: {
    label: 'Alien',
    art: (
      <>
        <path d="M32 12 C47 12 52 24 50 33 C48 43 39 53 32 53 C25 53 16 43 14 33 C12 24 17 12 32 12 Z" fill={W} />
        <ellipse cx="24" cy="33" rx="6" ry="3.6" fill={D} transform="rotate(30 24 33)" />
        <ellipse cx="40" cy="33" rx="6" ry="3.6" fill={D} transform="rotate(-30 40 33)" />
        <path d="M29 45 Q32 47 35 45" fill="none" stroke={D} strokeWidth="1.8" strokeLinecap="round" />
      </>
    )
  },
  astronaut: {
    label: 'Astronaut',
    art: (
      <>
        <circle cx="32" cy="32" r="19" fill={W} />
        <rect x="18" y="23" width="28" height="18" rx="9" fill={D} />
        <path d="M23 29 Q27 26 31 27" fill="none" stroke={W} strokeWidth="2" strokeLinecap="round" opacity="0.7" />
        <circle cx="13.5" cy="32" r="3" fill={W} />
        <circle cx="50.5" cy="32" r="3" fill={W} />
      </>
    )
  },
  popcorn: {
    label: 'Popcorn',
    art: (
      <>
        <circle cx="22" cy="21" r="6" fill={W} />
        <circle cx="31" cy="16" r="7" fill={W} />
        <circle cx="41" cy="20" r="6" fill={W} />
        <circle cx="27" cy="24" r="5" fill={W} />
        <circle cx="37" cy="24" r="5" fill={W} />
        <path d="M17 26 L47 26 L43 52 L21 52 Z" fill={W} />
        <path d="M24.5 27 L26.5 51 M32 27 L32 51 M39.5 27 L37.5 51" stroke={D} strokeWidth="3" />
      </>
    )
  },
  clapper: {
    label: 'Clapperboard',
    art: (
      <>
        <rect x="14" y="27" width="36" height="24" rx="4" fill={W} />
        <g transform="rotate(-14 14 25)">
          <rect x="14" y="17" width="36" height="8" rx="2" fill={W} />
          <path d="M21 17 L17 25 M30 17 L26 25 M39 17 L35 25 M48 17 L44 25" stroke={D} strokeWidth="3" />
        </g>
        <path d="M14 33 L50 33" stroke={D} strokeWidth="2" />
        <path d="M28 38 L28 47 L36 42.5 Z" fill={D} />
      </>
    )
  }
};
