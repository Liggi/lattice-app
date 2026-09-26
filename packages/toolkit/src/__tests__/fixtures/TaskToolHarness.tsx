import React, { useState, useCallback } from 'react';
import { ToolkitProvider } from '../../context.js';
import { TaskTool } from '../../components/tools/TaskTool.js';
import type { ChatMessage } from '../../types.js';

function makeMessage(index: number): ChatMessage {
  return {
    id: `msg-${index}`,
    messageId: `msg-${index}`,
    type: 'assistant',
    content: `Child message ${index} — ${'content padding to add height '.repeat(3)}`,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Test harness for TaskTool scroll behavior.
 * Renders a TaskTool with a button to add children dynamically.
 */
export function ScrollHarness(): React.JSX.Element {
  const [children, setChildren] = useState<ChatMessage[]>(() =>
    Array.from({ length: 20 }, (_, i) => makeMessage(i)),
  );

  const addChild = useCallback(() => {
    setChildren(prev => [...prev, makeMessage(prev.length)]);
  }, []);

  return (
    <ToolkitProvider theme="dark">
      <div className="dark" style={{ width: 400 }}>
        <TaskTool
          input={{ description: 'Scroll test task', subagent_type: 'Explore' }}
          result=""
          toolUseId="scroll-test"
          childrenMessages={{ 'scroll-test': children }}
          isStreaming={true}
          renderChildMessage={(msg) => (
            <div data-testid={`child-${msg.messageId}`} className="py-2 text-xs text-zinc-400">
              {typeof msg.content === 'string' ? msg.content : '[block]'}
            </div>
          )}
        />
        <button data-testid="add-child" onClick={addChild}>Add child</button>
      </div>
    </ToolkitProvider>
  );
}

interface VisualHarnessProps {
  subagentType?: string;
  teamName?: string;
  agentName?: string;
  result?: string;
}

/**
 * Test harness for TaskTool visual identity.
 * Exposes subagent type, team name, and agent name as props.
 */
export function VisualHarness({
  subagentType,
  teamName,
  agentName,
  result = 'Task completed.',
}: VisualHarnessProps): React.JSX.Element {
  return (
    <ToolkitProvider theme="dark">
      <div className="dark" style={{ width: 400 }}>
        <TaskTool
          input={{
            description: 'Test task description',
            subagent_type: subagentType,
            team_name: teamName,
            name: agentName,
          }}
          result={result}
          toolUseId="visual-test"
        />
      </div>
    </ToolkitProvider>
  );
}

/**
 * Harness with a baked-in resolveAgentColor that always returns 'green'.
 * Playwright CT can't serialize function props, so this must be a separate component.
 */
export function TeamColorHarness(): React.JSX.Element {
  return (
    <ToolkitProvider theme="dark" resolveAgentColor={() => 'green'}>
      <div className="dark" style={{ width: 400 }}>
        <TaskTool
          input={{
            description: 'Test task description',
            subagent_type: 'Explore',
            team_name: 'backend-crew',
            name: 'Cache Agent',
          }}
          result="Task completed."
          toolUseId="color-test"
        />
      </div>
    </ToolkitProvider>
  );
}
