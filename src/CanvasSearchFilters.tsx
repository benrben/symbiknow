import type { SearchFilters, SearchFilterOptions } from './canvas-search-types';

type Props = {
  filters: SearchFilters;
  choices: SearchFilterOptions;
  onChange: (key: keyof SearchFilters, value: string) => void;
};

function SearchFilter({ label, filterKey, filters, choices, onChange }: Props & { label: string; filterKey: keyof SearchFilters }) {
  return <label>{label}<select aria-label={`Filter by ${label.toLowerCase()}`} value={filters[filterKey]} onChange={event => onChange(filterKey, event.target.value)}>
    <option value="all">All</option>
    {choices[filterKey].map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
  </select></label>;
}

export function CanvasSearchFilters(props: Props) {
  return <div className="canvas-search__filters" aria-label="Filter search results">
    <SearchFilter {...props} label="Canvas" filterKey="canvas"/>
    <SearchFilter {...props} label="Group" filterKey="group"/>
    <SearchFilter {...props} label="Tag" filterKey="tag"/>
    <SearchFilter {...props} label="Type" filterKey="kind"/>
  </div>;
}
