export type RootGroup = { group: string; title: string; count: number; tone: number };

export type Supergroup = {
  id: string;
  title: string;
  rootGroups: string[];
  count: number;
  topTitles: string[];
  tone: number;
};

export type HierarchyConnections = {
  weight: (left: string, right: string) => number;
  degree: (group: string) => number;
};
