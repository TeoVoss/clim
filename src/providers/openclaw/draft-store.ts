/**
 * In-memory draft store for 批奏折 (shadow.draft.create).
 *
 * Drafts are created by the Agent via node invoke, and approved/rejected/edited
 * by the user via CLI commands. Approved drafts are sent as Matrix messages to
 * the target room.
 */

export type DraftStatus = 'pending' | 'approved' | 'rejected' | 'edited';

export interface Draft {
  id: number;
  targetRoomId: string;
  targetRoomName: string;
  draftBody: string;
  createdAt: number; // ms timestamp
  status: DraftStatus;
}

export class DraftStore {
  private drafts = new Map<number, Draft>();
  private nextId = 1;
  private listeners: Array<(draft: Draft) => void> = [];

  create(params: { targetRoomId: string; targetRoomName: string; draftBody: string }): Draft {
    const draft: Draft = {
      id: this.nextId++,
      targetRoomId: params.targetRoomId,
      targetRoomName: params.targetRoomName,
      draftBody: params.draftBody,
      createdAt: Date.now(),
      status: 'pending',
    };
    this.drafts.set(draft.id, draft);

    for (const listener of this.listeners) {
      listener(draft);
    }

    return draft;
  }

  get(id: number): Draft | undefined {
    return this.drafts.get(id);
  }

  list(status?: DraftStatus): Draft[] {
    const all = [...this.drafts.values()];
    if (status) {
      return all.filter((d) => d.status === status);
    }
    return all;
  }

  approve(id: number): Draft | undefined {
    const draft = this.drafts.get(id);
    if (!draft || (draft.status !== 'pending' && draft.status !== 'edited')) return undefined;
    draft.status = 'approved';
    return draft;
  }

  reject(id: number): Draft | undefined {
    const draft = this.drafts.get(id);
    if (!draft || (draft.status !== 'pending' && draft.status !== 'edited')) return undefined;
    draft.status = 'rejected';
    return draft;
  }

  editBody(id: number, newBody: string): Draft | undefined {
    const draft = this.drafts.get(id);
    if (!draft || draft.status !== 'pending') return undefined;
    draft.draftBody = newBody;
    draft.status = 'edited'; // marks as edited, still actionable
    return draft;
  }

  /** Listen for new drafts (used to broadcast via IPC). */
  onDraft(listener: (draft: Draft) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }
}
