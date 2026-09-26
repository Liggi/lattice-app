import React, { useState } from 'react';
import { Circle, Clock, CheckCircle, ListTodo } from 'lucide-react';
import { parseTodos } from '../../utils/tool-utils.js';
import { CollapsibleToolCard } from '../CollapsibleToolCard.js';
import { tk, accent } from '../../tokens.js';

interface TodoToolProps {
  input: { todos?: Array<{ id?: string; content: string; status: string }> };
  result: string;
  isWrite: boolean;
}

function getTodoStatusIcon(status: string): React.JSX.Element {
  switch (status) {
    case 'completed':
      return <CheckCircle size={14} className="text-emerald-400/80 flex-shrink-0" />;
    case 'in_progress':
      return <Clock size={14} className="text-cyan-400/80 flex-shrink-0" />;
    default:
      return <Circle size={14} className={`${tk.text.muted} flex-shrink-0`} />;
  }
}

export function TodoTool({ input, result, isWrite }: TodoToolProps): React.JSX.Element {
  let todos: Array<{ id?: string; content: string; status: string }> = [];
  if (isWrite && input.todos && Array.isArray(input.todos)) {
    todos = input.todos;
  } else if (!isWrite && result) {
    todos = parseTodos(result);
  }

  const completedCount = todos.filter(t => t.status === 'completed').length;
  const inProgressCount = todos.filter(t => t.status === 'in_progress').length;
  const pendingCount = todos.filter(t => t.status === 'pending').length;

  const parts: string[] = [];
  if (completedCount > 0) parts.push(`${completedCount} done`);
  if (inProgressCount > 0) parts.push(`${inProgressCount} active`);
  if (pendingCount > 0) parts.push(`${pendingCount} pending`);
  const summaryText = parts.length > 0 ? parts.join(', ') : 'No items';

  const [isExpanded, setIsExpanded] = useState(() => todos.length > 0 && todos.length <= 8);

  return (
    <CollapsibleToolCard
      isExpanded={isExpanded}
      onExpandedChange={setIsExpanded}
      cardClassName={accent.indigo.card}
      canExpand={todos.length > 0}
      headerContent={(
        <>
          <div className="flex items-center gap-2">
            <ListTodo size={14} className={`${accent.indigo.icon} flex-shrink-0`} />
            <span className={`text-xs ${tk.text.muted}`}>{isWrite ? 'Todos' : 'Todo List'}</span>
          </div>
          <span className={`text-xs ${tk.text.secondary} truncate flex-1`}>{summaryText}</span>
          {todos.length > 0 && (
            <span className={`text-[10px] ${tk.text.faint}`}>{todos.length} items</span>
          )}
        </>
      )}
      content={todos.length > 0 ? (
        <div className={`border-t ${tk.separator} px-3 py-2.5 space-y-1.5`}>
          {todos.map((todo, index) => (
            <div key={todo.id || `todo-${index}`} className="flex items-start gap-2">
              <div className="mt-0.5">{getTodoStatusIcon(todo.status)}</div>
              <span className={`text-[13px] leading-relaxed ${
                todo.status === 'completed'
                  ? `line-through ${tk.text.faint}`
                  : tk.text.primary
              }`}>
                {todo.content}
              </span>
            </div>
          ))}
        </div>
      ) : undefined}
    />
  );
}
