import { useEffect } from 'react';
import type { CanvasBlock, CanvasDocument } from '../shared/types';
import { api } from './api';
import type { CanvasEdit } from './canvas-changes';
import { errorText } from './chat-turn-state';
import type { AIElementsChatProps, DisplayTurn } from './chat-types';
import { type ChatProposal, type ChatProposalReceipt, type ChatProposalUndoReceipt } from './chatStream';

import type { ChatState } from './chat-state';
export function useChatProposals(props: AIElementsChatProps, state: ChatState) {
  const { onCanvasChanged, onUndoCreatedBlock, onUndoEditedBlock } = props;
  const { undoingBlockId, setUndoingBlockId, turnsRef, commit } = state;
  useEffect(() => {
    let active = true;
    for (const turn of turnsRef.current.filter(item => item.proposal && item.proposalState !== 'reverted' && item.proposalState !== 'expired')) {
      void api<ChatProposal | ChatProposalReceipt>(`/chat/proposals/${encodeURIComponent(turn.proposal!.id)}`).then(result => {
        if (!active) return;
        commit(turnsRef.current.map(item => item.id !== turn.id ? item : result.status === 'pending'
          ? { ...item, proposal: result, selectedProposalIds: recoveredSelection(item, result), proposalState: 'pending' }
          : { ...item, proposalReceipt: result, proposalState: result.applied.length ? 'applied' : 'failed' }));
      }).catch(failure => {
        if (!active) return;
        commit(turnsRef.current.map(item => item.id === turn.id ? { ...item, proposalState: 'expired', proposalError: errorText(failure) } : item));
      });
    }
    return () => { active = false; };
  }, []);
  async function undoCreated(turnId: number, block: CanvasBlock) {
    const turn = turnsRef.current.find(item => item.id === turnId);
    if (!turn?.createdCanvasId || undoingBlockId) return;
    setUndoingBlockId(block.id);
    try {
      await onUndoCreatedBlock(turn.createdCanvasId, block);
      commit(turnsRef.current.map(item => item.id === turnId ? {
        ...item,
        createdBlocks: item.createdBlocks?.filter(created => created.id !== block.id), undoMessage: `Undid creation of ${block.title}.`, undoError: ''
      } : item));
    } catch (failure) {
      commit(turnsRef.current.map(item => item.id === turnId ? { ...item, undoError: errorText(failure) } : item));
    } finally { setUndoingBlockId(null); }
  }
  async function undoEdited(turnId: number, edit: CanvasEdit) {
    const turn = turnsRef.current.find(item => item.id === turnId);
    if (!turn?.createdCanvasId || undoingBlockId) return;
    setUndoingBlockId(edit.after.id);
    try {
      await onUndoEditedBlock(turn.createdCanvasId, edit);
      commit(turnsRef.current.map(item => item.id === turnId ? {
        ...item,
        editedBlocks: item.editedBlocks?.filter(updated => updated.after.id !== edit.after.id),
        undoMessage: `Undid edit to ${edit.after.title}.`, undoError: ''
      } : item));
    } catch (failure) {
      commit(turnsRef.current.map(item => item.id === turnId ? { ...item, undoError: errorText(failure) } : item));
    } finally { setUndoingBlockId(null); }
  }
  function selectProposal(turnId: number, changeId: string, selected: boolean) {
    commit(turnsRef.current.map(turn => turn.id === turnId && turn.proposal?.changes.some(change => change.id === changeId && change.canApply !== false) ? {
      ...turn,
      selectedProposalIds: selected ? [...new Set([...(turn.selectedProposalIds ?? []), changeId])]
        : (turn.selectedProposalIds ?? []).filter(id => id !== changeId)
    } : turn));
  }
  async function applyProposal(turnId: number) {
    const turn = turnsRef.current.find(item => item.id === turnId);
    const proposal = turn?.proposal;
    if (!proposal || turn.proposalState !== 'pending' || !turn.selectedProposalIds?.length) return;
    commit(turnsRef.current.map(item => item.id === turnId ? { ...item, proposalState: 'applying', proposalError: '' } : item));
    try {
      const before = await api<CanvasDocument>(`/canvases/${encodeURIComponent(proposal.canvasId)}`);
      const receipt = await api<ChatProposalReceipt>(`/chat/proposals/${encodeURIComponent(proposal.id)}/apply`, {
        method: 'POST', body: JSON.stringify({ changeIds: turn.selectedProposalIds }),
      });
      commit(turnsRef.current.map(item => item.id === turnId ? {
        ...item, proposalState: receipt.applied.length ? 'applied' : 'failed', proposalReceipt: receipt,
        proposalError: ''
      } : item));
      try { await onCanvasChanged(proposal.canvasId, before.blocks); }
      catch (failure) {
        commit(turnsRef.current.map(item => item.id === turnId ? {
          ...item,
          proposalError: `Changes saved, but the canvas could not refresh: ${errorText(failure)} Reopen the canvas to see them.`
        } : item));
      }
    } catch (failure) {
      const message = errorText(failure);
      commit(turnsRef.current.map(item => item.id === turnId ? {
        ...item,
        proposalState: message.includes('no longer available') ? 'expired' : 'pending', proposalError: message
      } : item));
    }
  }
  async function undoProposal(turnId: number) {
    const turn = turnsRef.current.find(item => item.id === turnId);
    if (!turn?.proposal || turn.proposalState !== 'applied') return;
    commit(turnsRef.current.map(item => item.id === turnId ? { ...item, proposalState: 'applying', proposalError: '' } : item));
    try {
      const before = await api<CanvasDocument>(`/canvases/${encodeURIComponent(turn.proposal.canvasId)}`);
      const receipt = await api<ChatProposalUndoReceipt>(`/chat/proposals/${encodeURIComponent(turn.proposal.id)}/undo`, { method: 'POST', body: JSON.stringify({}) });
      commit(turnsRef.current.map(item => item.id === turnId ? { ...item, proposalState: receipt.status === 'reverted' ? 'reverted' : 'applied', proposalUndoReceipt: receipt } : item));
      try { await onCanvasChanged(turn.proposal.canvasId, before.blocks); }
      catch (failure) {
        commit(turnsRef.current.map(item => item.id === turnId ? {
          ...item,
          proposalError: `Undo saved, but the canvas could not refresh: ${errorText(failure)} Reopen the canvas to see it.`
        } : item));
      }
    } catch (failure) {
      const message = errorText(failure);
      commit(turnsRef.current.map(item => item.id === turnId ? {
        ...item,
        proposalState: message.includes('no longer available') ? 'expired' : 'applied', proposalError: message
      } : item));
    }
  }
  return { undoCreated, undoEdited, selectProposal, applyProposal, undoProposal };
}

function recoveredSelection(turn: DisplayTurn, proposal: ChatProposal) {
  const allowed = new Set(proposal.changes.filter(change => change.canApply !== false).map(change => change.id));
  return (turn.selectedProposalIds ?? [...allowed]).filter(id => allowed.has(id));
}
