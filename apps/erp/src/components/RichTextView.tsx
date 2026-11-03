import type { CSSProperties } from 'react';
import { blockStyle, runStyle, type RichText } from '../lib/rich-text-model';

/** 202610200270: the texto rico of a document as React text (every character escaped; no HTML of the user is ever rendered). */
export function RichTextView({ value, className, label }: { value: RichText | null | undefined; className?: string; label?: string }) {
  if (!value) return null;
  return <div className={`rich-text-view${className ? ` ${className}` : ''}`} aria-label={label}>
    {value.blocks.map((block, index) => {
      const content = block.runs.length ? block.runs.map((run, i) => <span key={i} style={runStyle(run) as CSSProperties}>{run.text}</span>) : <br />;
      return block.code ? <pre key={index} style={blockStyle(block) as CSSProperties}>{content}</pre> : <p key={index} style={blockStyle(block) as CSSProperties}>{content}</p>;
    })}
  </div>;
}
