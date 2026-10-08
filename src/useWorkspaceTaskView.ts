import { useSyncExternalStore } from 'react';

function subscribe(onChange: () => void) {
  window.addEventListener('popstate', onChange);
  return () => window.removeEventListener('popstate', onChange);
}

function taskView() {
  return new URLSearchParams(window.location.search).get('view') === 'todos';
}

function setTaskView(tasks: boolean) {
  const url = new URL(window.location.href);
  url.searchParams.delete('doc');
  if (tasks) url.searchParams.set('view', 'todos');
  else url.searchParams.delete('view');
  window.history.pushState(null, '', `${url.pathname}${url.search}${url.hash}`);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function useWorkspaceTaskView() {
  return [useSyncExternalStore(subscribe, taskView), setTaskView] as const;
}
