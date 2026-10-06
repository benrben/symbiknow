import type { ReactNode } from 'react';
import type { SectionId } from './settings-page-types';

export function Section({ id, title, description, children }: { id: SectionId; title: string; description: string; children: ReactNode }) {
  return <section className="settings-page__section" id={`settings-${id}`} data-section={id} aria-labelledby={`settings-${id}-title`}>
    <div className="settings-page__section-heading"><h3 id={`settings-${id}-title`}>{title}</h3><p>{description}</p></div>
    {children}
  </section>;
}
