import { useEffect, useState } from 'react';
import { errorText } from './saved-investigation-keys';
import { checkInvestigationSources } from './saved-investigation-sources';
import type { InvestigationRecord, SourceCheck } from './saved-investigation-types';

export function useSavedInvestigationSources(selected: InvestigationRecord | null) {
  const [sourceChecks, setSourceChecks] = useState<SourceCheck[] | null>(null);
  const [sourceCheckError, setSourceCheckError] = useState('');
  useEffect(() => {
    if (!selected?.sourceRefs.length) {
      setSourceChecks([]);
      setSourceCheckError('');
      return;
    }
    let active = true;
    setSourceChecks(null);
    setSourceCheckError('');
    async function check() {
      try {
        const checks = await checkInvestigationSources(selected!.sourceRefs);
        if (active) setSourceChecks(checks);
      } catch (reason) {
        if (active) {
          setSourceChecks([]);
          setSourceCheckError(errorText(reason));
        }
      }
    }
    void check();
    return () => { active = false; };
  }, [selected]);
  const changedSources = sourceChecks?.filter(check => check.state === 'changed' || check.state === 'missing') ?? [];
  const uncheckedSources = sourceChecks?.filter(check => check.state === 'unknown') ?? [];
  return { sourceChecks, sourceCheckError, changedSources, uncheckedSources };
}
