import type { JevPassage, JevWorkspaceState } from '../shared/jev-types';
export type JevEvidenceNavigation = (evidence: JevPassage) => void;
export type JevViewState = JevWorkspaceState & { hasApiKey: boolean; canApprove: boolean; canConfigure: boolean; summary?: boolean };
