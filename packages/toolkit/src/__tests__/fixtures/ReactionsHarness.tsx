import React, { useState } from 'react';
import { AddReactionButton, ReactionChips, type ReactionGroup } from '../../components/Reactions';

const ME = { id: 'me', name: 'You' };

/**
 * Test harness for reactions: a message's groups held here, as an app would
 * hold them, with every add and remove recorded so a test can tell which one
 * a click called.
 */
export function ReactionsHarness({ initial, singleUser = false, readOnly = false }: {
  initial: ReactionGroup[];
  singleUser?: boolean;
  readOnly?: boolean;
}): React.JSX.Element {
  const [groups, setGroups] = useState(initial);
  const [calls, setCalls] = useState<string[]>([]);
  const onAdd = (emoji: string) => {
    setCalls((all) => [...all, `add ${emoji}`]);
    setGroups((all) => {
      const found = all.find((group) => group.emoji === emoji);
      if (!found) return [...all, { emoji, count: 1, reactedByMe: true, reactors: [ME] }];
      return all.map((group) => (group === found ? { ...group, count: group.count + 1, reactedByMe: true, reactors: [...group.reactors, ME] } : group));
    });
  };
  const onRemove = (emoji: string) => {
    setCalls((all) => [...all, `remove ${emoji}`]);
    setGroups((all) => all
      .map((group) => (group.emoji === emoji ? { ...group, count: group.count - 1, reactedByMe: false, reactors: group.reactors.filter((reactor) => reactor.id !== ME.id) } : group))
      .filter((group) => group.count > 0));
  };
  return (
    <div className="dark bg-zinc-950 p-6" style={{ width: 600, paddingTop: 200 }}>
      <ReactionChips reactions={groups} singleUser={singleUser} {...(readOnly ? {} : { onAdd, onRemove })} />
      <AddReactionButton reactions={groups} onAdd={onAdd} onRemove={onRemove} />
      <output data-testid="calls">{JSON.stringify(calls)}</output>
    </div>
  );
}
