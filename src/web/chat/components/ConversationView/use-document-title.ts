import { useEffect } from 'react';

export function useDocumentTitle(params: {
  conversationSummary: { customName?: string | null } | null;
  insights?: { context?: { mission?: string } | null; purpose?: string | null } | null;
  conversationTitle: string;
}): void {
  const { conversationSummary, insights, conversationTitle } = params;

  useEffect(() => {
    // Priority: custom name > mission > purpose > default
    const title = conversationSummary?.customName
      || insights?.context?.mission
      || insights?.purpose
      || (conversationTitle !== 'Conversation' ? conversationTitle : null);

    if (title) {
      const truncated = title.length > 50 ? `${title.slice(0, 47)}...` : title;
      document.title = `Lattice · ${truncated}`;
    } else {
      document.title = 'Lattice';
    }

    return () => {
      document.title = 'Lattice';
    };
  }, [conversationTitle, conversationSummary, insights]);
}
