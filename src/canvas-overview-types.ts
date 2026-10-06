import type { CanvasBlock } from '../shared/types';

export type OverviewGroup = {
  id: string;
  group: string;
  title: string;
  count: number;
  tone: number;
  depth: number;
  topTitles: string[];
};

export type CanvasOverviewProps = {
  groups: OverviewGroup[];
  blocks: CanvasBlock[];
  searchIds: Set<string>;
  matchCount: number;
  overview: boolean;
  drill: boolean;
  onFocus: (group: string) => void;
};

export type CanvasDrillBoardProps = {
  group: string;
  groups: OverviewGroup[];
  blocks: CanvasBlock[];
  onFocus: (group: string) => void;
  onSelect: (blockId: string) => void;
};
