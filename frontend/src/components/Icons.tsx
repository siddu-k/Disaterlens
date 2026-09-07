import React from 'react';

interface IconProps {
  size?: number;
  color?: string;
  className?: string;
  style?: React.CSSProperties;
}

// ─── Disaster Icons ──────────────────────────────────────────────
export const IconFlood: React.FC<IconProps> = ({ size = 16, color = 'currentColor', className, style }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} style={style}>
    <path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z" fill={color} fillOpacity="0.2" />
    <path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z" />
  </svg>
);

export const IconCyclone: React.FC<IconProps> = ({ size = 16, color = 'currentColor', className, style }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} style={style}>
    <path d="M12.5 8a4.5 4.5 0 0 0-4.5 4.5 4.5 4.5 0 0 0 4.5 4.5 4.5 4.5 0 0 0 4.5-4.5" />
    <path d="M4 12a8 8 0 0 1 14.5-4.5" />
    <path d="M20 12a8 8 0 0 1-14.5 4.5" />
  </svg>
);

export const IconHeatwave: React.FC<IconProps> = ({ size = 16, color = 'currentColor', className, style }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} style={style}>
    <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z" fill={color} fillOpacity="0.2" />
  </svg>
);

export const IconEarthquake: React.FC<IconProps> = ({ size = 16, color = 'currentColor', className, style }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} style={style}>
    <path d="M2 12h4l3-8 4 16 3-8h6" />
  </svg>
);

export const IconLandslide: React.FC<IconProps> = ({ size = 16, color = 'currentColor', className, style }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} style={style}>
    <path d="m8 3 4 8 5-5 5 15H2L8 3z" fill={color} fillOpacity="0.2" />
    <path d="M4 14l3-2 3 3" />
    <path d="M14 17l2-2 3 3" />
  </svg>
);

// ─── Metrics & Analysis Icons ────────────────────────────────────
export const IconLocationPin: React.FC<IconProps> = ({ size = 16, color = 'currentColor', className, style }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} style={style}>
    <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" fill={color} fillOpacity="0.15" />
    <circle cx="12" cy="10" r="3" fill={color} />
  </svg>
);

export const IconSearch: React.FC<IconProps> = ({ size = 16, color = 'currentColor', className, style }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} style={style}>
    <circle cx="11" cy="11" r="8" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
  </svg>
);

export const IconPopulation: React.FC<IconProps> = ({ size = 16, color = 'currentColor', className, style }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} style={style}>
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </svg>
);

export const IconBuilding: React.FC<IconProps> = ({ size = 16, color = 'currentColor', className, style }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} style={style}>
    <rect x="4" y="2" width="16" height="20" rx="2" ry="2" />
    <line x1="9" y1="6" x2="9.01" y2="6" strokeWidth="2.5" />
    <line x1="15" y1="6" x2="15.01" y2="6" strokeWidth="2.5" />
    <line x1="9" y1="10" x2="9.01" y2="10" strokeWidth="2.5" />
    <line x1="15" y1="10" x2="15.01" y2="10" strokeWidth="2.5" />
    <line x1="9" y1="14" x2="9.01" y2="14" strokeWidth="2.5" />
    <line x1="15" y1="14" x2="15.01" y2="14" strokeWidth="2.5" />
    <line x1="9" y1="18" x2="15" y2="18" />
  </svg>
);

export const IconRoad: React.FC<IconProps> = ({ size = 16, color = 'currentColor', className, style }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} style={style}>
    <path d="M4 19L8 5" />
    <path d="M20 19L16 5" />
    <line x1="12" y1="5" x2="12" y2="8" />
    <line x1="12" y1="11" x2="12" y2="14" />
    <line x1="12" y1="17" x2="12" y2="20" />
  </svg>
);

export const IconAlertTriangle: React.FC<IconProps> = ({ size = 16, color = 'currentColor', className, style }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} style={style}>
    <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" fill={color} fillOpacity="0.15" />
    <line x1="12" y1="9" x2="12" y2="13" />
    <line x1="12" y1="17" x2="12.01" y2="17" strokeWidth="2.5" />
  </svg>
);

// ─── Facility Category Icons ─────────────────────────────────────
export const IconPolice: React.FC<IconProps> = ({ size = 16, color = 'currentColor', className, style }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} style={style}>
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" fill={color} fillOpacity="0.15" />
    <circle cx="12" cy="11" r="3" />
  </svg>
);

export const IconHospital: React.FC<IconProps> = ({ size = 16, color = 'currentColor', className, style }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} style={style}>
    <path d="M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z" fill={color} fillOpacity="0.12" />
    <line x1="12" y1="8" x2="12" y2="16" strokeWidth="2.4" />
    <line x1="8" y1="12" x2="16" y2="12" strokeWidth="2.4" />
  </svg>
);

export const IconShelter: React.FC<IconProps> = ({ size = 16, color = 'currentColor', className, style }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} style={style}>
    <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" fill={color} fillOpacity="0.15" />
    <polyline points="9 22 9 12 15 12 15 22" />
  </svg>
);

export const IconFireStation: React.FC<IconProps> = ({ size = 16, color = 'currentColor', className, style }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} style={style}>
    <rect x="2" y="7" width="20" height="14" rx="2" />
    <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
    <circle cx="12" cy="12" r="2" />
  </svg>
);

export const IconSchool: React.FC<IconProps> = ({ size = 16, color = 'currentColor', className, style }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} style={style}>
    <path d="M22 10v6M2 10l10-5 10 5-10 5z" />
    <path d="M6 12v5c3 3 9 3 12 0v-5" />
  </svg>
);

export const IconMedicalCross: React.FC<IconProps> = ({ size = 16, color = 'currentColor', className, style }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={className} style={style}>
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

// ─── General UI Icons ────────────────────────────────────────────
export const IconInsight: React.FC<IconProps> = ({ size = 16, color = 'currentColor', className, style }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} style={style}>
    <path d="M9 18h6" />
    <path d="M10 22h4" />
    <path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 0 1 8.91 14" fill={color} fillOpacity="0.15" />
  </svg>
);

export const IconGlobe: React.FC<IconProps> = ({ size = 16, color = 'currentColor', className, style }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} style={style}>
    <circle cx="12" cy="12" r="10" />
    <line x1="2" y1="12" x2="22" y2="12" />
    <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
  </svg>
);

export const IconPlay: React.FC<IconProps> = ({ size = 14, color = 'currentColor', className, style }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={color} stroke="none" className={className} style={style}>
    <polygon points="5 3 19 12 5 21 5 3" />
  </svg>
);

export const IconPause: React.FC<IconProps> = ({ size = 14, color = 'currentColor', className, style }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={color} stroke="none" className={className} style={style}>
    <rect x="6" y="4" width="4" height="16" rx="1" />
    <rect x="14" y="4" width="4" height="16" rx="1" />
  </svg>
);

export const IconTag: React.FC<IconProps> = ({ size = 16, color = 'currentColor', className, style }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} style={style}>
    <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
    <line x1="7" y1="7" x2="7.01" y2="7" strokeWidth="2.5" />
  </svg>
);

export const IconPencil: React.FC<IconProps> = ({ size = 16, color = 'currentColor', className, style }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} style={style}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
  </svg>
);
