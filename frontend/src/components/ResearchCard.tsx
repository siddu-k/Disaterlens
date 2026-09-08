import { useState } from 'react';
import { RESEARCH_CONTENT } from '../content';
import { IconLightbulb } from './Icons';

export default function ResearchCard({
  open: openProp,
  setOpen: setOpenProp,
}: {
  open?: boolean;
  setOpen?: (v: boolean) => void;
} = {}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = openProp ?? internalOpen;
  const setOpen = (v: boolean | ((prev: boolean) => boolean)) => {
    const next = typeof v === 'function' ? (v as (prev: boolean) => boolean)(open) : v;
    if (setOpenProp) setOpenProp(next);
    else setInternalOpen(next);
  };
  return (
    <div className="modern-ai-insight-card" id="research-card">
      <div className="ai-insight-title-row">
        <div className="ai-insight-header-left">
          <span className="ai-insight-symbol"><IconLightbulb size={14} /></span>
          <span className="ai-insight-label">{RESEARCH_CONTENT.title}</span>
        </div>
        <button
          className="facilities-view-all-btn"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={open ? 'Collapse research card' : 'Expand research card'}
        >
          {open ? 'Hide' : 'Show'}
        </button>
      </div>
      {open && (
        <div className="ai-insight-content">
          {RESEARCH_CONTENT.body.map((para, idx) => (
            <p key={idx} style={{ marginBottom: 6 }}>{para}</p>
          ))}
          <ul style={{ paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {RESEARCH_CONTENT.bullets.map((b, idx) => (
              <li key={idx}>{b}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
