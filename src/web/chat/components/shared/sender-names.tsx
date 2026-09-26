import React, { createContext, useContext, useMemo } from 'react';

/** What a sending session can be called, from `GET /api/conv/:id/workers`. */
export interface SenderIdentity {
  name: string;
  role: 'worker' | 'coordinator';
}

/**
 * What the sessions that have written to this conversation can be called. The
 * id remains the identity; a sender the server could not name is absent here
 * and keeps its id on screen rather than being given a name it does not have.
 */
const SenderNamesContext = createContext<Readonly<Record<string, SenderIdentity>>>({});

export interface SenderNamesProviderProps {
  senders: Readonly<Record<string, SenderIdentity>>;
  children: React.ReactNode;
}

export function SenderNamesProvider({ senders, children }: SenderNamesProviderProps): JSX.Element {
  const value = useMemo(() => senders, [senders]);
  return <SenderNamesContext.Provider value={value}>{children}</SenderNamesContext.Provider>;
}

/** Every sender this conversation can name, for a list that resolves several. */
export function useSenderIdentities(): Readonly<Record<string, SenderIdentity>> {
  return useContext(SenderNamesContext);
}

/** What one sender can be called, or null when nothing names it. */
export function useSenderIdentity(sender: string | null | undefined): SenderIdentity | null {
  const senders = useContext(SenderNamesContext);
  if (!sender) return null;
  return senders[sender] ?? null;
}
