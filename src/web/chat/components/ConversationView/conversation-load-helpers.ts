import type { MutableRefObject } from 'react';
import type { ConversationDetailsResponse, NextStepProposal } from '@/web/chat/types';

export function maybeApplyProposedNextStepsFromConversationDetails(params: {
  conversationDetails: ConversationDetailsResponse;
  currentProposedNextSteps: NextStepProposal[] | null;
  isSessionIdle: boolean;
  isDismissedThisSession: boolean;
  setProposedNextSteps: (nextSteps: NextStepProposal[]) => void;
}): void {
  const proposed = params.conversationDetails.proposedNextSteps;
  if (!proposed || proposed.length === 0) {
    return;
  }
  if (params.currentProposedNextSteps || !params.isSessionIdle || params.isDismissedThisSession) {
    return;
  }

  params.setProposedNextSteps(proposed);
}

export function maybeFocusComposerOnInitialConversationLoad(params: {
  hasInitiallyFocusedRef: MutableRefObject<boolean>;
  composerRef: MutableRefObject<{ focusInput: () => void } | null>;
}): void {
  if (params.hasInitiallyFocusedRef.current) {
    return;
  }

  params.hasInitiallyFocusedRef.current = true;
  setTimeout(() => params.composerRef.current?.focusInput(), 100);
}
